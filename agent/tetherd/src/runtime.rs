use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde_json::{Value, json};
use tether_browser_provider::BrowserProvider;
use tether_core::{
    Actor, ActorKind, CapabilityError, CapabilityProvider, CapabilityRouter, ErrorCode,
    InvocationEnvelope, LocalPolicyBroker, LocalPolicyConfig, PrincipalProfile, ProviderResult,
    ResponseMode, ResultEnvelope, ResultStatus, SynchronizedDevicePolicy, Timing, ToolFamily,
    TrustedOwnershipRegistry, VerificationStatus, tool_family_for_capability,
};
use tether_desktop_provider::DesktopProvider;
#[cfg(windows)]
use tether_desktop_provider::{
    ForegroundLeaseStore, PrivateClipboard, WindowsHumanActivityMonitor,
    WindowsPhysicalDesktopExecutor, WindowsUiaBackend,
};
use tether_filesystem_provider::FilesystemProvider;
use tether_process_provider::ProcessProvider;
use tether_search_provider::SearchProvider;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::audit::{AuditProvider, AuditStore};
use crate::idempotency::{
    IdempotencyLookup, IdempotencyStore, conflict_result, is_mutation_capability, pending_result,
    store_failure_result, unavailable_result,
};
use crate::job::JobProvider;

pub struct AgentRuntime {
    router: CapabilityRouter,
    policy: Arc<LocalPolicyBroker>,
    device_provider: Arc<DeviceProvider>,
    browser_provider: Option<Arc<BrowserProvider>>,
    bound_principal_id: Option<String>,
    bound_device_id: Option<String>,
    state_dir: Option<PathBuf>,
    audit_store: Option<Arc<AuditStore>>,
    idempotency_store: Option<Arc<Mutex<IdempotencyStore>>>,
    policy_update_lock: std::sync::Mutex<()>,
}

impl AgentRuntime {
    #[cfg(test)]
    pub fn new(
        allowed_roots: Vec<PathBuf>,
        principal: Option<PrincipalProfile>,
        state_dir: Option<&Path>,
        browser_provider: Option<Arc<BrowserProvider>>,
    ) -> Result<Self, CapabilityError> {
        Self::new_with_device(allowed_roots, principal, state_dir, browser_provider, None)
    }

    pub fn new_with_device(
        allowed_roots: Vec<PathBuf>,
        principal: Option<PrincipalProfile>,
        state_dir: Option<&Path>,
        browser_provider: Option<Arc<BrowserProvider>>,
        bound_device_id: Option<&str>,
    ) -> Result<Self, CapabilityError> {
        Self::new_with_desktop_init(
            allowed_roots,
            principal,
            state_dir,
            browser_provider,
            bound_device_id,
            default_desktop_initializer,
        )
    }

    fn new_with_desktop_init<F>(
        mut allowed_roots: Vec<PathBuf>,
        principal: Option<PrincipalProfile>,
        state_dir: Option<&Path>,
        browser_provider: Option<Arc<BrowserProvider>>,
        bound_device_id: Option<&str>,
        build_desktop: F,
    ) -> Result<Self, CapabilityError>
    where
        F: FnOnce(&Arc<TrustedOwnershipRegistry>) -> Result<Arc<DesktopProvider>, CapabilityError>,
    {
        if allowed_roots.is_empty()
            && let Some(profile) = principal.as_ref()
            && !profile.allowed_directories.is_empty()
        {
            allowed_roots.clone_from(&profile.allowed_directories);
        }
        if allowed_roots.is_empty() {
            allowed_roots.push(std::env::current_dir().map_err(|error| CapabilityError {
                code: ErrorCode::ProviderFailure,
                message: format!("failed to resolve runtime working directory: {error}"),
                recovery_hint: None,
                details: serde_json::json!({}),
            })?);
        }
        let bound_principal_id = principal
            .as_ref()
            .map(|profile| profile.principal_id.clone());
        let bound_device_id = bound_device_id.map(ToOwned::to_owned);
        let job_available = state_dir.is_some();
        let audit_store = if let Some(state_dir) = state_dir.as_ref() {
            Some(Arc::new(AuditStore::new(state_dir)?))
        } else {
            None
        };
        let audit_available = audit_store.is_some();
        let idempotency_store = if let Some(state_dir) = state_dir {
            Some(Arc::new(Mutex::new(IdempotencyStore::new(state_dir)?)))
        } else {
            None
        };
        let mut policy_config = LocalPolicyConfig::new(allowed_roots);
        if let Some(profile) = principal {
            policy_config = policy_config.with_principal(profile);
        }
        let policy = Arc::new(LocalPolicyBroker::new(policy_config));
        if let Some(dir) = state_dir
            && let Some(persisted) = load_persisted_policy(dir, bound_device_id.as_deref())?
        {
            policy.set_synchronized_policy(Some(persisted));
        }

        let mut router = CapabilityRouter::with_policy(Arc::clone(&policy) as Arc<_>);
        let ownership = Arc::new(TrustedOwnershipRegistry::new());
        let desktop = build_desktop_components(&ownership, build_desktop);

        let device_provider = Arc::new(DeviceProvider::new(
            Arc::clone(&policy),
            job_available,
            audit_available,
            browser_provider.clone(),
            desktop.capability,
        ));
        router.register(Arc::clone(&device_provider) as Arc<_>)?;
        router.register(Arc::new(FilesystemProvider::new()))?;
        router.register(Arc::new(SearchProvider::new()))?;
        router.register(Arc::new(ProcessProvider::with_ownership(Arc::clone(
            &ownership,
        ))))?;
        if let Some(state_dir) = state_dir.as_ref() {
            router.register(Arc::new(JobProvider::new(state_dir)?))?;
        } else {
            router.register(Arc::new(UnavailableProvider::new("job")))?;
        }
        if let Some(audit_store) = audit_store.as_ref() {
            router.register(Arc::new(AuditProvider::new(Arc::clone(audit_store))))?;
        } else {
            router.register(Arc::new(UnavailableProvider::new("audit")))?;
        }
        if let Some(browser) = &browser_provider {
            router.register(Arc::clone(browser) as Arc<_>)?;
        } else {
            router.register(Arc::new(UnavailableProvider::new("browser")))?;
        }
        router.register(desktop.provider)?;

        Ok(Self {
            router,
            policy,
            device_provider,
            browser_provider,
            bound_principal_id,
            bound_device_id,
            state_dir: state_dir.map(Path::to_path_buf),
            audit_store,
            idempotency_store,
            policy_update_lock: std::sync::Mutex::new(()),
        })
    }

    #[must_use]
    pub fn has_browser_provider(&self) -> bool {
        self.browser_provider.is_some()
    }

    pub async fn refresh_browser_availability(&self) -> bool {
        let Some(browser) = &self.browser_provider else {
            return false;
        };
        let previous = browser.current_capability_report();
        browser.probe_status().await;
        previous != browser.current_capability_report()
    }

    #[must_use]
    pub fn applied_policy_revision(&self) -> u64 {
        self.policy
            .synchronized_policy()
            .map_or(0, |policy| policy.revision)
    }

    #[must_use]
    pub fn device_status(&self) -> Value {
        self.device_provider.status()
    }

    #[must_use]
    pub fn device_capabilities(
        &self,
        principal_id: Option<&str>,
        device_id: Option<&str>,
    ) -> Value {
        let effective_principal = self.bound_principal_id.as_deref().or(principal_id);
        self.device_provider
            .capabilities_for(effective_principal, device_id)
    }

    pub fn apply_synchronized_policy(
        &self,
        policy: SynchronizedDevicePolicy,
    ) -> Result<Value, CapabilityError> {
        let _guard = self
            .policy_update_lock
            .lock()
            .map_err(|_| CapabilityError {
                code: ErrorCode::ProviderFailure,
                message: "synchronized policy lock was poisoned".to_owned(),
                recovery_hint: None,
                details: json!({}),
            })?;

        if let Some(idempotent_ack) = self.validate_synchronized_policy(&policy)? {
            return Ok(idempotent_ack);
        }

        let revision = policy.revision;
        let device_id = policy.device_id.clone();
        let owner_principal_id = policy.owner_principal_id.clone();
        let updated_by = if policy.updated_by.is_empty() {
            owner_principal_id.clone()
        } else {
            policy.updated_by.clone()
        };

        if let Some(state_dir) = self.state_dir.as_ref() {
            persist_synchronized_policy(state_dir, &policy)?;
        }

        self.policy.set_synchronized_policy(Some(policy));
        self.record_policy_sync_audit(&device_id, &updated_by, revision);

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));

        Ok(json!({
            "deviceId": device_id,
            "revision": revision,
            "applied": true,
            "appliedAtMs": now_ms,
            "status": self.device_status(),
            "capabilities": self.device_capabilities(Some(&owner_principal_id), Some(&device_id)),
        }))
    }

    fn validate_synchronized_policy(
        &self,
        policy: &SynchronizedDevicePolicy,
    ) -> Result<Option<Value>, CapabilityError> {
        let revision = policy.revision;
        let current = self.policy.synchronized_policy();
        let current_revision = current.as_ref().map_or(0, |existing| existing.revision);

        if let Err(message) = policy.validate_invariants() {
            return Err(invalid_arguments_with_details(
                &message,
                json!({ "rejected_revision": revision, "current_revision": current_revision }),
            ));
        }

        if let Some(expected_device_id) = self.bound_device_id.as_deref()
            && policy.device_id != expected_device_id
        {
            return Err(invalid_arguments_with_details(
                &format!(
                    "policy_sync target device '{}' does not match bound device '{}'",
                    policy.device_id, expected_device_id
                ),
                json!({
                    "expected_device_id": expected_device_id,
                    "policy_device_id": policy.device_id,
                    "current_revision": current_revision,
                }),
            ));
        }

        let Some(existing) = current.as_ref() else {
            return Ok(None);
        };
        if existing.device_id != policy.device_id {
            return Err(invalid_arguments_with_details(
                &format!(
                    "policy_sync target device '{}' does not match existing policy device '{}'",
                    policy.device_id, existing.device_id
                ),
                json!({
                    "expected_device_id": existing.device_id,
                    "policy_device_id": policy.device_id,
                    "current_revision": existing.revision,
                }),
            ));
        }
        if revision < existing.revision {
            return Err(invalid_arguments_with_details(
                &format!(
                    "stale policy revision {revision} rejected; current revision is {}",
                    existing.revision
                ),
                json!({
                    "rejected_revision": revision,
                    "current_revision": existing.revision,
                }),
            ));
        }
        if revision == existing.revision {
            if policies_structurally_equal(existing, policy) {
                let now_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
                return Ok(Some(json!({
                    "deviceId": existing.device_id,
                    "revision": existing.revision,
                    "applied": true,
                    "idempotent": true,
                    "appliedAtMs": now_ms,
                    "status": self.device_status(),
                    "capabilities": self.device_capabilities(
                        Some(&existing.owner_principal_id),
                        Some(&existing.device_id),
                    ),
                })));
            }
            return Err(invalid_arguments_with_details(
                &format!("conflicting policy payload for current revision {revision} rejected"),
                json!({
                    "rejected_revision": revision,
                    "current_revision": existing.revision,
                }),
            ));
        }
        Ok(None)
    }

    fn record_policy_sync_audit(&self, device_id: &str, updated_by: &str, revision: u64) {
        let Some(audit_store) = &self.audit_store else {
            return;
        };
        let synth_invocation = InvocationEnvelope {
            protocol_version: "1.0".into(),
            request_id: Uuid::new_v4(),
            device_id: Some(device_id.to_owned()),
            principal_id: Some(updated_by.to_owned()),
            job_id: None,
            capability: "policy.sync".into(),
            arguments: json!({ "revision": revision }),
            actor: Actor {
                id: updated_by.to_owned(),
                kind: ActorKind::Human,
            },
            session_id: None,
            response_mode: ResponseMode::Compact,
            idempotency_key: None,
            preconditions: vec![],
            expectations: vec![],
        };
        let synth_result = ResultEnvelope {
            protocol_version: "1.0".into(),
            request_id: synth_invocation.request_id,
            status: ResultStatus::Success,
            data: Some(json!({ "revision": revision, "applied": true })),
            delta: None,
            error: None,
            verification: VerificationStatus::Verified,
            continuation: None,
            policy: None,
            timing: Timing { duration_ms: 0 },
        };
        let _ = audit_store.append(&synth_invocation, &synth_result);
    }

    pub async fn execute(&self, mut invocation: InvocationEnvelope) -> ResultEnvelope {
        if let Some(principal_id) = &self.bound_principal_id {
            invocation.principal_id = Some(principal_id.clone());
        }

        let audit_invocation = invocation.clone();
        let result = if invocation.idempotency_key.is_some()
            && is_mutation_capability(&invocation.capability)
        {
            self.execute_idempotent(invocation).await
        } else {
            self.router.execute(invocation).await
        };

        if let Some(audit_store) = &self.audit_store
            && let Err(error) = audit_store.append(&audit_invocation, &result)
        {
            eprintln!("audit append failed: {}", error.message);
        }
        result
    }

    async fn execute_idempotent(&self, invocation: InvocationEnvelope) -> ResultEnvelope {
        let Some(store) = &self.idempotency_store else {
            return unavailable_result(&invocation);
        };
        let guard = store.lock().await;

        match guard.lookup(&invocation) {
            Ok(IdempotencyLookup::Replay(result)) => *result,
            Ok(IdempotencyLookup::Conflict) => conflict_result(&invocation),
            Ok(IdempotencyLookup::Pending) => pending_result(&invocation),
            Ok(IdempotencyLookup::Miss) => {
                if let Err(error) = guard.reserve(&invocation) {
                    return store_failure_result(&invocation, error);
                }

                let result = self.router.execute(invocation.clone()).await;
                if let Err(error) = guard.complete(&invocation, &result) {
                    return store_failure_result(&invocation, error);
                }
                result
            }
            Err(error) => store_failure_result(&invocation, error),
        }
    }
}

fn policies_structurally_equal(
    left: &SynchronizedDevicePolicy,
    right: &SynchronizedDevicePolicy,
) -> bool {
    left.device_id == right.device_id
        && left.owner_account_id == right.owner_account_id
        && left.owner_principal_id == right.owner_principal_id
        && left.revision == right.revision
        && left.emergency_lockdown == right.emergency_lockdown
        && left.owner_policy == right.owner_policy
        && left.operator_policies == right.operator_policies
}

fn load_persisted_policy(
    state_dir: &Path,
    expected_device_id: Option<&str>,
) -> Result<Option<SynchronizedDevicePolicy>, CapabilityError> {
    let path = state_dir.join("policy").join("synchronized-policy.json");
    let raw = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(CapabilityError {
                code: ErrorCode::ProviderFailure,
                message: format!(
                    "failed to read persisted synchronized policy {}: {error}",
                    path.display()
                ),
                recovery_hint: Some(
                    "Repair or remove the unreadable persisted policy file after re-authenticating this device."
                        .to_owned(),
                ),
                details: json!({}),
            });
        }
    };
    let parsed = serde_json::from_str::<SynchronizedDevicePolicy>(&raw).map_err(|error| {
        CapabilityError {
            code: ErrorCode::ProviderFailure,
            message: format!(
                "corrupt persisted synchronized policy {}: {error}",
                path.display()
            ),
            recovery_hint: Some(
                "Remove the corrupt policy state file only after verifying expected permissions in the Control Portal."
                    .to_owned(),
            ),
            details: json!({}),
        }
    })?;
    if let Err(message) = parsed.validate_invariants() {
        return Err(CapabilityError {
            code: ErrorCode::ProviderFailure,
            message: format!(
                "invalid persisted synchronized policy {}: {message}",
                path.display()
            ),
            recovery_hint: None,
            details: json!({}),
        });
    }
    if let Some(expected) = expected_device_id
        && parsed.device_id != expected
    {
        return Err(CapabilityError {
            code: ErrorCode::ProviderFailure,
            message: format!(
                "persisted synchronized policy {} targets device '{}' instead of bound device '{expected}'",
                path.display(),
                parsed.device_id
            ),
            recovery_hint: None,
            details: json!({}),
        });
    }
    Ok(Some(parsed))
}

fn persist_synchronized_policy(
    state_dir: &Path,
    policy: &SynchronizedDevicePolicy,
) -> Result<(), CapabilityError> {
    use std::io::Write as _;

    let policy_dir = state_dir.join("policy");
    fs::create_dir_all(&policy_dir).map_err(|error| CapabilityError {
        code: ErrorCode::ProviderFailure,
        message: format!("failed to create policy state directory: {error}"),
        recovery_hint: None,
        details: json!({}),
    })?;
    let target = policy_dir.join("synchronized-policy.json");
    let temp_path = policy_dir.join(format!("synchronized-policy.json.tmp-{}", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(policy).map_err(|error| CapabilityError {
        code: ErrorCode::ProviderFailure,
        message: format!("failed to serialize synchronized policy: {error}"),
        recovery_hint: None,
        details: json!({}),
    })?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|error| CapabilityError {
            code: ErrorCode::ProviderFailure,
            message: format!("failed to open temporary policy file: {error}"),
            recovery_hint: None,
            details: json!({}),
        })?;
    if let Err(error) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
        let _ = fs::remove_file(&temp_path);
        return Err(CapabilityError {
            code: ErrorCode::ProviderFailure,
            message: format!("failed to flush synchronized policy: {error}"),
            recovery_hint: None,
            details: json!({}),
        });
    }
    drop(file);
    if let Err(error) =
        rename_with_transient_retry(&[10, 20, 40, 80, 120], || fs::rename(&temp_path, &target))
    {
        let _ = fs::remove_file(&temp_path);
        return Err(CapabilityError {
            code: ErrorCode::ProviderFailure,
            message: format!("failed to commit synchronized policy: {error}"),
            recovery_hint: None,
            details: json!({}),
        });
    }
    Ok(())
}

#[cfg(windows)]
fn is_transient_windows_os_error(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

#[cfg(not(windows))]
fn is_transient_windows_os_error(_error: &std::io::Error) -> bool {
    false
}

fn is_transient_rename_error(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::PermissionDenied || is_transient_windows_os_error(error)
}

fn rename_with_transient_retry<F>(delays_ms: &[u64], mut rename_fn: F) -> std::io::Result<()>
where
    F: FnMut() -> std::io::Result<()>,
{
    let mut attempt = 0usize;
    loop {
        match rename_fn() {
            Ok(()) => return Ok(()),
            Err(error) if is_transient_rename_error(&error) && attempt < delays_ms.len() => {
                std::thread::sleep(std::time::Duration::from_millis(delays_ms[attempt]));
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(windows)]
fn default_desktop_initializer(
    ownership: &Arc<TrustedOwnershipRegistry>,
) -> Result<Arc<DesktopProvider>, CapabilityError> {
    let provider = DesktopProvider::with_services(
        Arc::new(WindowsUiaBackend::new()?),
        Arc::clone(ownership),
        Arc::new(PrivateClipboard::new()),
        Arc::new(WindowsHumanActivityMonitor),
        Arc::new(ForegroundLeaseStore::new()),
        Arc::new(WindowsPhysicalDesktopExecutor),
    );
    Ok(Arc::new(provider))
}

#[cfg(not(windows))]
fn default_desktop_initializer(
    _ownership: &Arc<TrustedOwnershipRegistry>,
) -> Result<Arc<DesktopProvider>, CapabilityError> {
    Err(CapabilityError {
        code: ErrorCode::CapabilityUnavailable,
        message: "Windows UIA desktop provider requires a Windows host".into(),
        recovery_hint: Some(
            "Desktop UIA operations require a Windows host with the desktop provider active."
                .into(),
        ),
        details: serde_json::json!({}),
    })
}

struct DesktopCapabilityState {
    operations: Option<Vec<String>>,
    unavailable_reason: Option<String>,
}

struct DesktopComponents {
    provider: Arc<dyn CapabilityProvider>,
    capability: DesktopCapabilityState,
}

fn build_desktop_components<F>(
    ownership: &Arc<TrustedOwnershipRegistry>,
    build_desktop: F,
) -> DesktopComponents
where
    F: FnOnce(&Arc<TrustedOwnershipRegistry>) -> Result<Arc<DesktopProvider>, CapabilityError>,
{
    match build_desktop(ownership) {
        Ok(provider) => DesktopComponents {
            provider,
            capability: DesktopCapabilityState {
                operations: Some(
                    DesktopProvider::operations()
                        .iter()
                        .map(ToString::to_string)
                        .collect(),
                ),
                unavailable_reason: None,
            },
        },
        Err(error) => {
            #[cfg(windows)]
            eprintln!(
                "desktop UI Automation unavailable ({}); continuing without desktop provider",
                error.message
            );
            let reason = error.message;
            DesktopComponents {
                provider: Arc::new(UnavailableProvider::with_reason(
                    "desktop",
                    Some(reason.clone()),
                    error.recovery_hint,
                )),
                capability: DesktopCapabilityState {
                    operations: None,
                    unavailable_reason: Some(reason),
                },
            }
        }
    }
}

struct DeviceProvider {
    started: Instant,
    policy: Arc<LocalPolicyBroker>,
    job_available: bool,
    audit_available: bool,
    browser_provider: Option<Arc<BrowserProvider>>,
    desktop: DesktopCapabilityState,
}

impl DeviceProvider {
    fn new(
        policy: Arc<LocalPolicyBroker>,
        job_available: bool,
        audit_available: bool,
        browser_provider: Option<Arc<BrowserProvider>>,
        desktop: DesktopCapabilityState,
    ) -> Self {
        Self {
            started: Instant::now(),
            policy,
            job_available,
            audit_available,
            browser_provider,
            desktop,
        }
    }

    fn status(&self) -> Value {
        json!({
            "agent_version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "uptime_ms": u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "policy_mode": "background_only",
        })
    }

    fn capabilities_for(&self, principal_id: Option<&str>, device_id: Option<&str>) -> Value {
        let providers = self.provider_entries_for(principal_id, device_id);
        let tool_families = self.tool_families_summary(&providers, principal_id, device_id);

        json!({
            "providers": providers,
            "tool_families": Value::Object(tool_families),
            "effective_permissions": self.policy.effective_permissions_summary(principal_id),
        })
    }

    fn provider_entries_for(
        &self,
        principal_id: Option<&str>,
        device_id: Option<&str>,
    ) -> Vec<Value> {
        const FS_OPS: &[&str] = &[
            "read",
            "read_many",
            "list",
            "info",
            "write",
            "append",
            "mkdir",
            "move",
            "patch",
        ];
        const PROC_OPS: &[&str] = &[
            "run",
            "read",
            "input",
            "list_sessions",
            "list_system",
            "terminate",
        ];
        const JOB_OPS: &[&str] = &[
            "create",
            "get",
            "list",
            "checkpoint",
            "acquire_lease",
            "release_lease",
        ];
        let (browser_available, browser_unavailable_reason, browser_ops) =
            if let Some(browser) = &self.browser_provider {
                let report = browser.current_capability_report();
                (
                    report.available,
                    report.unavailable_reason,
                    report.operations,
                )
            } else {
                (
                    false,
                    Some("browser bridge is not configured or connected".to_owned()),
                    Vec::new(),
                )
            };
        vec![
            self.provider_entry(
                "device",
                true,
                None,
                &["status", "capabilities"],
                principal_id,
                device_id,
            ),
            self.provider_entry("filesystem", true, None, FS_OPS, principal_id, device_id),
            self.provider_entry(
                "search",
                true,
                None,
                &["start", "read", "stop", "list"],
                principal_id,
                device_id,
            ),
            self.provider_entry("process", true, None, PROC_OPS, principal_id, device_id),
            self.provider_entry("batch", true, None, &["execute"], principal_id, device_id),
            self.provider_entry(
                "job",
                self.job_available,
                (!self.job_available).then_some("durable job provider requires --state-dir"),
                if self.job_available { JOB_OPS } else { &[] },
                principal_id,
                device_id,
            ),
            self.provider_entry(
                "audit",
                self.audit_available,
                (!self.audit_available).then_some("audit store requires --state-dir"),
                if self.audit_available { &["read"] } else { &[] },
                principal_id,
                device_id,
            ),
            self.dynamic_provider_entry(
                "browser",
                browser_available,
                browser_unavailable_reason.as_deref(),
                &browser_ops,
                principal_id,
                device_id,
            ),
            self.desktop_provider_entry(principal_id, device_id),
        ]
    }

    fn desktop_provider_entry(&self, principal_id: Option<&str>, device_id: Option<&str>) -> Value {
        let available = self.desktop.operations.is_some();
        let unavailable_reason = (!available).then(|| {
            self.desktop
                .unavailable_reason
                .as_deref()
                .unwrap_or("desktop provider is unavailable")
        });
        self.dynamic_provider_entry(
            "desktop",
            available,
            unavailable_reason,
            self.desktop.operations.as_deref().unwrap_or(&[]),
            principal_id,
            device_id,
        )
    }

    fn tool_families_summary(
        &self,
        providers: &[Value],
        principal_id: Option<&str>,
        device_id: Option<&str>,
    ) -> serde_json::Map<String, Value> {
        let mut tool_families = serde_json::Map::new();
        for family in ToolFamily::ALL {
            let family_name = family.as_str();
            let matching: Vec<&Value> = providers
                .iter()
                .filter(|p| p["tool_family"].as_str() == Some(family_name))
                .collect();
            let available = matching
                .iter()
                .any(|p| p["available"].as_bool() == Some(true));
            let unavailable_reason = if available {
                Value::Null
            } else {
                matching
                    .iter()
                    .find_map(|p| p["unavailable_reason"].as_str())
                    .map_or(Value::Null, |s| Value::String(s.to_owned()))
            };
            let mut available_ops = Vec::new();
            let mut granted_ops = Vec::new();
            let mut denied_ops = Vec::new();
            for p in &matching {
                let ns = p["namespace"].as_str().unwrap_or_default();
                collect_prefixed_ops(&p["available_operations"], ns, &mut available_ops);
                collect_prefixed_ops(&p["granted_operations"], ns, &mut granted_ops);
                collect_prefixed_ops(&p["denied_operations"], ns, &mut denied_ops);
            }
            let family_probe = match family {
                ToolFamily::Device => "device.status",
                ToolFamily::Files => "filesystem.read",
                ToolFamily::Process => "process.run",
                ToolFamily::Browser => "browser.status",
                ToolFamily::Desktop => "desktop.snapshot",
                ToolFamily::Batch => "batch.execute",
            };
            let granted = !granted_ops.is_empty()
                || self
                    .policy
                    .is_capability_granted(principal_id, device_id, family_probe);
            tool_families.insert(
                family_name.to_owned(),
                json!({
                    "family": family_name,
                    "available": available,
                    "unavailable_reason": unavailable_reason,
                    "granted": granted,
                    "available_operations": available_ops,
                    "granted_operations": granted_ops,
                    "denied_operations": denied_ops,
                }),
            );
        }
        tool_families
    }

    fn provider_entry(
        &self,
        namespace: &str,
        available: bool,
        unavailable_reason: Option<&str>,
        supported: &[&str],
        principal_id: Option<&str>,
        device_id: Option<&str>,
    ) -> Value {
        let supported_strings: Vec<String> = supported.iter().map(|s| (*s).to_owned()).collect();
        self.dynamic_provider_entry(
            namespace,
            available,
            unavailable_reason,
            &supported_strings,
            principal_id,
            device_id,
        )
    }

    fn dynamic_provider_entry(
        &self,
        namespace: &str,
        available: bool,
        unavailable_reason: Option<&str>,
        supported: &[String],
        principal_id: Option<&str>,
        device_id: Option<&str>,
    ) -> Value {
        let available_operations: Vec<String> = if available {
            supported.to_vec()
        } else {
            Vec::new()
        };
        let mut granted_operations = Vec::new();
        let mut denied_operations = Vec::new();
        for op in &available_operations {
            let cap = format!("{namespace}.{op}");
            if self
                .policy
                .is_capability_granted(principal_id, device_id, &cap)
            {
                granted_operations.push(op.clone());
            } else {
                denied_operations.push(op.clone());
            }
        }
        let tool_family = tool_family_for_capability(namespace).map(ToolFamily::as_str);

        json!({
            "namespace": namespace,
            "tool_family": tool_family,
            "available": available,
            "unavailable_reason": unavailable_reason,
            "available_operations": available_operations,
            "granted_operations": granted_operations,
            "denied_operations": denied_operations,
            "operations": granted_operations,
        })
    }
}

#[async_trait]
impl CapabilityProvider for DeviceProvider {
    fn namespace(&self) -> &'static str {
        "device"
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let operation = invocation
            .capability
            .strip_prefix("device.")
            .ok_or_else(|| invalid_arguments("capability must use the device namespace"))?;

        let data = match operation {
            "status" => self.status(),
            "capabilities" => self.capabilities_for(
                invocation.principal_id.as_deref(),
                invocation.device_id.as_deref(),
            ),
            _ => {
                return Err(CapabilityError {
                    code: ErrorCode::CapabilityUnavailable,
                    message: format!("device operation is unavailable: {operation}"),
                    recovery_hint: None,
                    details: json!({ "operation": operation }),
                });
            }
        };

        Ok(ProviderResult {
            data,
            delta: None,
            verification: VerificationStatus::NotApplicable,
        })
    }
}

struct UnavailableProvider {
    namespace: &'static str,
    reason: Option<String>,
    recovery_hint: Option<String>,
}

impl UnavailableProvider {
    const fn new(namespace: &'static str) -> Self {
        Self {
            namespace,
            reason: None,
            recovery_hint: None,
        }
    }

    const fn with_reason(
        namespace: &'static str,
        reason: Option<String>,
        recovery_hint: Option<String>,
    ) -> Self {
        Self {
            namespace,
            reason,
            recovery_hint,
        }
    }
}

#[async_trait]
impl CapabilityProvider for UnavailableProvider {
    fn namespace(&self) -> &'static str {
        self.namespace
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let recovery_hint = self.recovery_hint.clone().or_else(|| match self.namespace {
            "browser" => Some(
                "Ensure the Tetherplane browser bridge or extension host is running on this device."
                    .to_owned(),
            ),
            "desktop" => Some(
                "Desktop UIA operations require an active interactive desktop session with the desktop provider active."
                    .to_owned(),
            ),
            _ => None,
        });
        let message = self.reason.as_deref().map_or_else(
            || format!("{} provider is not installed", self.namespace),
            |reason| format!("{} provider is unavailable: {reason}", self.namespace),
        );
        Err(CapabilityError {
            code: ErrorCode::CapabilityUnavailable,
            message,
            recovery_hint,
            details: json!({
                "namespace": self.namespace,
                "capability": invocation.capability,
                "available": false,
                "unavailable_reason": self.reason,
            }),
        })
    }
}

fn collect_prefixed_ops(list: &Value, namespace: &str, out: &mut Vec<String>) {
    if let Some(arr) = list.as_array() {
        for op in arr.iter().filter_map(Value::as_str) {
            out.push(format!("{namespace}.{op}"));
        }
    }
}

fn invalid_arguments(message: &str) -> CapabilityError {
    invalid_arguments_with_details(message, serde_json::json!({}))
}

fn invalid_arguments_with_details(message: &str, details: Value) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
        details,
    }
}

#[cfg(test)]
mod tests {
    use super::AgentRuntime;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use tether_core::{
        Actor, ActorKind, InvocationEnvelope, ResponseMode, ResultStatus, SynchronizedDevicePolicy,
        ToolFamily,
    };
    use uuid::Uuid;

    struct TempStateDir(PathBuf);

    impl TempStateDir {
        fn create() -> Self {
            let dir = std::env::temp_dir().join(format!("tether-runtime-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempStateDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn owner_device_status_invocation(device_id: &str) -> InvocationEnvelope {
        platform_echo_invocation(device_id)
    }

    #[tokio::test]
    async fn stale_or_conflicting_policy_revisions_are_rejected_and_cannot_restore_revoked_access()
    {
        let state = TempStateDir::create();
        let runtime = AgentRuntime::new(vec![state.0.clone()], None, Some(&state.0), None).unwrap();

        let rev1_universal =
            SynchronizedDevicePolicy::universal_for_owner("Leno", "account-a", "human:account-a");
        runtime
            .apply_synchronized_policy(rev1_universal.clone())
            .expect("initial rev 1 policy applies");
        assert_eq!(runtime.applied_policy_revision(), 1);

        let mut rev2_revoked = rev1_universal.clone();
        rev2_revoked.revision = 2;
        rev2_revoked
            .owner_policy
            .allowed_families
            .remove(&ToolFamily::Process);
        rev2_revoked
            .owner_policy
            .denied_families
            .insert(ToolFamily::Process);
        rev2_revoked.owner_policy.universal_permissions = false;
        runtime
            .apply_synchronized_policy(rev2_revoked.clone())
            .expect("rev 2 revocation applies");
        assert_eq!(runtime.applied_policy_revision(), 2);

        // Stale rev 1 universal policy MUST be rejected and must NOT restore process family access
        let stale_err = runtime
            .apply_synchronized_policy(rev1_universal.clone())
            .expect_err("stale revision 1 policy_sync must be rejected");
        assert!(
            stale_err.message.to_ascii_lowercase().contains("revision"),
            "expected revision error, got: {}",
            stale_err.message
        );
        assert_eq!(runtime.applied_policy_revision(), 2);

        // Conflicting same-revision (rev 2 with restored universal permissions) MUST also be rejected
        let mut conflicting_rev2 = rev1_universal;
        conflicting_rev2.revision = 2;
        assert!(
            runtime.apply_synchronized_policy(conflicting_rev2).is_err(),
            "conflicting policy at current revision 2 must be rejected"
        );
        assert_eq!(runtime.applied_policy_revision(), 2);

        // Identical rev 2 push should be idempotent
        runtime
            .apply_synchronized_policy(rev2_revoked)
            .expect("idempotent identical rev 2 re-delivery should succeed");

        // Invoking revoked process family remains denied
        let result = runtime
            .execute(owner_device_status_invocation("Leno"))
            .await;
        assert_eq!(result.status, ResultStatus::Error);
        assert_eq!(
            result.error.unwrap().code,
            tether_core::ErrorCode::PermissionDenied
        );

        // Restarting from state_dir preserves rev 2 and continues rejecting rev 1
        let restarted =
            AgentRuntime::new(vec![state.0.clone()], None, Some(&state.0), None).unwrap();
        assert_eq!(restarted.applied_policy_revision(), 2);
        let zero_rev = {
            let mut p = SynchronizedDevicePolicy::universal_for_owner(
                "Leno",
                "account-a",
                "human:account-a",
            );
            p.revision = 0;
            p
        };
        assert!(restarted.apply_synchronized_policy(zero_rev).is_err());
    }

    #[tokio::test]
    async fn device_capabilities_reflect_live_browser_standby_and_recovery() {
        use std::sync::Arc;
        use std::time::Duration;
        use tether_browser_provider::{BrowserBridgeConfig, BrowserProvider};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::TcpListener;

        let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = reservation.local_addr().unwrap();
        drop(reservation);

        let browser = Arc::new(
            BrowserProvider::new_reconnectable(BrowserBridgeConfig {
                address: address.to_string(),
                token: None,
                timeout_ms: 250,
            })
            .unwrap(),
        );
        let state = TempStateDir::create();
        let runtime =
            AgentRuntime::new(vec![state.0.clone()], None, Some(&state.0), Some(browser)).unwrap();

        let standby_caps = runtime.device_capabilities(None, Some("Leno"));
        let standby_browser_family = &standby_caps["tool_families"]["browser"];
        assert_eq!(standby_browser_family["available"], false);
        assert_eq!(standby_browser_family["available_operations"], json!([]));

        let listener = TcpListener::bind(address).await.unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            let req: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            let resp = json!({
                "request_id": req["request_id"],
                "status": "success",
                "data": {
                    "available": true,
                    "mode": "background_only",
                    "capabilities": { "backend": "extension", "connected": true, "status": "ready", "operations": ["status", "pages"] }
                },
                "verification": "not_applicable"
            });
            write
                .write_all(format!("{resp}\n").as_bytes())
                .await
                .unwrap();
        });

        let changed = tokio::time::timeout(
            Duration::from_secs(2),
            runtime.refresh_browser_availability(),
        )
        .await
        .unwrap();
        assert!(changed);
        server.await.unwrap();

        let live_caps = runtime.device_capabilities(None, Some("Leno"));
        let live_browser_family = &live_caps["tool_families"]["browser"];
        assert_eq!(live_browser_family["available"], true);
        let ops = live_browser_family["available_operations"]
            .as_array()
            .expect("available_operations array");
        assert!(ops.contains(&json!("browser.status")));
        assert!(ops.contains(&json!("browser.pages")));
        assert_eq!(
            ops.len(),
            2,
            "a ready bridge must not imply every RPC operation"
        );
    }

    fn platform_echo_invocation(device_id: &str) -> InvocationEnvelope {
        #[cfg(windows)]
        let arguments = json!({ "program": "cmd.exe", "args": ["/C", "echo ok"] });
        #[cfg(not(windows))]
        let arguments = json!({ "program": "/bin/sh", "args": ["-c", "echo ok"] });

        InvocationEnvelope {
            protocol_version: "1.0".into(),
            request_id: Uuid::new_v4(),
            device_id: Some(device_id.into()),
            principal_id: Some("human:account-a".into()),
            job_id: None,
            capability: "process.run".into(),
            arguments,
            actor: Actor {
                id: "owner".into(),
                kind: ActorKind::Human,
            },
            session_id: None,
            response_mode: ResponseMode::Compact,
            idempotency_key: None,
            preconditions: vec![],
            expectations: vec![],
        }
    }

    #[tokio::test]
    async fn unavailable_desktop_provider_does_not_block_runtime_capabilities_or_policy_sync() {
        use std::sync::Arc;
        use std::time::Duration;
        use tether_browser_provider::{BrowserBridgeConfig, BrowserProvider};
        use tether_core::{CapabilityError, ErrorCode};
        use tokio::net::TcpListener;

        let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = reservation.local_addr().unwrap();
        drop(reservation);

        let browser = Arc::new(
            BrowserProvider::new_reconnectable(BrowserBridgeConfig {
                address: address.to_string(),
                token: None,
                timeout_ms: 250,
            })
            .unwrap(),
        );
        let state = TempStateDir::create();

        // Simulate headless / unavailable Windows UI Automation failure without aborting runtime startup.
        let runtime = AgentRuntime::new_with_desktop_init(
            vec![state.0.clone()],
            None,
            Some(&state.0),
            Some(browser),
            Some("Leno"),
            |_ownership| {
                Err(CapabilityError {
                    code: ErrorCode::ProviderFailure,
                    message: "Windows UI Automation provider error: Unspecified error".into(),
                    recovery_hint: None,
                    details: json!({}),
                })
            },
        )
        .expect("runtime must still initialize when desktop UI Automation is unavailable");

        // 1. Device status still works
        let status = runtime.device_status();
        assert_eq!(status["policy_mode"], "background_only");

        // 2. Desktop provider & tool_family report exact unavailable state with empty ops and preserved reason
        let expected_reason = "Windows UI Automation provider error: Unspecified error";
        assert_desktop_unavailable_telemetry(
            &runtime.device_capabilities(Some("human:account-a"), Some("Leno")),
            expected_reason,
        );

        // 3. Policy sync applies universal policy (rev 1) and enforces monotonic revisions
        let rev1_universal =
            SynchronizedDevicePolicy::universal_for_owner("Leno", "account-a", "human:account-a");
        runtime
            .apply_synchronized_policy(rev1_universal.clone())
            .expect("rev 1 universal policy should apply without desktop");
        assert_eq!(runtime.applied_policy_revision(), 1);

        // 4. Process execution works under universal permissions
        let proc_ok = runtime.execute(platform_echo_invocation("Leno")).await;
        assert_eq!(proc_ok.status, ResultStatus::Success);

        // 5. Invoking desktop when allowed by policy returns capability_unavailable preserving the UIA failure
        let mut desktop_invoke = platform_echo_invocation("Leno");
        desktop_invoke.capability = "desktop.snapshot".into();
        desktop_invoke.arguments = json!({});
        let desktop_unavail = runtime.execute(desktop_invoke.clone()).await;
        assert_eq!(desktop_unavail.status, ResultStatus::Error);
        let unavail_err = desktop_unavail.error.unwrap();
        assert_eq!(unavail_err.code, ErrorCode::CapabilityUnavailable);
        assert!(
            unavail_err.message.contains(expected_reason),
            "unexpected unavailable message: {}",
            unavail_err.message
        );

        // 6. Browser standby -> live availability recovery still operates without desktop
        let server = spawn_browser_ready_probe_server(TcpListener::bind(address).await.unwrap());
        let changed = tokio::time::timeout(
            Duration::from_secs(2),
            runtime.refresh_browser_availability(),
        )
        .await
        .unwrap();
        assert!(changed);
        server.await.unwrap();
        let live_caps = runtime.device_capabilities(Some("human:account-a"), Some("Leno"));
        assert_eq!(live_caps["tool_families"]["browser"]["available"], true);
        assert_eq!(live_caps["tool_families"]["desktop"]["available"], false);

        // 7. Revoking desktop & process via rev 2 enforces permission_denied even on unavailable desktop
        let rev2_revoked = revoked_policy_revision(
            &rev1_universal,
            2,
            &[ToolFamily::Process, ToolFamily::Desktop],
        );
        runtime
            .apply_synchronized_policy(rev2_revoked)
            .expect("rev 2 should apply");
        assert!(runtime.apply_synchronized_policy(rev1_universal).is_err());

        let denied_desktop = runtime.execute(desktop_invoke).await;
        assert_eq!(denied_desktop.status, ResultStatus::Error);
        assert_eq!(
            denied_desktop.error.unwrap().code,
            ErrorCode::PermissionDenied
        );

        let denied_proc = runtime.execute(platform_echo_invocation("Leno")).await;
        assert_eq!(denied_proc.status, ResultStatus::Error);
        assert_eq!(denied_proc.error.unwrap().code, ErrorCode::PermissionDenied);
    }

    fn revoked_policy_revision(
        base: &SynchronizedDevicePolicy,
        revision: u64,
        revoked: &[ToolFamily],
    ) -> SynchronizedDevicePolicy {
        let mut next = base.clone();
        next.revision = revision;
        next.owner_policy.universal_permissions = false;
        for family in revoked {
            next.owner_policy.allowed_families.remove(family);
            next.owner_policy.denied_families.insert(*family);
        }
        next
    }

    fn assert_desktop_unavailable_telemetry(caps: &serde_json::Value, expected_reason: &str) {
        let desktop_provider = caps["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["namespace"] == "desktop")
            .expect("desktop provider entry");
        assert_eq!(desktop_provider["available"], false);
        assert_eq!(desktop_provider["unavailable_reason"], expected_reason);
        assert_eq!(desktop_provider["available_operations"], json!([]));
        assert_eq!(desktop_provider["granted_operations"], json!([]));
        assert_eq!(desktop_provider["denied_operations"], json!([]));
        assert_eq!(desktop_provider["operations"], json!([]));

        let desktop_family = &caps["tool_families"]["desktop"];
        assert_eq!(desktop_family["available"], false);
        assert_eq!(desktop_family["unavailable_reason"], expected_reason);
        assert_eq!(desktop_family["available_operations"], json!([]));
        assert_eq!(desktop_family["granted_operations"], json!([]));
    }

    fn spawn_browser_ready_probe_server(
        listener: tokio::net::TcpListener,
    ) -> tokio::task::JoinHandle<()> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            let req: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            let resp = json!({
                "request_id": req["request_id"],
                "status": "success",
                "data": {
                    "available": true,
                    "mode": "background_only",
                    "capabilities": { "backend": "extension", "connected": true, "status": "ready" }
                },
                "verification": "not_applicable"
            });
            write
                .write_all(format!("{resp}\n").as_bytes())
                .await
                .unwrap();
        })
    }

    #[tokio::test]
    async fn available_desktop_provider_reports_canonical_desktop_operations() {
        use std::sync::Arc;
        use tether_core::CapabilityError;
        use tether_desktop_provider::{
            DesktopAction, DesktopActionOutcome, DesktopBackend, DesktopNode, DesktopProvider,
        };

        struct StubDesktopBackend;

        impl DesktopBackend for StubDesktopBackend {
            fn snapshot(&self) -> Result<Vec<DesktopNode>, CapabilityError> {
                Ok(Vec::new())
            }

            fn target(&self, reference: &str) -> Result<DesktopNode, CapabilityError> {
                Err(CapabilityError {
                    code: tether_core::ErrorCode::StaleReference,
                    message: format!("missing stub desktop target: {reference}"),
                    recovery_hint: None,
                    details: json!({}),
                })
            }

            fn perform(
                &self,
                _action: DesktopAction,
            ) -> Result<DesktopActionOutcome, CapabilityError> {
                Err(CapabilityError {
                    code: tether_core::ErrorCode::CapabilityUnavailable,
                    message: "stub desktop backend action unsupported".into(),
                    recovery_hint: None,
                    details: json!({}),
                })
            }
        }

        let state = TempStateDir::create();
        let runtime = AgentRuntime::new_with_desktop_init(
            vec![state.0.clone()],
            None,
            Some(&state.0),
            None,
            Some("Leno"),
            |ownership| {
                Ok(Arc::new(DesktopProvider::new(
                    Arc::new(StubDesktopBackend),
                    Arc::clone(ownership),
                )))
            },
        )
        .expect("runtime with available desktop backend initializes cleanly");

        let caps = runtime.device_capabilities(Some("human:account-a"), Some("Leno"));
        let desktop_provider = caps["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["namespace"] == "desktop")
            .unwrap();
        assert_eq!(desktop_provider["available"], true);
        assert_eq!(
            desktop_provider["unavailable_reason"],
            serde_json::Value::Null
        );
        let ops = desktop_provider["available_operations"].as_array().unwrap();
        assert!(ops.contains(&json!("snapshot")));
        assert!(ops.contains(&json!("act")));

        let desktop_family = &caps["tool_families"]["desktop"];
        assert_eq!(desktop_family["available"], true);
        assert_eq!(
            desktop_family["unavailable_reason"],
            serde_json::Value::Null
        );
        assert!(
            desktop_family["available_operations"]
                .as_array()
                .unwrap()
                .contains(&json!("desktop.snapshot"))
        );

        let mut desktop_invoke = platform_echo_invocation("Leno");
        desktop_invoke.capability = "desktop.snapshot".into();
        desktop_invoke.arguments = json!({});
        let snap = runtime.execute(desktop_invoke).await;
        assert_eq!(snap.status, ResultStatus::Success);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn real_windows_uia_default_runtime_reports_available_desktop_in_interactive_session() {
        let state = TempStateDir::create();
        let runtime = AgentRuntime::new_with_device(
            vec![state.0.clone()],
            None,
            Some(&state.0),
            None,
            Some("Leno"),
        )
        .expect("default Windows AgentRuntime initializes cleanly");

        let caps = runtime.device_capabilities(Some("human:account-a"), Some("Leno"));
        let desktop_provider = caps["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["namespace"] == "desktop")
            .unwrap();
        assert_eq!(
            desktop_provider["available"], true,
            "interactive Windows host should expose real UIA desktop provider; reason={:?}",
            desktop_provider["unavailable_reason"]
        );
        assert_eq!(
            desktop_provider["unavailable_reason"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn corrupt_or_untrusted_persisted_policy_fails_closed_at_runtime_startup() {
        let corrupt_state = TempStateDir::create();
        let policy_dir = corrupt_state.0.join("policy");
        fs::create_dir_all(&policy_dir).unwrap();
        fs::write(
            policy_dir.join("synchronized-policy.json"),
            "{not-valid-json",
        )
        .unwrap();

        let Err(err) = AgentRuntime::new_with_device(
            vec![corrupt_state.0.clone()],
            None,
            Some(&corrupt_state.0),
            None,
            Some("Leno"),
        ) else {
            panic!("corrupt synchronized-policy.json must fail closed");
        };
        assert!(
            err.message.to_lowercase().contains("corrupt")
                || err.message.to_lowercase().contains("policy"),
            "unexpected error: {}",
            err.message
        );

        let mismatch_state = TempStateDir::create();
        let mismatch_dir = mismatch_state.0.join("policy");
        fs::create_dir_all(&mismatch_dir).unwrap();
        let wrong_device_policy = SynchronizedDevicePolicy::universal_for_owner(
            "OtherDevice",
            "account-a",
            "human:account-a",
        );
        fs::write(
            mismatch_dir.join("synchronized-policy.json"),
            serde_json::to_vec(&wrong_device_policy).unwrap(),
        )
        .unwrap();

        assert!(
            AgentRuntime::new_with_device(
                vec![mismatch_state.0.clone()],
                None,
                Some(&mismatch_state.0),
                None,
                Some("Leno"),
            )
            .is_err(),
            "persisted policy for a different device must fail closed"
        );
    }

    #[test]
    fn synchronized_policy_rejects_non_owner_prefixes_and_operator_owner_collisions() {
        let state = TempStateDir::create();
        let runtime = AgentRuntime::new_with_device(
            vec![state.0.clone()],
            None,
            Some(&state.0),
            None,
            Some("Leno"),
        )
        .unwrap();

        let non_owner_prefix =
            SynchronizedDevicePolicy::universal_for_owner("Leno", "account-a", "service:ci");
        assert!(runtime.apply_synchronized_policy(non_owner_prefix).is_err());

        let mut collision =
            SynchronizedDevicePolicy::universal_for_owner("Leno", "account-a", "human:account-a");
        collision.operator_policies.insert(
            "human:account-a".to_owned(),
            tether_core::PrincipalPermissionSet {
                principal_id: "human:account-a".to_owned(),
                role: tether_core::PrincipalRole::Operator,
                profile_id: "lockdown".to_owned(),
                universal_permissions: false,
                allowed_families: std::collections::BTreeSet::new(),
                denied_families: ToolFamily::all_set(),
                allowed_capabilities: std::collections::BTreeSet::new(),
                denied_capabilities: std::collections::BTreeSet::new(),
                allowed_roots: vec![],
                allow_destructive: false,
            },
        );
        assert!(runtime.apply_synchronized_policy(collision).is_err());

        let mut escalated =
            SynchronizedDevicePolicy::universal_for_owner("Leno", "account-a", "human:account-a");
        escalated.operator_policies.insert(
            "operator:evil".to_owned(),
            tether_core::PrincipalPermissionSet {
                principal_id: "operator:evil".to_owned(),
                role: tether_core::PrincipalRole::Owner,
                profile_id: "universal".to_owned(),
                universal_permissions: true,
                allowed_families: ToolFamily::all_set(),
                denied_families: std::collections::BTreeSet::new(),
                allowed_capabilities: std::collections::BTreeSet::new(),
                denied_capabilities: std::collections::BTreeSet::new(),
                allowed_roots: vec![],
                allow_destructive: true,
            },
        );
        assert!(runtime.apply_synchronized_policy(escalated).is_err());
    }

    #[test]
    fn transient_windows_rename_retries_before_succeeding_and_does_not_retry_fatal_errors() {
        let mut attempts = 0usize;
        let result = super::rename_with_transient_retry(&[1, 1, 1], || {
            attempts += 1;
            if attempts < 3 {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "simulated Windows sharing/lock error",
                ))
            } else {
                Ok(())
            }
        });
        assert!(
            result.is_ok(),
            "transient PermissionDenied should retry and succeed"
        );
        assert_eq!(attempts, 3);

        let mut fatal_attempts = 0usize;
        let fatal = super::rename_with_transient_retry(&[1, 1, 1], || {
            fatal_attempts += 1;
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "missing file is not transient",
            ))
        });
        assert!(fatal.is_err());
        assert_eq!(fatal_attempts, 1);

        let mut raw_attempts = 0usize;
        let raw_result = super::rename_with_transient_retry(&[1, 1, 1], || {
            raw_attempts += 1;
            if raw_attempts < 3 {
                Err(std::io::Error::from_raw_os_error(32))
            } else {
                Ok(())
            }
        });
        #[cfg(windows)]
        {
            assert!(
                raw_result.is_ok(),
                "Windows ERROR_SHARING_VIOLATION (32) should retry and succeed"
            );
            assert_eq!(raw_attempts, 3);
        }
        #[cfg(not(windows))]
        {
            assert!(
                raw_result.is_err(),
                "POSIX EPIPE (32) must not be treated as a transient Windows lock"
            );
            assert_eq!(raw_attempts, 1);
        }
    }
}
