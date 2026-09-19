use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::json;

use crate::{
    CapabilityError, ErrorCode, InvocationEnvelope, PrincipalProfile, ResourceOrigin,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SideEffectClass {
    ReadOnly,
    LocalReversible,
    LocalDestructive,
    ExternalMutation,
    ExternalCommunication,
    Financial,
    CredentialSensitive,
    PrivilegedSystem,
    ForegroundDisruptive,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovalScope {
    pub capability: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PolicyDecision {
    Allow,
    Deny {
        reason: String,
    },
    RequireApproval {
        reason: String,
        approval_scope: ApprovalScope,
    },
}
pub trait PolicyBroker: Send + Sync {
    fn evaluate(&self, invocation: &InvocationEnvelope) -> PolicyDecision;
}

#[derive(Clone, Debug)]
pub struct LocalPolicyConfig {
    pub allowed_directories: Vec<PathBuf>,
    pub background_only: bool,
    pub operation_classes: HashMap<String, SideEffectClass>,
    pub principal: Option<PrincipalProfile>,
}

impl LocalPolicyConfig {
    #[must_use]
    pub fn new(allowed_directories: Vec<PathBuf>) -> Self {
        let mut operation_classes = HashMap::new();
        operation_classes.insert(
            "filesystem.delete".into(),
            SideEffectClass::LocalDestructive,
        );
        operation_classes.insert(
            "process.terminate".into(),
            SideEffectClass::LocalDestructive,
        );

        Self {
            allowed_directories,
            background_only: true,
            operation_classes,
            principal: None,
        }
    }

    #[must_use]
    pub fn with_principal(mut self, principal: PrincipalProfile) -> Self {
        self.principal = Some(principal);
        self
    }
}

#[derive(Clone, Debug)]
pub struct LocalPolicyBroker {
    config: LocalPolicyConfig,
}

impl LocalPolicyBroker {
    #[must_use]
    pub fn new(config: LocalPolicyConfig) -> Self {
        Self { config }
    }

    #[must_use]
    pub fn side_effect_class(&self, capability: &str) -> SideEffectClass {
        if let Some(class) = self.config.operation_classes.get(capability) {
            return *class;
        }

        classify_capability(capability)
    }

    fn principal_denial_reason(&self, invocation: &InvocationEnvelope) -> Option<String> {
        let principal = self.config.principal.as_ref()?;

        if invocation.principal_id.as_deref() != Some(principal.principal_id.as_str()) {
            return Some("request principal does not match the authenticated principal".into());
        }

        if let Some(device_id) = invocation.device_id.as_deref()
            && !principal.allowed_devices.contains(device_id)
        {
            return Some(format!(
                "principal {} is not authorized for device {device_id}",
                principal.principal_id
            ));
        }

        if !principal
            .allowed_capabilities
            .contains(&invocation.capability)
        {
            return Some(format!(
                "principal {} is not authorized for capability {}",
                principal.principal_id, invocation.capability
            ));
        }

        if invocation.capability.starts_with("filesystem.")
            && let Err(error) =
                authorize_filesystem_arguments(invocation, &principal.allowed_directories)
        {
            return Some(error.message);
        }

        if invocation.capability == "search.start"
            && let Some(root) = invocation
                .arguments
                .get("root")
                .and_then(serde_json::Value::as_str)
            && let Err(error) = authorize_path(Path::new(root), &principal.allowed_directories)
        {
            return Some(error.message);
        }

        None
    }
}
impl PolicyBroker for LocalPolicyBroker {
    fn evaluate(&self, invocation: &InvocationEnvelope) -> PolicyDecision {
        if let Some(reason) = self.principal_denial_reason(invocation) {
            return PolicyDecision::Deny { reason };
        }

        if invocation.capability.starts_with("filesystem.")
            && let Err(error) =
                authorize_filesystem_arguments(invocation, &self.config.allowed_directories)
        {
            return PolicyDecision::Deny {
                reason: error.message,
            };
        }

        if invocation.capability == "search.start"
            && let Some(root) = invocation
                .arguments
                .get("root")
                .and_then(serde_json::Value::as_str)
            && let Err(error) = authorize_path(Path::new(root), &self.config.allowed_directories)
        {
            return PolicyDecision::Deny {
                reason: error.message,
            };
        }

        if invocation.capability == "filesystem.move"
            && invocation
                .arguments
                .get("replace")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        {
            return PolicyDecision::RequireApproval {
                reason: "filesystem.move with replacement requires explicit approval".into(),
                approval_scope: ApprovalScope {
                    capability: invocation.capability.clone(),
                },
            };
        }

        if invocation.capability == "process.terminate"
            && ResourceOrigin::from_arguments(&invocation.arguments)
                .is_some_and(ResourceOrigin::is_human_origin)
        {
            return PolicyDecision::Deny {
                reason: "human-origin processes cannot be terminated by default".into(),
            };
        }

        match self.side_effect_class(&invocation.capability) {
            SideEffectClass::ReadOnly
            | SideEffectClass::LocalReversible
            | SideEffectClass::ForegroundDisruptive => PolicyDecision::Allow,
            SideEffectClass::LocalDestructive
            | SideEffectClass::ExternalMutation
            | SideEffectClass::ExternalCommunication
            | SideEffectClass::Financial
            | SideEffectClass::CredentialSensitive
            | SideEffectClass::PrivilegedSystem => PolicyDecision::RequireApproval {
                reason: format!(
                    "{} requires explicit approval under local policy",
                    invocation.capability
                ),
                approval_scope: ApprovalScope {
                    capability: invocation.capability.clone(),
                },
            },
        }
    }
}

fn authorize_filesystem_arguments(
    invocation: &InvocationEnvelope,
    allowed_directories: &[PathBuf],
) -> Result<(), CapabilityError> {
    for key in ["path", "source", "destination"] {
        if let Some(path) = invocation
            .arguments
            .get(key)
            .and_then(serde_json::Value::as_str)
        {
            authorize_path(Path::new(path), allowed_directories)?;
        }
    }

    if let Some(paths) = invocation
        .arguments
        .get("paths")
        .and_then(serde_json::Value::as_array)
    {
        for path in paths.iter().filter_map(serde_json::Value::as_str) {
            authorize_path(Path::new(path), allowed_directories)?;
        }
    }

    Ok(())
}

fn classify_capability(capability: &str) -> SideEffectClass {
    if capability.starts_with("desktop.physical_") {
        return SideEffectClass::ForegroundDisruptive;
    }

    if matches!(
        capability,
        "filesystem.read" | "filesystem.info" | "filesystem.list" | "device.status"
    ) {
        return SideEffectClass::ReadOnly;
    }

    SideEffectClass::LocalReversible
}
/// Resolves a candidate path and verifies it remains inside an allowed directory.
///
/// # Errors
///
/// Returns `permission_denied` when the candidate escapes the allowed roots and
/// `provider_failure` when canonicalization cannot be completed safely.
pub fn authorize_path(
    path: &Path,
    allowed_directories: &[PathBuf],
) -> Result<PathBuf, CapabilityError> {
    if path
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(permission_denied(
            path,
            "parent traversal is not authorized",
        ));
    }

    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| provider_failure("resolve current directory", &error))?
            .join(path)
    };
    let resolved = resolve_candidate(&absolute)?;

    for allowed in allowed_directories {
        let Ok(root) = fs::canonicalize(allowed) else {
            continue;
        };
        if resolved.starts_with(&root) {
            return Ok(resolved);
        }
    }

    Err(permission_denied(
        path,
        "path resolves outside configured allowed directories",
    ))
}

fn resolve_candidate(path: &Path) -> Result<PathBuf, CapabilityError> {
    if path.exists() {
        return fs::canonicalize(path)
            .map_err(|error| provider_failure("canonicalize existing path", &error));
    }

    let mut ancestor = path.to_path_buf();
    let mut suffix: Vec<OsString> = Vec::new();

    while !ancestor.exists() {
        let Some(name) = ancestor.file_name().map(OsString::from) else {
            return Err(permission_denied(
                path,
                "path has no existing canonical parent",
            ));
        };
        suffix.push(name);
        if !ancestor.pop() {
            return Err(permission_denied(
                path,
                "path has no existing canonical parent",
            ));
        }
    }

    let mut resolved = fs::canonicalize(&ancestor)
        .map_err(|error| provider_failure("canonicalize parent path", &error))?;
    for component in suffix.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}
fn permission_denied(path: &Path, reason: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::PermissionDenied,
        message: reason.into(),
        recovery_hint: None,
        details: json!({ "path": path.to_string_lossy() }),
    }
}

fn provider_failure(context: &str, error: &std::io::Error) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ProviderFailure,
        message: format!("{context}: {error}"),
        recovery_hint: None,
        details: json!({}),
    }
}
