use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde_json::{Value, json};

use crate::{
    CapabilityError, ErrorCode, InvocationEnvelope, PrincipalProfile, ResourceOrigin,
    principal::{CapabilityDenialKind, SynchronizedDevicePolicy, tool_family_for_capability},
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

    fn denial_error(&self, _invocation: &InvocationEnvelope, reason: String) -> CapabilityError {
        CapabilityError {
            code: ErrorCode::PermissionDenied,
            message: reason,
            recovery_hint: None,
            details: json!({}),
        }
    }
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
struct StructuredDenial {
    reason: String,
    denial_kind: &'static str,
    recovery_hint: &'static str,
    policy_revision: Option<u64>,
    role: Option<&'static str>,
}

#[derive(Clone, Debug)]
pub struct LocalPolicyBroker {
    config: LocalPolicyConfig,
    synchronized_policy: Arc<RwLock<Option<SynchronizedDevicePolicy>>>,
}

impl LocalPolicyBroker {
    #[must_use]
    pub fn new(config: LocalPolicyConfig) -> Self {
        Self {
            config,
            synchronized_policy: Arc::new(RwLock::new(None)),
        }
    }

    pub fn set_synchronized_policy(&self, policy: Option<SynchronizedDevicePolicy>) {
        if let Ok(mut guard) = self.synchronized_policy.write() {
            *guard = policy;
        }
    }

    #[must_use]
    pub fn synchronized_policy(&self) -> Option<SynchronizedDevicePolicy> {
        self.synchronized_policy
            .read()
            .ok()
            .and_then(|guard| guard.clone())
    }

    #[must_use]
    pub fn has_launch_principal(&self) -> bool {
        self.config.principal.is_some()
    }

    #[must_use]
    pub fn is_capability_granted(
        &self,
        principal_id: Option<&str>,
        device_id: Option<&str>,
        capability: &str,
    ) -> bool {
        if let Some(principal) = self.config.principal.as_ref() {
            if let Some(req_device) = device_id
                && !principal.allowed_devices.is_empty()
                && !principal.allowed_devices.contains(req_device)
            {
                return false;
            }
            if !principal.allowed_capabilities.contains(capability) {
                return false;
            }
        }

        if let Some(sync_policy) = self.synchronized_policy() {
            if sync_policy.emergency_lockdown {
                return false;
            }
            if self.config.principal.is_some() {
                return sync_policy
                    .owner_policy
                    .evaluate_capability(capability)
                    .is_ok();
            }
            let effective_principal =
                principal_id.or(Some(sync_policy.owner_principal_id.as_str()));
            let Some(pset) = sync_policy.resolve_principal(effective_principal) else {
                return false;
            };
            return pset.evaluate_capability(capability).is_ok();
        }

        true
    }

    #[must_use]
    pub fn effective_permissions_summary(&self, principal_id: Option<&str>) -> Value {
        if let Some(sync_policy) = self.synchronized_policy() {
            let resolved = sync_policy
                .resolve_principal(principal_id.or(Some(sync_policy.owner_principal_id.as_str())));
            if let Some(pset) = resolved {
                return json!({
                    "principal_id": pset.principal_id,
                    "role": pset.role.as_str(),
                    "profile_id": pset.profile_id,
                    "universal_default": pset.universal_permissions,
                    "emergency_lockdown": sync_policy.emergency_lockdown,
                    "policy_revision": sync_policy.revision,
                    "policy_source": "synchronized",
                });
            }
            return json!({
                "principal_id": principal_id,
                "role": "unpaired",
                "profile_id": "none",
                "universal_default": false,
                "emergency_lockdown": sync_policy.emergency_lockdown,
                "policy_revision": sync_policy.revision,
                "policy_source": "synchronized",
            });
        }

        if let Some(principal) = self.config.principal.as_ref() {
            return json!({
                "principal_id": principal.principal_id,
                "role": "operator",
                "profile_id": "principal_profile",
                "universal_default": false,
                "emergency_lockdown": false,
                "policy_revision": 0,
                "policy_source": "principal_profile",
            });
        }

        json!({
            "principal_id": principal_id,
            "role": "owner",
            "profile_id": "universal",
            "universal_default": true,
            "emergency_lockdown": false,
            "policy_revision": 0,
            "policy_source": "local_default",
        })
    }

    #[must_use]
    pub fn side_effect_class(&self, capability: &str) -> SideEffectClass {
        if let Some(class) = self.config.operation_classes.get(capability) {
            return *class;
        }

        classify_capability(capability)
    }

    fn evaluate_synchronized_policy(
        &self,
        sync: &SynchronizedDevicePolicy,
        invocation: &InvocationEnvelope,
    ) -> Result<bool, StructuredDenial> {
        if sync.emergency_lockdown {
            return Err(StructuredDenial {
                reason: format!(
                    "emergency access revocation is active on device {}",
                    sync.device_id
                ),
                denial_kind: "emergency_lockdown",
                recovery_hint: "Disable emergency lockdown in the Tetherplane Control Portal to restore device access.",
                policy_revision: Some(sync.revision),
                role: None,
            });
        }

        if self.config.principal.is_some() {
            if let Err(denial_kind) = sync
                .owner_policy
                .evaluate_capability(&invocation.capability)
            {
                return Err(StructuredDenial {
                    reason: format!(
                        "capability {} is denied by synchronized device policy (revision {})",
                        invocation.capability, sync.revision
                    ),
                    denial_kind: denial_kind.as_str(),
                    recovery_hint: "Re-enable this tool family or operation in the Tetherplane Control Portal.",
                    policy_revision: Some(sync.revision),
                    role: Some(sync.owner_policy.role.as_str()),
                });
            }
            return Ok(false);
        }

        let Some(pset) = sync.resolve_principal(invocation.principal_id.as_deref()) else {
            return Err(StructuredDenial {
                reason: format!(
                    "identity {} is not paired or authorized for device {}",
                    invocation
                        .principal_id
                        .as_deref()
                        .unwrap_or("<unauthenticated>"),
                    sync.device_id
                ),
                denial_kind: "unpaired_or_unauthorized_identity",
                recovery_hint: "Authenticate with the paired owner account or add an operator grant in the Tetherplane Control Portal.",
                policy_revision: Some(sync.revision),
                role: None,
            });
        };

        if let Some(device_id) = invocation.device_id.as_deref()
            && device_id != sync.device_id
        {
            return Err(StructuredDenial {
                reason: format!(
                    "principal {} is not authorized for device {device_id}",
                    pset.principal_id
                ),
                denial_kind: "device_not_authorized",
                recovery_hint: "Target the paired device ID or authorize the target device in the Tetherplane Control Portal.",
                policy_revision: Some(sync.revision),
                role: Some(pset.role.as_str()),
            });
        }

        if let Err(denial_kind) = pset.evaluate_capability(&invocation.capability) {
            let hint = match denial_kind {
                CapabilityDenialKind::ExplicitDeny => {
                    "Remove the explicit deny rule for this tool family or operation in the Tetherplane Control Portal."
                }
                CapabilityDenialKind::FamilyRevoked => {
                    "Toggle the tool family back on for this device in the Tetherplane Control Portal."
                }
                CapabilityDenialKind::OperationNotGranted => {
                    "Grant this operation or tool family to the active identity in the Tetherplane Control Portal."
                }
            };
            return Err(StructuredDenial {
                reason: format!(
                    "principal {} ({}) is denied capability {} on device {} ({})",
                    pset.principal_id,
                    pset.role.as_str(),
                    invocation.capability,
                    sync.device_id,
                    denial_kind.as_str()
                ),
                denial_kind: denial_kind.as_str(),
                recovery_hint: hint,
                policy_revision: Some(sync.revision),
                role: Some(pset.role.as_str()),
            });
        }

        if !pset.allowed_roots.is_empty()
            && let Some(path_err) = check_paths_in_roots(invocation, &pset.allowed_roots)
        {
            return Err(StructuredDenial {
                reason: path_err,
                denial_kind: "path_outside_allowed_roots",
                recovery_hint: "Use a path within the identity's permitted filesystem roots.",
                policy_revision: Some(sync.revision),
                role: Some(pset.role.as_str()),
            });
        }

        Ok(pset.allow_destructive || pset.universal_permissions)
    }

    fn evaluate_structured(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<bool, StructuredDenial> {
        let sync_policy = self.synchronized_policy();
        let allow_destructive = if let Some(ref sync) = sync_policy {
            self.evaluate_synchronized_policy(sync, invocation)?
        } else {
            false
        };

        if let Some(denial) = self.principal_denial(invocation) {
            return Err(denial);
        }

        if !self.config.allowed_directories.is_empty()
            && let Some(path_err) =
                check_paths_in_roots(invocation, &self.config.allowed_directories)
        {
            return Err(StructuredDenial {
                reason: path_err,
                denial_kind: "path_outside_allowed_roots",
                recovery_hint: "Ensure the target path is inside the device's configured allowed directories without parent traversal.",
                policy_revision: sync_policy.as_ref().map(|p| p.revision),
                role: None,
            });
        }

        if invocation.capability == "process.terminate"
            && ResourceOrigin::from_arguments(&invocation.arguments)
                .is_some_and(ResourceOrigin::is_human_origin)
        {
            return Err(StructuredDenial {
                reason: "human-origin processes cannot be terminated by default".into(),
                denial_kind: "human_resource_protected",
                recovery_hint: "Only AI-started background processes may be terminated through Tetherplane.",
                policy_revision: sync_policy.as_ref().map(|p| p.revision),
                role: None,
            });
        }

        Ok(allow_destructive)
    }

    fn principal_denial(&self, invocation: &InvocationEnvelope) -> Option<StructuredDenial> {
        let principal = self.config.principal.as_ref()?;

        if invocation.principal_id.as_deref() != Some(principal.principal_id.as_str()) {
            return Some(StructuredDenial {
                reason: "request principal does not match the authenticated principal".into(),
                denial_kind: "unpaired_or_unauthorized_identity",
                recovery_hint: "Authenticate as the bound principal configured for this runtime.",
                policy_revision: None,
                role: Some("operator"),
            });
        }

        if let Some(device_id) = invocation.device_id.as_deref()
            && !principal.allowed_devices.contains(device_id)
        {
            return Some(StructuredDenial {
                reason: format!(
                    "principal {} is not authorized for device {device_id}",
                    principal.principal_id
                ),
                denial_kind: "device_not_authorized",
                recovery_hint: "Add the target device to allowed_devices in the principal profile or Control Portal.",
                policy_revision: None,
                role: Some("operator"),
            });
        }

        if !principal
            .allowed_capabilities
            .contains(&invocation.capability)
        {
            return Some(StructuredDenial {
                reason: format!(
                    "principal {} is not authorized for capability {}",
                    principal.principal_id, invocation.capability
                ),
                denial_kind: "operation_not_granted",
                recovery_hint: "Grant this capability in the principal profile or Tetherplane Control Portal.",
                policy_revision: None,
                role: Some("operator"),
            });
        }

        if let Some(path_err) = check_paths_in_roots(invocation, &principal.allowed_directories) {
            return Some(StructuredDenial {
                reason: path_err,
                denial_kind: "path_outside_allowed_roots",
                recovery_hint: "Choose a path within the principal's allowed directories.",
                policy_revision: None,
                role: Some("operator"),
            });
        }

        None
    }
}

impl PolicyBroker for LocalPolicyBroker {
    fn evaluate(&self, invocation: &InvocationEnvelope) -> PolicyDecision {
        let allow_destructive = match self.evaluate_structured(invocation) {
            Ok(allow_destructive) => allow_destructive,
            Err(denial) => {
                return PolicyDecision::Deny {
                    reason: denial.reason,
                };
            }
        };

        if invocation.capability == "filesystem.move"
            && invocation
                .arguments
                .get("replace")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
            && !allow_destructive
        {
            return PolicyDecision::RequireApproval {
                reason: "filesystem.move with replacement requires explicit approval".into(),
                approval_scope: ApprovalScope {
                    capability: invocation.capability.clone(),
                },
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
            | SideEffectClass::PrivilegedSystem => {
                if allow_destructive {
                    PolicyDecision::Allow
                } else {
                    PolicyDecision::RequireApproval {
                        reason: format!(
                            "{} requires explicit approval under local policy",
                            invocation.capability
                        ),
                        approval_scope: ApprovalScope {
                            capability: invocation.capability.clone(),
                        },
                    }
                }
            }
        }
    }

    fn denial_error(&self, invocation: &InvocationEnvelope, reason: String) -> CapabilityError {
        let tool_family = tool_family_for_capability(&invocation.capability)
            .map(super::principal::ToolFamily::as_str);
        if let Err(structured) = self.evaluate_structured(invocation) {
            return CapabilityError {
                code: ErrorCode::PermissionDenied,
                message: structured.reason,
                recovery_hint: Some(structured.recovery_hint.to_owned()),
                details: json!({
                    "denial_kind": structured.denial_kind,
                    "capability": invocation.capability,
                    "tool_family": tool_family,
                    "principal_id": invocation.principal_id,
                    "device_id": invocation.device_id,
                    "policy_revision": structured.policy_revision,
                    "role": structured.role,
                }),
            };
        }

        CapabilityError {
            code: ErrorCode::PermissionDenied,
            message: reason,
            recovery_hint: Some(
                "Review device permissions in the Tetherplane Control Portal.".to_owned(),
            ),
            details: json!({
                "denial_kind": "policy_denied",
                "capability": invocation.capability,
                "tool_family": tool_family,
                "principal_id": invocation.principal_id,
                "device_id": invocation.device_id,
            }),
        }
    }
}

fn check_paths_in_roots(
    invocation: &InvocationEnvelope,
    allowed_directories: &[PathBuf],
) -> Option<String> {
    if invocation.capability.starts_with("filesystem.")
        && let Err(error) = authorize_filesystem_arguments(invocation, allowed_directories)
    {
        return Some(error.message);
    }

    if invocation.capability == "search.start"
        && let Some(root) = invocation
            .arguments
            .get("root")
            .and_then(serde_json::Value::as_str)
        && let Err(error) = authorize_path(Path::new(root), allowed_directories)
    {
        return Some(error.message);
    }

    if invocation.capability == "browser.upload"
        && let Err(error) = authorize_browser_upload(invocation, allowed_directories)
    {
        return Some(error.message);
    }

    None
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

fn authorize_browser_upload(
    invocation: &InvocationEnvelope,
    allowed_directories: &[PathBuf],
) -> Result<(), CapabilityError> {
    if let Some(path) = invocation
        .arguments
        .get("file_path")
        .and_then(serde_json::Value::as_str)
    {
        authorize_path(Path::new(path), allowed_directories)?;
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
