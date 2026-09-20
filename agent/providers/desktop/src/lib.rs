#![forbid(unsafe_code)]

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tether_core::{
    CapabilityError, CapabilityProvider, ErrorCode, InvocationEnvelope, ProviderResult,
    ResourceKey, ResourceOrigin, TrustedOwnershipRegistry, VerificationStatus,
};

mod human_activity;
mod private_clipboard;
#[cfg(windows)]
mod windows_human_activity;
#[cfg(windows)]
mod windows_uia;

pub use human_activity::{
    ForegroundWindowIdentity, HumanActivityMonitor, HumanActivitySnapshot, require_human_idle,
};
pub use private_clipboard::{PrivateClipboard, PrivateClipboardState};
#[cfg(windows)]
pub use windows_human_activity::WindowsHumanActivityMonitor;
#[cfg(windows)]
pub use windows_uia::WindowsUiaBackend;

const DEFAULT_MAX_NODES: usize = 200;
const MAX_NODES: usize = 1_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopPattern {
    Invoke,
    Value,
    Selection,
    Toggle,
    ExpandCollapse,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DesktopRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct DesktopNode {
    pub reference: String,
    pub parent_reference: Option<String>,
    pub role: String,
    pub name: String,
    pub automation_id: Option<String>,
    pub class_name: Option<String>,
    pub process_id: u32,
    pub enabled: bool,
    pub focusable: bool,
    pub focused: bool,
    pub bounding_rectangle: Option<DesktopRect>,
    pub patterns: Vec<DesktopPattern>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActionKind {
    Invoke,
    SetValue,
    Select,
    Toggle,
    Expand,
    Collapse,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DesktopAction {
    pub reference: String,
    pub kind: DesktopActionKind,
    pub value: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DesktopActionOutcome {
    pub target: DesktopNode,
    pub verified: bool,
    pub delta: Value,
}

pub trait DesktopBackend: Send + Sync {
    /// Returns the current bounded semantic desktop candidates known by the backend.
    ///
    /// # Errors
    ///
    /// Returns a machine-readable capability error when semantic observation is unavailable.
    fn snapshot(&self) -> Result<Vec<DesktopNode>, CapabilityError>;

    /// Resolves an opaque semantic reference to its current target metadata.
    ///
    /// # Errors
    ///
    /// Returns `stale_reference` when the target can no longer be safely resolved, or another
    /// provider error when desktop observation itself fails.
    fn target(&self, reference: &str) -> Result<DesktopNode, CapabilityError>;

    /// Performs one semantic desktop action without physical mouse or keyboard fallback.
    ///
    /// # Errors
    ///
    /// Returns a machine-readable error when the requested semantic pattern is unavailable or the
    /// backend cannot verify/execute the action.
    fn perform(&self, action: DesktopAction) -> Result<DesktopActionOutcome, CapabilityError>;
}

pub struct DesktopProvider {
    backend: Arc<dyn DesktopBackend>,
    ownership: Arc<TrustedOwnershipRegistry>,
    clipboard: Arc<PrivateClipboard>,
}

impl DesktopProvider {
    #[must_use]
    pub fn new<B>(backend: Arc<B>, ownership: Arc<TrustedOwnershipRegistry>) -> Self
    where
        B: DesktopBackend + 'static,
    {
        Self::with_clipboard(backend, ownership, Arc::new(PrivateClipboard::new()))
    }

    #[must_use]
    pub fn with_clipboard<B>(
        backend: Arc<B>,
        ownership: Arc<TrustedOwnershipRegistry>,
        clipboard: Arc<PrivateClipboard>,
    ) -> Self
    where
        B: DesktopBackend + 'static,
    {
        Self {
            backend,
            ownership,
            clipboard,
        }
    }

    #[must_use]
    pub const fn operations() -> &'static [&'static str] {
        &[
            "snapshot",
            "act",
            "private_clipboard_get",
            "private_clipboard_set",
        ]
    }

    fn snapshot(&self, arguments: &Value) -> Result<ProviderResult, CapabilityError> {
        let max_nodes = usize_argument(arguments, "max_nodes", DEFAULT_MAX_NODES)?;
        if max_nodes == 0 || max_nodes > MAX_NODES {
            return Err(invalid_arguments("max_nodes must be between 1 and 1000"));
        }

        let mut nodes = self.backend.snapshot()?;
        let truncated = nodes.len() > max_nodes;
        nodes.truncate(max_nodes);
        let encoded = nodes
            .iter()
            .map(|node| self.node_json(node))
            .collect::<Vec<_>>();

        Ok(ProviderResult {
            data: json!({
                "nodes": encoded,
                "truncated": truncated,
            }),
            delta: None,
            verification: VerificationStatus::NotApplicable,
        })
    }

    fn act(&self, arguments: &Value) -> Result<ProviderResult, CapabilityError> {
        let reference = string_argument(arguments, "reference")?;
        let kind = parse_action_kind(string_argument(arguments, "action")?)?;
        let value = self.resolve_action_value(arguments, kind)?;

        let target = self.backend.target(reference)?;
        if !self
            .ownership
            .is_tetherplane_owned(&ResourceKey::Process(target.process_id))
        {
            return Err(CapabilityError {
                code: ErrorCode::PermissionDenied,
                message: "desktop target is not Tetherplane-owned".into(),
                recovery_hint: Some(
                    "use observe-only snapshot or explicitly authorize foreground interaction"
                        .into(),
                ),
                details: json!({
                    "reference": reference,
                    "process_id": target.process_id,
                    "origin": self.origin_label(target.process_id),
                }),
            });
        }

        require_pattern(&target, kind)?;
        let outcome = self.backend.perform(DesktopAction {
            reference: reference.to_owned(),
            kind,
            value,
        })?;

        Ok(ProviderResult {
            data: json!({
                "verified": outcome.verified,
                "target": self.node_json(&outcome.target),
            }),
            delta: Some(outcome.delta),
            verification: if outcome.verified {
                VerificationStatus::Verified
            } else {
                VerificationStatus::ExecutedUnverified
            },
        })
    }

    fn resolve_action_value(
        &self,
        arguments: &Value,
        kind: DesktopActionKind,
    ) -> Result<Option<String>, CapabilityError> {
        let direct = arguments
            .get("value")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let from_private_clipboard = arguments
            .get("from_private_clipboard")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        if direct.is_some() && from_private_clipboard {
            return Err(invalid_arguments(
                "value and from_private_clipboard cannot both be set",
            ));
        }

        let value = if from_private_clipboard {
            self.clipboard.get().text
        } else {
            direct
        };

        if kind == DesktopActionKind::SetValue && value.is_none() {
            return Err(invalid_arguments(
                "set_value requires value or private clipboard text",
            ));
        }
        Ok(value)
    }

    fn private_clipboard_get(&self) -> ProviderResult {
        let state = self.clipboard.get();
        ProviderResult {
            data: json!(state),
            delta: None,
            verification: VerificationStatus::NotApplicable,
        }
    }

    fn private_clipboard_set(&self, arguments: &Value) -> Result<ProviderResult, CapabilityError> {
        let (text, files) = private_clipboard::parse_clipboard_set(arguments)?;
        let state = self.clipboard.set(text, files)?;
        Ok(ProviderResult {
            data: json!(state),
            delta: Some(json!({ "revision": state.revision })),
            verification: VerificationStatus::Verified,
        })
    }

    fn node_json(&self, node: &DesktopNode) -> Value {
        json!({
            "reference": node.reference,
            "parent_reference": node.parent_reference,
            "role": node.role,
            "name": node.name,
            "automation_id": node.automation_id,
            "class_name": node.class_name,
            "process_id": node.process_id,
            "enabled": node.enabled,
            "focusable": node.focusable,
            "focused": node.focused,
            "bounding_rectangle": node.bounding_rectangle,
            "patterns": node.patterns,
            "origin": self.origin_label(node.process_id),
        })
    }

    fn origin_label(&self, process_id: u32) -> &'static str {
        match self.ownership.origin(&ResourceKey::Process(process_id)) {
            Some(ResourceOrigin::Tetherplane) => "tetherplane",
            Some(ResourceOrigin::Human) => "human",
            Some(ResourceOrigin::HumanOrExternal) | None => "human_or_external",
        }
    }
}

#[async_trait]
impl CapabilityProvider for DesktopProvider {
    fn namespace(&self) -> &'static str {
        "desktop"
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let operation = invocation
            .capability
            .strip_prefix("desktop.")
            .ok_or_else(|| invalid_arguments("capability must use the desktop namespace"))?;

        match operation {
            "snapshot" => self.snapshot(&invocation.arguments),
            "act" => self.act(&invocation.arguments),
            "private_clipboard_get" => Ok(self.private_clipboard_get()),
            "private_clipboard_set" => self.private_clipboard_set(&invocation.arguments),
            _ => Err(CapabilityError {
                code: ErrorCode::CapabilityUnavailable,
                message: format!("desktop operation is unavailable: {operation}"),
                recovery_hint: None,
                details: json!({ "operation": operation }),
            }),
        }
    }
}

fn require_pattern(target: &DesktopNode, kind: DesktopActionKind) -> Result<(), CapabilityError> {
    let required = match kind {
        DesktopActionKind::Invoke => DesktopPattern::Invoke,
        DesktopActionKind::SetValue => DesktopPattern::Value,
        DesktopActionKind::Select => DesktopPattern::Selection,
        DesktopActionKind::Toggle => DesktopPattern::Toggle,
        DesktopActionKind::Expand | DesktopActionKind::Collapse => DesktopPattern::ExpandCollapse,
    };

    if target.patterns.contains(&required) {
        return Ok(());
    }

    Err(CapabilityError {
        code: ErrorCode::CapabilityUnavailable,
        message: "desktop target does not support requested semantic action".into(),
        recovery_hint: Some("take a fresh snapshot and inspect supported patterns".into()),
        details: json!({
            "reference": target.reference,
            "required_pattern": required,
        }),
    })
}

fn parse_action_kind(value: &str) -> Result<DesktopActionKind, CapabilityError> {
    match value {
        "invoke" => Ok(DesktopActionKind::Invoke),
        "set_value" => Ok(DesktopActionKind::SetValue),
        "select" => Ok(DesktopActionKind::Select),
        "toggle" => Ok(DesktopActionKind::Toggle),
        "expand" => Ok(DesktopActionKind::Expand),
        "collapse" => Ok(DesktopActionKind::Collapse),
        _ => Err(invalid_arguments(
            "action must be invoke, set_value, select, toggle, expand, or collapse",
        )),
    }
}

fn string_argument<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, CapabilityError> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a non-empty string")))
}

fn usize_argument(arguments: &Value, key: &str, default: usize) -> Result<usize, CapabilityError> {
    let Some(value) = arguments.get(key) else {
        return Ok(default);
    };
    let value = value
        .as_u64()
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a non-negative integer")))?;
    usize::try_from(value).map_err(|_| invalid_arguments(&format!("{key} is too large")))
}

fn invalid_arguments(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
        details: Value::Null,
    }
}

pub const CRATE_NAME: &str = "tether-desktop-provider";
