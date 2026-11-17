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
        mut allowed_roots: Vec<PathBuf>,
        principal: Option<PrincipalProfile>,
        state_dir: Option<&Path>,
        browser_provider: Option<Arc<BrowserProvider>>,
        bound_device_id: Option<&str>,
    ) -> Result<Self, CapabilityError> {
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
            && let Some(persisted) = load_persisted_policy(dir, bound_device_id.as_deref())
        {
            policy.set_synchronized_policy(Some(persisted));
        }

        let mut router = CapabilityRouter::with_policy(Arc::clone(&policy) as Arc<_>);
        let ownership = Arc::new(TrustedOwnershipRegistry::new());
        #[cfg(windows)]
        let desktop_provider = create_desktop_provider(Arc::clone(&ownership))?;
        #[cfg(not(windows))]
        let desktop_provider = create_desktop_provider(&ownership);
        let desktop_operations: Option<Vec<String>> = desktop_provider.as_ref().map(|_| {
            DesktopProvider::operations()
                .iter()
                .map(ToString::to_string)
                .collect()
        });

        let device_provider = Arc::new(DeviceProvider::new(
            Arc::clone(&policy),
            job_available,
            audit_available,
            browser_provider.clone(),
            desktop_operations,
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
        if let Some(desktop_provider) = desktop_provider {
            router.register(desktop_provider)?;
        } else {
            router.register(Arc::new(UnavailableProvider::new("desktop")))?;
        }

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
        let previous = browser.current_availability();
        let next = browser.probe_status().await;
        previous != next
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

        if revision == 0 {
            return Err(invalid_arguments_with_details(
                "policy_sync revision must be >= 1",
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
) -> Option<SynchronizedDevicePolicy> {
    let path = state_dir.join("policy").join("synchronized-policy.json");
    let raw = fs::read_to_string(path).ok()?;
    let parsed = serde_json::from_str::<SynchronizedDevicePolicy>(&raw).ok()?;
    if parsed.revision == 0 {
        return None;
    }
    if expected_device_id.is_some_and(|expected| parsed.device_id != expected) {
        return None;
    }
    Some(parsed)
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
    if let Err(error) = fs::rename(&temp_path, &target) {
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
fn create_desktop_provider(
    ownership: Arc<TrustedOwnershipRegistry>,
) -> Result<Option<Arc<DesktopProvider>>, CapabilityError> {
    let provider = DesktopProvider::with_services(
        Arc::new(WindowsUiaBackend::new()?),
        ownership,
        Arc::new(PrivateClipboard::new()),
        Arc::new(WindowsHumanActivityMonitor),
        Arc::new(ForegroundLeaseStore::new()),
        Arc::new(WindowsPhysicalDesktopExecutor),
    );
    Ok(Some(Arc::new(provider)))
}

#[cfg(not(windows))]
fn create_desktop_provider(
    _ownership: &Arc<TrustedOwnershipRegistry>,
) -> Option<Arc<DesktopProvider>> {
    None
}

struct DeviceProvider {
    started: Instant,
    policy: Arc<LocalPolicyBroker>,
    job_available: bool,
    audit_available: bool,
    browser_provider: Option<Arc<BrowserProvider>>,
    desktop_operations: Option<Vec<String>>,
}

impl DeviceProvider {
    fn new(
        policy: Arc<LocalPolicyBroker>,
        job_available: bool,
        audit_available: bool,
        browser_provider: Option<Arc<BrowserProvider>>,
        desktop_operations: Option<Vec<String>>,
    ) -> Self {
        Self {
            started: Instant::now(),
            policy,
            job_available,
            audit_available,
            browser_provider,
            desktop_operations,
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
        let (browser_available, browser_unavailable_reason, browser_ops): (
            bool,
            Option<String>,
            &[String],
        ) = if let Some(browser) = &self.browser_provider {
            let (available, reason) = browser.current_availability();
            (available, reason, browser.operations())
        } else {
            (
                false,
                Some("browser bridge is not configured or connected".to_owned()),
                &[],
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
                browser_ops,
                principal_id,
                device_id,
            ),
            self.dynamic_provider_entry(
                "desktop",
                self.desktop_operations.is_some(),
                self.desktop_operations
                    .is_none()
                    .then_some("Windows UIA desktop provider requires a Windows host"),
                self.desktop_operations.as_deref().unwrap_or(&[]),
                principal_id,
                device_id,
            ),
        ]
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
}

impl UnavailableProvider {
    const fn new(namespace: &'static str) -> Self {
        Self { namespace }
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
        let recovery_hint = match self.namespace {
            "browser" => Some(
                "Ensure the Tetherplane browser bridge or extension host is running on this device."
                    .to_owned(),
            ),
            "desktop" => Some(
                "Desktop UIA operations require a Windows host with the desktop provider active."
                    .to_owned(),
            ),
            _ => None,
        };
        Err(CapabilityError {
            code: ErrorCode::CapabilityUnavailable,
            message: format!("{} provider is not installed", self.namespace),
            recovery_hint,
            details: json!({
                "namespace": self.namespace,
                "capability": invocation.capability,
                "available": false,
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
        InvocationEnvelope {
            protocol_version: "1.0".into(),
            request_id: Uuid::new_v4(),
            device_id: Some(device_id.into()),
            principal_id: Some("human:account-a".into()),
            job_id: None,
            capability: "process.run".into(),
            arguments: json!({ "program": "/bin/sh", "args": ["-c", "echo ok"] }),
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
                    "capabilities": { "backend": "extension", "connected": true, "status": "ready" }
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
    }
}
