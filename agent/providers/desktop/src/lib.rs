#![forbid(unsafe_code)]

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tether_core::{
    ActorKind, CapabilityError, CapabilityProvider, ErrorCode, InvocationEnvelope, ProviderResult,
    ResourceKey, ResourceOrigin, TrustedOwnershipRegistry, VerificationStatus,
};

mod foreground_lease;
mod human_activity;
mod physical;
mod private_clipboard;
#[cfg(windows)]
mod windows_human_activity;
#[cfg(windows)]
mod windows_physical;
#[cfg(windows)]
mod windows_uia;

pub use foreground_lease::{
    ForegroundLease, ForegroundLeaseGrant, ForegroundLeaseStore, RestorationStatus,
};
pub use human_activity::{
    ForegroundWindowIdentity, HumanActivityMonitor, HumanActivitySnapshot, require_human_idle,
};
pub use physical::{DesktopPoint, PhysicalDesktopExecutor, PhysicalMoveOutcome};
pub use private_clipboard::{PrivateClipboard, PrivateClipboardState};
#[cfg(windows)]
pub use windows_human_activity::WindowsHumanActivityMonitor;
#[cfg(windows)]
pub use windows_physical::WindowsPhysicalDesktopExecutor;
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
    human_activity: Arc<dyn HumanActivityMonitor>,
    leases: Arc<ForegroundLeaseStore>,
    physical: Arc<dyn PhysicalDesktopExecutor>,
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
        Self::with_services(
            backend,
            ownership,
            clipboard,
            Arc::new(human_activity::UnavailableHumanActivityMonitor),
            Arc::new(ForegroundLeaseStore::new()),
            Arc::new(physical::DisabledPhysicalDesktopExecutor),
        )
    }

    #[must_use]
    pub fn with_services<B, H, P>(
        backend: Arc<B>,
        ownership: Arc<TrustedOwnershipRegistry>,
        clipboard: Arc<PrivateClipboard>,
        human_activity: Arc<H>,
        leases: Arc<ForegroundLeaseStore>,
        physical: Arc<P>,
    ) -> Self
    where
        B: DesktopBackend + 'static,
        H: HumanActivityMonitor + 'static,
        P: PhysicalDesktopExecutor + 'static,
    {
        Self {
            backend,
            ownership,
            clipboard,
            human_activity,
            leases,
            physical,
        }
    }

    #[must_use]
    pub const fn operations() -> &'static [&'static str] {
        &[
            "snapshot",
            "act",
            "private_clipboard_get",
            "private_clipboard_set",
            "foreground_lease_acquire",
            "foreground_lease_get",
            "foreground_lease_release",
            "physical_pointer_move",
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

    fn foreground_lease_acquire(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        if invocation.actor.kind != ActorKind::Human {
            return Err(CapabilityError {
                code: ErrorCode::PermissionDenied,
                message: "only a trusted local human actor may grant a foreground lease".into(),
                recovery_hint: None,
                details: Value::Null,
            });
        }

        let principal_id = string_argument(&invocation.arguments, "for_principal_id")?;
        let target_resource = string_argument(&invocation.arguments, "target_resource")?;
        if target_resource != "pointer" {
            return Err(invalid_arguments(
                "initial foreground leases support only target_resource pointer",
            ));
        }
        let capabilities = string_set_argument(&invocation.arguments, "capabilities")?;
        if capabilities
            .iter()
            .any(|capability| capability != "desktop.physical_pointer_move")
        {
            return Err(invalid_arguments(
                "initial foreground leases support only desktop.physical_pointer_move",
            ));
        }
        let ttl_ms = u64_argument(&invocation.arguments, "ttl_ms", 30_000)?;
        let reason = string_argument(&invocation.arguments, "reason")?;
        let baseline_activity = self.human_activity.snapshot()?;
        let baseline_cursor = self.physical.capture_cursor()?;
        let lease = self.leases.acquire(ForegroundLeaseGrant {
            principal_id: principal_id.to_owned(),
            approved_by_actor_id: invocation.actor.id.clone(),
            target_resource: target_resource.to_owned(),
            capabilities,
            issued_at_ms: epoch_ms()?,
            ttl_ms,
            reason: reason.to_owned(),
            baseline_cursor: Some(baseline_cursor),
            baseline_foreground: baseline_activity.foreground_window,
        })?;

        Ok(ProviderResult {
            data: json!(lease),
            delta: Some(json!({ "lease_id": lease.lease_id })),
            verification: VerificationStatus::Verified,
        })
    }

    fn foreground_lease_get(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let lease_id = string_argument(&invocation.arguments, "lease_id")?;
        let now_ms = epoch_ms()?;
        let lease = self
            .leases
            .get(lease_id, now_ms)
            .ok_or_else(|| foreground_lease_required("foreground lease does not exist"))?;
        Self::authorize_lease_reader(&lease, invocation)?;
        let lease = self.restore_if_pending(lease, now_ms)?;

        Ok(ProviderResult {
            data: json!(lease),
            delta: None,
            verification: VerificationStatus::NotApplicable,
        })
    }

    fn foreground_lease_release(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let lease_id = string_argument(&invocation.arguments, "lease_id")?;
        let now_ms = epoch_ms()?;
        let lease = self.leases.release(
            lease_id,
            invocation.principal_id.as_deref(),
            invocation.actor.kind == ActorKind::Human,
            now_ms,
        )?;
        let lease = self.restore_if_pending(lease, now_ms)?;

        Ok(ProviderResult {
            data: json!(lease),
            delta: Some(json!({
                "lease_id": lease_id,
                "restoration_status": lease.restoration_status,
            })),
            verification: VerificationStatus::Verified,
        })
    }

    fn physical_pointer_move(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let lease_id = string_argument(&invocation.arguments, "lease_id")?;
        let target_resource = string_argument(&invocation.arguments, "target_resource")?;
        let now_ms = epoch_ms()?;
        let lease = self
            .leases
            .get(lease_id, now_ms)
            .ok_or_else(|| foreground_lease_required("foreground lease does not exist"))?;
        let lease = self.restore_if_pending(lease, now_ms)?;
        lease.authorize(
            invocation.principal_id.as_deref(),
            target_resource,
            "desktop.physical_pointer_move",
        )?;

        require_human_idle(self.human_activity.as_ref(), 1_500)?;
        let target = DesktopPoint {
            x: i32_argument(&invocation.arguments, "x")?,
            y: i32_argument(&invocation.arguments, "y")?,
        };
        let outcome = self.physical.pointer_move(target)?;

        Ok(ProviderResult {
            data: json!({
                "position": outcome.position,
                "verified": outcome.verified,
                "lease_id": lease_id,
            }),
            delta: Some(json!({
                "pointer_moved": true,
                "position": outcome.position,
            })),
            verification: if outcome.verified {
                VerificationStatus::Verified
            } else {
                VerificationStatus::ExecutedUnverified
            },
        })
    }

    fn authorize_lease_reader(
        lease: &ForegroundLease,
        invocation: &InvocationEnvelope,
    ) -> Result<(), CapabilityError> {
        if invocation.actor.kind == ActorKind::Human
            || invocation.principal_id.as_deref() == Some(lease.principal_id.as_str())
        {
            return Ok(());
        }

        Err(CapabilityError {
            code: ErrorCode::PermissionDenied,
            message: "foreground lease belongs to a different principal".into(),
            recovery_hint: None,
            details: Value::Null,
        })
    }

    fn restore_if_pending(
        &self,
        lease: ForegroundLease,
        now_ms: u64,
    ) -> Result<ForegroundLease, CapabilityError> {
        if lease.restoration_status != RestorationStatus::Pending {
            return Ok(lease);
        }

        if let Some(cursor) = lease.baseline_cursor {
            self.physical.restore_cursor(cursor)?;
        }
        self.leases.mark_restored(&lease.lease_id, now_ms)
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
            "foreground_lease_acquire" => self.foreground_lease_acquire(invocation),
            "foreground_lease_get" => self.foreground_lease_get(invocation),
            "foreground_lease_release" => self.foreground_lease_release(invocation),
            "physical_pointer_move" => self.physical_pointer_move(invocation),
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

fn string_set_argument(arguments: &Value, key: &str) -> Result<BTreeSet<String>, CapabilityError> {
    let values = arguments
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_arguments(&format!("{key} must be an array of strings")))?;
    let mut result = BTreeSet::new();
    for value in values {
        let value = value
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                invalid_arguments(&format!("{key} must contain only non-empty strings"))
            })?;
        result.insert(value.to_owned());
    }
    Ok(result)
}

fn u64_argument(arguments: &Value, key: &str, default: u64) -> Result<u64, CapabilityError> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => value
            .as_u64()
            .ok_or_else(|| invalid_arguments(&format!("{key} must be a non-negative integer"))),
    }
}

fn i32_argument(arguments: &Value, key: &str) -> Result<i32, CapabilityError> {
    let value = arguments
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid_arguments(&format!("{key} must be an integer")))?;
    i32::try_from(value).map_err(|_| invalid_arguments(&format!("{key} is out of range")))
}

fn epoch_ms() -> Result<u64, CapabilityError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| CapabilityError {
            code: ErrorCode::ProviderFailure,
            message: format!("system clock is before Unix epoch: {error}"),
            recovery_hint: None,
            details: Value::Null,
        })?;
    u64::try_from(duration.as_millis()).map_err(|_| CapabilityError {
        code: ErrorCode::ProviderFailure,
        message: "system clock value is too large".into(),
        recovery_hint: None,
        details: Value::Null,
    })
}

fn foreground_lease_required(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ForegroundLeaseRequired,
        message: message.to_owned(),
        recovery_hint: Some("obtain a new scoped foreground lease".into()),
        details: Value::Null,
    }
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
