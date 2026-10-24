use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{Value, json};
use tether_browser_provider::BrowserProvider;
use tether_core::{
    CapabilityError, CapabilityProvider, CapabilityRouter, ErrorCode, InvocationEnvelope,
    LocalPolicyBroker, LocalPolicyConfig, PrincipalProfile, ProviderResult, ResultEnvelope,
    TrustedOwnershipRegistry, VerificationStatus,
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

use crate::audit::{AuditProvider, AuditStore};
use crate::idempotency::{
    IdempotencyLookup, IdempotencyStore, MutationPhase, completion_unverified_result,
    conflict_result, is_mutation_capability, pending_result, store_failure_result,
    unavailable_result,
};
use crate::job::JobProvider;

pub struct AgentRuntime {
    router: CapabilityRouter,
    bound_principal_id: Option<String>,
    audit_store: Option<Arc<AuditStore>>,
    idempotency_store: Option<Arc<Mutex<IdempotencyStore>>>,
}

impl AgentRuntime {
    pub fn new(
        mut allowed_roots: Vec<PathBuf>,
        principal: Option<PrincipalProfile>,
        state_dir: Option<&Path>,
        browser_provider: Option<Arc<BrowserProvider>>,
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
        let principal_capabilities = principal
            .as_ref()
            .map(|profile| profile.allowed_capabilities.clone());
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
        let mut router = CapabilityRouter::with_policy(policy);
        let ownership = Arc::new(TrustedOwnershipRegistry::new());
        #[cfg(windows)]
        let desktop_provider = create_desktop_provider(Arc::clone(&ownership))?;
        #[cfg(not(windows))]
        let desktop_provider = create_desktop_provider(&ownership);
        let desktop_operations = desktop_provider.as_ref().map(|_| {
            DesktopProvider::operations()
                .iter()
                .map(ToString::to_string)
                .collect()
        });

        router.register(Arc::new(DeviceProvider::new(
            principal_capabilities,
            job_available,
            audit_available,
            browser_provider.as_ref().map(Arc::clone),
            desktop_operations,
        )))?;
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
        if let Some(browser_provider) = browser_provider {
            router.register(browser_provider)?;
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
            bound_principal_id,
            audit_store,
            idempotency_store,
        })
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
        let existing = {
            let guard = store.lock().await;
            match guard.lookup(&invocation) {
                Ok(IdempotencyLookup::Replay(result)) => return *result,
                Ok(IdempotencyLookup::Conflict) => return conflict_result(&invocation),
                Ok(IdempotencyLookup::Pending) => true,
                Ok(IdempotencyLookup::Miss) => {
                    if let Err(error) = guard.reserve(&invocation) {
                        return store_failure_result(&invocation, error);
                    }
                    if let Err(error) = guard.mark_running(&invocation) {
                        return store_failure_result(&invocation, error);
                    }
                    false
                }
                Err(error) => return store_failure_result(&invocation, error),
            }
        };
        if existing {
            return Self::await_existing_idempotent_result(store, &invocation).await;
        }

        // Never hold the shared bookkeeping lock while the effect is running.
        let result = self.router.execute(invocation.clone()).await;
        let guard = store.lock().await;
        if let Err(error) = guard.complete(&invocation, &result) {
            eprintln!(
                "idempotency completion persistence failed: {}",
                error.message
            );
            return completion_unverified_result(&invocation);
        }
        result
    }

    fn pending_with_phase(
        store: &IdempotencyStore,
        invocation: &InvocationEnvelope,
    ) -> ResultEnvelope {
        let mut result = pending_result(invocation);
        if let (Some(error), Ok(Some(phase))) =
            (result.error.as_mut(), store.operation_phase(invocation))
        {
            error.details["operation_phase"] = json!(phase);
        }
        result
    }

    async fn await_existing_idempotent_result(
        store: &Arc<Mutex<IdempotencyStore>>,
        invocation: &InvocationEnvelope,
    ) -> ResultEnvelope {
        // Concurrent identical callers may observe the first authoritative
        // completion, but never trigger a duplicate execution. Long or old
        // unfinished reservations fail closed instead of blocking forever.
        let deadline = tokio::time::Instant::now() + Duration::from_millis(1_200);
        loop {
            {
                let guard = store.lock().await;
                match guard.lookup(invocation) {
                    Ok(IdempotencyLookup::Replay(result)) => return *result,
                    Ok(IdempotencyLookup::Conflict) => return conflict_result(invocation),
                    Ok(IdempotencyLookup::Pending) => {
                        let phase = guard.operation_phase(invocation);
                        if matches!(phase, Ok(Some(MutationPhase::ReconciliationRequired)))
                            || tokio::time::Instant::now() >= deadline
                        {
                            return Self::pending_with_phase(&guard, invocation);
                        }
                    }
                    Ok(IdempotencyLookup::Miss) => {
                        return Self::pending_with_phase(&guard, invocation);
                    }
                    Err(error) => return store_failure_result(invocation, error),
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
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
    allowed_capabilities: Option<BTreeSet<String>>,
    job_available: bool,
    audit_available: bool,
    browser_provider: Option<Arc<BrowserProvider>>,
    desktop_operations: Option<Vec<String>>,
}

impl DeviceProvider {
    fn new(
        allowed_capabilities: Option<BTreeSet<String>>,
        job_available: bool,
        audit_available: bool,
        browser_provider: Option<Arc<BrowserProvider>>,
        desktop_operations: Option<Vec<String>>,
    ) -> Self {
        Self {
            started: Instant::now(),
            allowed_capabilities,
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

    async fn capabilities(&self) -> Value {
        // Each discovery is independently authenticated; never return stale browser
        // availability after the extension disconnects or before it is paired.
        let browser_operations = match &self.browser_provider {
            Some(provider) => provider.discover_operations().await.ok(),
            None => None,
        };
        json!({
            "providers": [
                { "namespace": "device", "available": true, "operations": self.operations("device", &["status", "capabilities"]) },
                { "namespace": "filesystem", "available": true, "operations": self.operations("filesystem", &["read", "read_many", "list", "info", "write", "append", "mkdir", "move", "patch"]) },
                { "namespace": "search", "available": true, "operations": self.operations("search", &["start", "read", "stop", "list"]) },
                { "namespace": "process", "available": true, "operations": self.operations("process", &["run", "read", "input", "list_sessions", "list_system", "terminate"]) },
                { "namespace": "batch", "available": true, "operations": self.operations("batch", &["execute"]) },
                { "namespace": "job", "available": self.job_available, "operations": if self.job_available { self.operations("job", &["create", "get", "checkpoint", "acquire_lease", "release_lease"]) } else { Vec::<String>::new() } },
                { "namespace": "audit", "available": self.audit_available, "operations": if self.audit_available { self.operations("audit", &["read"]) } else { Vec::<String>::new() } },
                { "namespace": "browser", "available": browser_operations.is_some(), "operations": self.browser_operations(browser_operations.as_deref()) },
                { "namespace": "desktop", "available": self.desktop_operations.is_some(), "operations": self.desktop_operations() }
            ]
        })
    }

    fn operations(&self, namespace: &str, operations: &[&str]) -> Vec<String> {
        operations
            .iter()
            .filter(|operation| {
                self.allowed_capabilities
                    .as_ref()
                    .is_none_or(|allowed| allowed.contains(&format!("{namespace}.{operation}")))
            })
            .map(|operation| (*operation).to_owned())
            .collect()
    }

    fn browser_operations(&self, advertised: Option<&[String]>) -> Vec<String> {
        advertised
            .into_iter()
            .flatten()
            .filter(|operation| {
                self.allowed_capabilities
                    .as_ref()
                    .is_none_or(|allowed| allowed.contains(&format!("browser.{operation}")))
            })
            .cloned()
            .collect()
    }

    fn desktop_operations(&self) -> Vec<String> {
        self.desktop_operations
            .as_ref()
            .into_iter()
            .flatten()
            .filter(|operation| {
                self.allowed_capabilities
                    .as_ref()
                    .is_none_or(|allowed| allowed.contains(&format!("desktop.{operation}")))
            })
            .cloned()
            .collect()
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
            "capabilities" => self.capabilities().await,
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
        Err(CapabilityError {
            code: ErrorCode::CapabilityUnavailable,
            message: format!("{} provider is not installed", self.namespace),
            recovery_hint: None,
            details: json!({
                "namespace": self.namespace,
                "capability": invocation.capability,
                "available": false,
            }),
        })
    }
}

fn invalid_arguments(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::{AgentRuntime, IdempotencyStore};
    use async_trait::async_trait;
    use serde_json::{Value, json};
    use std::path::Path;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tether_core::{
        CapabilityError, CapabilityProvider, CapabilityRouter, ErrorCode, InvocationEnvelope,
        ProviderResult, ResultStatus, VerificationStatus,
    };
    use tokio::sync::{Barrier, Mutex};

    struct HeldEffect {
        entered: Barrier,
        release: Barrier,
        executions: AtomicUsize,
    }

    impl HeldEffect {
        fn new() -> Self {
            Self {
                entered: Barrier::new(2),
                release: Barrier::new(2),
                executions: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl CapabilityProvider for HeldEffect {
        fn namespace(&self) -> &'static str {
            "filesystem"
        }

        async fn execute(
            &self,
            invocation: &InvocationEnvelope,
        ) -> Result<ProviderResult, CapabilityError> {
            self.executions.fetch_add(1, Ordering::SeqCst);
            if invocation.arguments["held"] == true {
                self.entered.wait().await;
                self.release.wait().await;
            }
            Ok(ProviderResult {
                data: json!({"effect":"finished"}),
                delta: None,
                verification: VerificationStatus::Verified,
            })
        }
    }

    fn request(key: &str, arguments: &Value) -> InvocationEnvelope {
        serde_json::from_value(json!({
            "protocol_version": "1.0",
            "request_id": uuid::Uuid::new_v4(),
            "device_id": "isolated-test-device",
            "principal_id": "operator:isolated-test",
            "job_id": null,
            "capability": "filesystem.append",
            "arguments": arguments,
            "actor": {"id":"phase4b-test","kind":"ai_client"},
            "session_id": null,
            "response_mode": "compact",
            "idempotency_key": key,
            "preconditions": [],
            "expectations": []
        }))
        .unwrap()
    }

    fn make_runtime(root: &Path, provider: Arc<HeldEffect>) -> Arc<AgentRuntime> {
        let mut router = CapabilityRouter::new();
        router.register(provider).unwrap();
        Arc::new(AgentRuntime {
            router,
            bound_principal_id: None,
            audit_store: None,
            idempotency_store: Some(Arc::new(Mutex::new(IdempotencyStore::new(root).unwrap()))),
        })
    }

    fn scratch() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "tetherplane-phase4b-{}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[tokio::test]
    async fn stalled_keyed_mutation_does_not_block_unrelated_keyed_mutation() {
        let root = scratch();
        let provider = Arc::new(HeldEffect::new());
        let runtime = make_runtime(&root, Arc::clone(&provider));
        let first = request("held-key", &json!({"held":true}));
        let first_task = tokio::spawn({
            let runtime = Arc::clone(&runtime);
            async move { runtime.execute(first).await }
        });

        // Barrier proves A reached the provider effect, unlike sleeping for 250 ms.
        tokio::time::timeout(Duration::from_secs(5), provider.entered.wait())
            .await
            .expect("mutation A must enter provider execution");
        assert!(
            !first_task.is_finished(),
            "A must be held inside the provider"
        );

        let b = request("independent-key", &json!({"held":false}));
        let b_result = tokio::time::timeout(Duration::from_secs(2), runtime.execute(b))
            .await
            .expect("unrelated mutation B must progress despite blocked A");
        assert_eq!(b_result.status, ResultStatus::Success);
        assert_eq!(provider.executions.load(Ordering::SeqCst), 2);
        assert!(
            !first_task.is_finished(),
            "A must remain blocked until release"
        );

        provider.release.wait().await;
        assert_eq!(first_task.await.unwrap().status, ResultStatus::Success);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn concurrent_same_key_is_pending_and_cannot_duplicate_effect() {
        let root = scratch();
        let provider = Arc::new(HeldEffect::new());
        let runtime = make_runtime(&root, Arc::clone(&provider));
        let held = json!({"held":true});
        let first_task = tokio::spawn({
            let runtime = Arc::clone(&runtime);
            let first = request("duplicate-key", &held);
            async move { runtime.execute(first).await }
        });
        tokio::time::timeout(Duration::from_secs(5), provider.entered.wait())
            .await
            .expect("original must enter provider execution");
        let duplicate = request("duplicate-key", &json!({"held":true}));
        let pending = tokio::time::timeout(Duration::from_secs(4), runtime.execute(duplicate))
            .await
            .expect("duplicate must return bounded pending state");
        assert_eq!(pending.status, ResultStatus::Error);
        assert!(matches!(
            pending.error.as_ref().map(|error| &error.code),
            Some(ErrorCode::ActionUnverified)
        ));
        assert_eq!(
            pending.error.as_ref().unwrap().details["operation_phase"],
            "running"
        );
        assert_eq!(provider.executions.load(Ordering::SeqCst), 1);
        assert!(!first_task.is_finished());

        let independent = request("another-key", &json!({"held":false}));
        let independent_result =
            tokio::time::timeout(Duration::from_secs(2), runtime.execute(independent))
                .await
                .expect("different key must execute while first effect is held");
        assert_eq!(independent_result.status, ResultStatus::Success);
        assert_eq!(provider.executions.load(Ordering::SeqCst), 2);

        provider.release.wait().await;
        let initial_result = first_task.await.unwrap();
        assert_eq!(initial_result.status, ResultStatus::Success);
        let replay = runtime
            .execute(request("duplicate-key", &json!({"held":true})))
            .await;
        assert_eq!(replay.status, ResultStatus::Success);
        assert_eq!(replay.data, initial_result.data);
        assert_eq!(provider.executions.load(Ordering::SeqCst), 2);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn failed_completion_after_effect_is_uncertain_and_cannot_replay() {
        let root = scratch();
        let provider = Arc::new(HeldEffect::new());
        let runtime = make_runtime(&root, Arc::clone(&provider));
        let first_task = tokio::spawn({
            let runtime = Arc::clone(&runtime);
            async move {
                runtime
                    .execute(request("failed-completion", &json!({"held":true})))
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(5), provider.entered.wait())
            .await
            .expect("provider reached effect before completion failure");
        let pending = std::fs::read_dir(root.join("idempotency"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.to_string_lossy().ends_with(".pending.json"))
            .expect("running idempotency fence must be on disk");
        let completion = pending.with_file_name(
            pending
                .file_name()
                .unwrap()
                .to_string_lossy()
                .replace(".pending.json", ".complete.json"),
        );
        std::fs::create_dir(&completion).unwrap();
        provider.release.wait().await;

        let uncertain = first_task.await.unwrap();
        assert_eq!(uncertain.status, ResultStatus::Error);
        assert!(matches!(
            uncertain.error.as_ref().map(|error| &error.code),
            Some(ErrorCode::ActionUnverified)
        ));
        assert_eq!(
            uncertain.error.as_ref().unwrap().details["operation_phase"],
            "reconciliation_required"
        );
        assert_eq!(provider.executions.load(Ordering::SeqCst), 1);
        std::fs::remove_dir(&completion).unwrap();
        drop(runtime);
        let next_provider = Arc::new(HeldEffect::new());
        let restarted = make_runtime(&root, Arc::clone(&next_provider));
        let retry = restarted
            .execute(request("failed-completion", &json!({"held":true})))
            .await;
        assert_eq!(retry.status, ResultStatus::Error);
        assert_eq!(
            retry.error.as_ref().unwrap().details["operation_phase"],
            "reconciliation_required"
        );
        assert_eq!(next_provider.executions.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn externally_completed_but_unrecorded_effect_requires_reconciliation() {
        let root = scratch();
        let invocation = request("unrecorded-effect", &json!({"held":false}));
        let store = IdempotencyStore::new(&root).unwrap();
        store.reserve(&invocation).unwrap();
        store.mark_running(&invocation).unwrap();
        let marker = root.join("external-effect.txt");
        std::fs::write(&marker, "once").unwrap();
        drop(store);

        let provider = Arc::new(HeldEffect::new());
        let runtime = make_runtime(&root, Arc::clone(&provider));
        let retry = runtime.execute(invocation).await;
        assert_eq!(retry.status, ResultStatus::Error);
        assert_eq!(
            retry.error.as_ref().unwrap().details["operation_phase"],
            "reconciliation_required"
        );
        assert_eq!(provider.executions.load(Ordering::SeqCst), 0);
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "once");
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod browser_startup_tests {
    use super::DeviceProvider;
    use serde_json::{Value, json};
    use std::collections::BTreeSet;
    use std::sync::Arc;
    use tether_browser_provider::{BrowserBridgeConfig, BrowserProvider};
    use tether_core::{CapabilityProvider, ErrorCode, InvocationEnvelope};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;
    use tokio::time::{Duration, timeout};

    fn invoke(capability: &str) -> InvocationEnvelope {
        serde_json::from_value(json!({
            "protocol_version": "1.0",
            "request_id": uuid::Uuid::new_v4(),
            "device_id": "isolated-browser-startup",
            "principal_id": "operator:isolated-browser-test",
            "job_id": null,
            "capability": capability,
            "arguments": {},
            "actor": {"id":"browser-startup-test","kind":"ai_client"},
            "session_id": null,
            "response_mode": "compact",
            "idempotency_key": null,
            "preconditions": [],
            "expectations": []
        }))
        .expect("valid isolated invocation")
    }

    async fn capabilities(provider: &DeviceProvider) -> Value {
        provider
            .execute(&invoke("device.capabilities"))
            .await
            .expect("device capability query succeeds")
            .data
    }

    fn browser_entry(data: &Value) -> &Value {
        data["providers"]
            .as_array()
            .expect("providers are present")
            .iter()
            .find(|provider| provider["namespace"] == "browser")
            .expect("browser entry is present")
    }

    #[tokio::test]
    async fn offline_browser_cannot_block_core_status_or_claim_availability() {
        let unused_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("allocate isolated loopback port");
        let address = unused_listener.local_addr().expect("loopback address");
        drop(unused_listener);
        let browser = Arc::new(
            BrowserProvider::configured(BrowserBridgeConfig {
                address: address.to_string(),
                token: Some("isolated-test-token".into()),
                timeout_ms: 200,
            })
            .expect("valid loopback configuration"),
        );
        let device = DeviceProvider::new(None, false, false, Some(browser), None);
        let status = timeout(
            Duration::from_secs(1),
            device.execute(&invoke("device.status")),
        )
        .await
        .expect("status must not wait for browser bridge")
        .expect("status succeeds without browser extension");
        assert_eq!(status.data["policy_mode"], "background_only");
        let reported = capabilities(&device).await;
        let advertised = browser_entry(&reported);
        assert_eq!(advertised["available"], false);
        assert_eq!(advertised["operations"], json!([]));
    }

    #[tokio::test]
    async fn authenticated_bridge_reappears_without_agent_restart_and_scope_expansion() {
        let unused_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("allocate isolated loopback port");
        let address = unused_listener.local_addr().expect("loopback address");
        drop(unused_listener);
        let browser = Arc::new(
            BrowserProvider::configured(BrowserBridgeConfig {
                address: address.to_string(),
                token: Some("isolated-test-token".into()),
                timeout_ms: 200,
            })
            .expect("valid loopback configuration"),
        );
        let allowed = BTreeSet::from([
            "device.status".to_owned(),
            "device.capabilities".to_owned(),
            "browser.status".to_owned(),
        ]);
        let device = DeviceProvider::new(Some(allowed), false, false, Some(browser), None);

        assert_eq!(
            browser_entry(&capabilities(&device).await)["available"],
            false
        );
        let listener = TcpListener::bind(address)
            .await
            .expect("bring isolated bridge online");
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.expect("handshake accepted");
            let (read, mut write) = socket.into_split();
            let mut reader = BufReader::new(read).lines();
            let line = reader
                .next_line()
                .await
                .expect("handshake read")
                .expect("handshake request");
            let request: Value = serde_json::from_str(&line).expect("handshake JSON");
            assert_eq!(request["type"], "handshake");
            assert_eq!(request["token"], "isolated-test-token");
            write
                .write_all(
                    b"{\"status\":\"success\",\"data\":{\"operations\":[\"status\",\"navigate\"]}}\n",
                )
                .await
                .expect("handshake response");
        });
        let online = capabilities(&device).await;
        let advertised = browser_entry(&online);
        assert_eq!(advertised["available"], true);
        assert_eq!(advertised["operations"], json!(["status"]));
        server.await.expect("isolated handshake server completed");
        // The server is now gone; the same device may not advertise stale readiness.
        assert_eq!(
            browser_entry(&capabilities(&device).await)["available"],
            false
        );
        assert_eq!(
            device
                .execute(&invoke("device.status"))
                .await
                .expect("device remains responsive")
                .data["policy_mode"],
            "background_only"
        );
    }

    #[tokio::test]
    async fn browser_authentication_denial_cannot_advertise_availability() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("isolated loopback port");
        let address = listener.local_addr().expect("listener address");
        let browser = Arc::new(
            BrowserProvider::configured(BrowserBridgeConfig {
                address: address.to_string(),
                token: Some("wrong-isolated-test-token".into()),
                timeout_ms: 200,
            })
            .expect("valid loopback configuration"),
        );
        let device = DeviceProvider::new(None, false, false, Some(Arc::clone(&browser)), None);
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (socket, _) = listener.accept().await.expect("loopback request");
                let (read, mut write) = socket.into_split();
                let mut reader = BufReader::new(read).lines();
                let request = reader.next_line().await.expect("request read");
                assert!(request.is_some());
                write
                    .write_all(
                        b"{\"status\":\"error\",\"error\":{\"code\":\"permission_denied\",\"message\":\"synthetic token rejection\"}}\n",
                    )
                    .await
                    .expect("auth rejection response");
            }
        });

        assert_eq!(
            browser_entry(&capabilities(&device).await)["available"],
            false
        );
        let rejected = browser.execute(&invoke("browser.status")).await;
        assert!(matches!(
            rejected.err().map(|error| error.code),
            Some(ErrorCode::PermissionDenied)
        ));
        server.await.expect("auth-denial fixture completed");
    }

    #[test]
    fn browser_configuration_rejects_non_loopback_before_any_network_call() {
        let result = BrowserProvider::configured(BrowserBridgeConfig {
            address: "0.0.0.0:17657".into(),
            token: Some("synthetic-token".into()),
            timeout_ms: 200,
        });
        assert!(matches!(
            result.err().map(|error| error.code),
            Some(ErrorCode::InvalidArguments)
        ));
    }
}
