use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{Value, json};
use tether_browser_provider::BrowserProvider;
use tether_core::{
    CapabilityError, CapabilityProvider, CapabilityRouter, ErrorCode, InvocationEnvelope,
    LocalPolicyBroker, LocalPolicyConfig, PrincipalProfile, ProviderResult, ResultEnvelope,
    VerificationStatus,
};
use tether_filesystem_provider::FilesystemProvider;
use tether_process_provider::ProcessProvider;
use tether_search_provider::SearchProvider;
use tokio::sync::Mutex;

use crate::audit::{AuditProvider, AuditStore};
use crate::idempotency::{
    IdempotencyLookup, IdempotencyStore, conflict_result, is_mutation_capability, pending_result,
    store_failure_result, unavailable_result,
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
                details: Value::Null,
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

        let browser_operations = browser_provider
            .as_ref()
            .map(|provider| provider.operations().to_vec());
        router.register(Arc::new(DeviceProvider::new(
            principal_capabilities,
            job_available,
            audit_available,
            browser_operations,
        )))?;
        router.register(Arc::new(FilesystemProvider::new()))?;
        router.register(Arc::new(SearchProvider::new()))?;
        router.register(Arc::new(ProcessProvider::new()))?;
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
        router.register(Arc::new(UnavailableProvider::new("desktop")))?;

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

struct DeviceProvider {
    started: Instant,
    allowed_capabilities: Option<BTreeSet<String>>,
    job_available: bool,
    audit_available: bool,
    browser_operations: Option<Vec<String>>,
}

impl DeviceProvider {
    fn new(
        allowed_capabilities: Option<BTreeSet<String>>,
        job_available: bool,
        audit_available: bool,
        browser_operations: Option<Vec<String>>,
    ) -> Self {
        Self {
            started: Instant::now(),
            allowed_capabilities,
            job_available,
            audit_available,
            browser_operations,
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

    fn capabilities(&self) -> Value {
        json!({
            "providers": [
                { "namespace": "device", "available": true, "operations": self.operations("device", &["status", "capabilities"]) },
                { "namespace": "filesystem", "available": true, "operations": self.operations("filesystem", &["read", "read_many", "list", "info", "write", "append", "mkdir", "move", "patch"]) },
                { "namespace": "search", "available": true, "operations": self.operations("search", &["start", "read", "stop", "list"]) },
                { "namespace": "process", "available": true, "operations": self.operations("process", &["run", "read", "input", "list_sessions", "list_system", "terminate"]) },
                { "namespace": "batch", "available": true, "operations": self.operations("batch", &["execute"]) },
                { "namespace": "job", "available": self.job_available, "operations": if self.job_available { self.operations("job", &["create", "get", "checkpoint", "acquire_lease", "release_lease"]) } else { Vec::<String>::new() } },
                { "namespace": "audit", "available": self.audit_available, "operations": if self.audit_available { self.operations("audit", &["read"]) } else { Vec::<String>::new() } },
                { "namespace": "browser", "available": self.browser_operations.is_some(), "operations": self.browser_operations() },
                { "namespace": "desktop", "available": false, "operations": [] }
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

    fn browser_operations(&self) -> Vec<String> {
        self.browser_operations
            .as_ref()
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
            "capabilities" => self.capabilities(),
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
        details: Value::Null,
    }
}
