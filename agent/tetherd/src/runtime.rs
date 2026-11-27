use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde_json::{Value, json};
use tether_browser_provider::BrowserProvider;
use tether_core::{
    CapabilityError, CapabilityProvider, CapabilityRouter, CapabilityState, ErrorCode,
    InvocationEnvelope, LocalPolicyBroker, LocalPolicyConfig, PrincipalProfile, ProviderResult,
    ResultEnvelope, ResultStatus, TrustedOwnershipRegistry, VerificationStatus,
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
    IdempotencyLookup, IdempotencyStore, conflict_result, is_mutation_capability, pending_result,
    store_failure_result, unavailable_result,
};
use crate::job::JobProvider;

pub struct AgentRuntime {
    router: CapabilityRouter,
    bound_principal_id: Option<String>,
    audit_store: Option<Arc<AuditStore>>,
    idempotency_store: Option<Arc<Mutex<IdempotencyStore>>>,
    health: Arc<CapabilityHealthTracker>,
}

/// Namespaces with trackable health. `batch` is deliberately excluded: it
/// is an in-process combinator whose outcomes aggregate leaf results, so
/// attributing them to `batch` would misreport leaf failures.
const TRACKED_NAMESPACES: &[&str] = &[
    "device",
    "filesystem",
    "search",
    "process",
    "job",
    "audit",
    "browser",
    "desktop",
];

/// Which authority observed degradation. Each heals via its own authority:
/// a healthy probe heals probe-observed degradation, but it must never
/// conceal outcome-observed sub-service failures (only a succeeding
/// execution heals those).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DegradedSource {
    Probe,
    Outcome,
}

#[derive(Clone, Debug)]
struct TrackedHealth {
    state: CapabilityState,
    observed_at_ms: u64,
    reason: Option<String>,
    degraded_source: Option<DegradedSource>,
}

/// Authoritative re-probe outcome. A deliberate fresh check confirms its
/// verdict immediately, unlike noisy single-execution outcomes.
enum ProbeSignal {
    Ready,
    Degraded { reason: &'static str },
    HardFail { code: ErrorCode },
    SoftFail { code: ErrorCode },
}

#[derive(Clone, Debug)]
enum HealthSignal {
    Success,
    SoftFail { code: ErrorCode },
    HardFail { code: ErrorCode },
}

/// Live per-namespace health. Every router outcome and every re-probe
/// updates it; capability reporting reads it. Reasons are fixed templates
/// over namespace + code and never echo provider messages.
#[derive(Default)]
struct CapabilityHealthTracker {
    states: StdMutex<HashMap<String, TrackedHealth>>,
}

impl CapabilityHealthTracker {
    fn new() -> Self {
        Self::default()
    }

    fn record_outcome(&self, capability: &str, result: &ResultEnvelope) {
        let Some(namespace) = split_namespace(capability) else {
            return;
        };
        if !TRACKED_NAMESPACES.contains(&namespace) {
            return;
        }
        let signal = match (&result.status, &result.error) {
            (ResultStatus::Success, _) => HealthSignal::Success,
            (_, Some(error)) => match error.code {
                ErrorCode::Disconnected => HealthSignal::HardFail {
                    code: error.code.clone(),
                },
                ErrorCode::Timeout
                | ErrorCode::CapabilityUnavailable
                | ErrorCode::ProviderFailure => HealthSignal::SoftFail {
                    code: error.code.clone(),
                },
                _ => return,
            },
            (_, None) => return,
        };
        self.apply(namespace, signal, false);
    }

    fn record_probe(&self, namespace: &str, signal: ProbeSignal) {
        if !TRACKED_NAMESPACES.contains(&namespace) {
            return;
        }
        match signal {
            ProbeSignal::Ready => self.apply_probe_ready(namespace),
            ProbeSignal::Degraded { reason } => {
                self.set(
                    namespace,
                    CapabilityState::Degraded,
                    Some(reason.to_owned()),
                    Some(DegradedSource::Probe),
                );
            }
            ProbeSignal::HardFail { code } => {
                self.apply(namespace, HealthSignal::HardFail { code }, true);
            }
            ProbeSignal::SoftFail { code } => {
                self.apply(namespace, HealthSignal::SoftFail { code }, true);
            }
        }
    }

    fn get(&self, namespace: &str) -> Option<TrackedHealth> {
        self.states
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(namespace)
            .cloned()
    }

    /// A healthy probe heals everything except outcome-observed
    /// degradation, which only a succeeding execution can confirm away.
    fn apply_probe_ready(&self, namespace: &str) {
        let mut states = self
            .states
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let stay_degraded = matches!(
            states.get(namespace),
            Some(health)
                if health.state == CapabilityState::Degraded
                    && health.degraded_source == Some(DegradedSource::Outcome)
        );
        if stay_degraded {
            return;
        }
        states.insert(
            namespace.to_owned(),
            TrackedHealth {
                state: CapabilityState::Ready,
                observed_at_ms: now_millis(),
                reason: None,
                degraded_source: None,
            },
        );
    }

    /// `confirmed` distinguishes deliberate probes (condemn directly)
    /// from noisy single outcomes (regress to recovering first).
    /// `observed_at_ms` advances on every applied signal except the
    /// conservative stay (soft signal while disconnected), which neither
    /// confirms nor changes the verdict.
    fn apply(&self, namespace: &str, signal: HealthSignal, confirmed: bool) {
        let mut states = self
            .states
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = states.get(namespace);
        let now = now_millis();
        let next: Option<TrackedHealth> = match signal {
            HealthSignal::Success => Some(TrackedHealth {
                state: CapabilityState::Ready,
                observed_at_ms: now,
                reason: None,
                degraded_source: None,
            }),
            HealthSignal::SoftFail { code } => {
                if matches!(
                    current,
                    Some(health) if health.state == CapabilityState::Disconnected
                ) {
                    None
                } else {
                    Some(TrackedHealth {
                        state: CapabilityState::Degraded,
                        observed_at_ms: now,
                        reason: Some(format!("{namespace} impaired ({})", error_code_slug(&code))),
                        degraded_source: Some(DegradedSource::Outcome),
                    })
                }
            }
            HealthSignal::HardFail { code } => {
                let condemn = confirmed
                    || !matches!(
                        current.map(|health| health.state),
                        Some(CapabilityState::Ready | CapabilityState::Degraded)
                    );
                if condemn {
                    Some(TrackedHealth {
                        state: CapabilityState::Disconnected,
                        observed_at_ms: now,
                        reason: Some(format!(
                            "{namespace} unreachable ({})",
                            error_code_slug(&code)
                        )),
                        degraded_source: None,
                    })
                } else {
                    Some(TrackedHealth {
                        state: CapabilityState::Recovering,
                        observed_at_ms: now,
                        reason: Some(format!(
                            "{namespace} recovering after failure ({})",
                            error_code_slug(&code)
                        )),
                        degraded_source: None,
                    })
                }
            }
        };
        if let Some(health) = next {
            states.insert(namespace.to_owned(), health);
        }
    }

    fn set(
        &self,
        namespace: &str,
        state: CapabilityState,
        reason: Option<String>,
        degraded_source: Option<DegradedSource>,
    ) {
        self.states
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                namespace.to_owned(),
                TrackedHealth {
                    state,
                    observed_at_ms: now_millis(),
                    reason,
                    degraded_source,
                },
            );
    }
}

fn split_namespace(capability: &str) -> Option<&str> {
    capability.split_once('.').map(|(namespace, _)| namespace)
}

fn error_code_slug(code: &ErrorCode) -> &'static str {
    match code {
        ErrorCode::Disconnected => "disconnected",
        ErrorCode::Timeout => "timeout",
        ErrorCode::CapabilityUnavailable => "capability_unavailable",
        ErrorCode::ProviderFailure => "provider_failure",
        _ => "error",
    }
}

fn now_millis() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
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
        let health = Arc::new(CapabilityHealthTracker::new());
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
            Arc::clone(&health),
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
            health,
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
            self.execute_and_track(invocation).await
        };

        if let Some(audit_store) = &self.audit_store
            && let Err(error) = audit_store.append(&audit_invocation, &result)
        {
            eprintln!("audit append failed: {}", error.message);
        }
        result
    }

    /// Router-level execution with health tracking. Outcomes are
    /// recorded from the provider result itself, never from idempotency
    /// replay/conflict/store verdicts (those describe the store, not the
    /// provider's health).
    async fn execute_and_track(&self, invocation: InvocationEnvelope) -> ResultEnvelope {
        let capability = invocation.capability.clone();
        let result = self.router.execute(invocation).await;
        self.health.record_outcome(&capability, &result);
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

                let result = self.execute_and_track(invocation.clone()).await;
                if let Err(error) = guard.complete(&invocation, &result) {
                    return store_failure_result(&invocation, error);
                }
                result
            }
            Err(error) => store_failure_result(&invocation, error),
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
    browser: Option<Arc<BrowserProvider>>,
    desktop_operations: Option<Vec<String>>,
    health: Arc<CapabilityHealthTracker>,
}

impl DeviceProvider {
    fn new(
        allowed_capabilities: Option<BTreeSet<String>>,
        job_available: bool,
        audit_available: bool,
        browser: Option<Arc<BrowserProvider>>,
        desktop_operations: Option<Vec<String>>,
        health: Arc<CapabilityHealthTracker>,
    ) -> Self {
        Self {
            started: Instant::now(),
            allowed_capabilities,
            job_available,
            audit_available,
            browser,
            desktop_operations,
            health,
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

    /// Truthful per-namespace readiness. The browser is re-probed live on
    /// every read (never trusted from the startup handshake); all other
    /// namespaces report continuously tracked execution outcomes. Each
    /// entry carries `state`, `observed_at` freshness, and a `reason`.
    async fn capabilities(&self) -> Value {
        if let Some(browser) = &self.browser {
            match browser.probe().await {
                Ok(report) => match report.degraded_reason {
                    None => self.health.record_probe("browser", ProbeSignal::Ready),
                    Some(_) => self.health.record_probe(
                        "browser",
                        ProbeSignal::Degraded {
                            reason: "browser bridge reports unavailable",
                        },
                    ),
                },
                Err(error) => match error.code {
                    ErrorCode::Disconnected => {
                        self.health.record_probe(
                            "browser",
                            ProbeSignal::HardFail {
                                code: ErrorCode::Disconnected,
                            },
                        );
                    }
                    code => {
                        self.health
                            .record_probe("browser", ProbeSignal::SoftFail { code });
                    }
                },
            }
        }
        json!({
            "providers": [
                self.local_entry("device", &["status", "capabilities"]),
                self.local_entry("filesystem", &["read", "read_many", "list", "info", "write", "append", "mkdir", "move", "patch"]),
                self.local_entry("search", &["start", "read", "stop", "list"]),
                self.local_entry("process", &["run", "read", "input", "list_sessions", "list_system", "terminate"]),
                self.local_entry("batch", &["execute"]),
                self.configured_entry("job", &["create", "get", "checkpoint", "acquire_lease", "release_lease"], self.job_available, "job provider is not configured"),
                self.configured_entry("audit", &["read"], self.audit_available, "audit provider is not configured"),
                self.browser_entry(),
                self.desktop_entry(),
            ]
        })
    }

    /// In-process namespaces: always configured; tracked outcomes refine
    /// the default ready.
    fn local_entry(&self, namespace: &str, operations: &[&str]) -> Value {
        let (state, observed_at_ms, reason) = self.resolve_tracked(namespace);
        json!({
            "namespace": namespace,
            "state": state,
            "observed_at": observed_at_ms,
            "reason": reason,
            "operations": self.operations(namespace, operations),
        })
    }

    /// Namespaces needing configuration (job/audit stores).
    fn configured_entry(
        &self,
        namespace: &str,
        operations: &[&str],
        configured: bool,
        absent_reason: &'static str,
    ) -> Value {
        if configured {
            let (state, observed_at_ms, reason) = self.resolve_tracked(namespace);
            json!({
                "namespace": namespace,
                "state": state,
                "observed_at": observed_at_ms,
                "reason": reason,
                "operations": self.operations(namespace, operations),
            })
        } else {
            json!({
                "namespace": namespace,
                "state": CapabilityState::Disconnected,
                "observed_at": now_millis(),
                "reason": absent_reason,
                "operations": Vec::<String>::new(),
            })
        }
    }

    fn browser_entry(&self) -> Value {
        let Some(browser) = &self.browser else {
            return json!({
                "namespace": "browser",
                "state": CapabilityState::Disconnected,
                "observed_at": now_millis(),
                "reason": "browser bridge is not configured",
                "operations": Vec::<String>::new(),
            });
        };
        let operations = browser.operations().to_vec();
        if self.fully_excluded("browser", &operations) {
            return self.unauthorized_entry("browser", &operations);
        }
        // The live probe above always records, so tracked state exists.
        let tracked = self.health.get("browser");
        let (state, observed_at_ms, reason) = match tracked.as_ref() {
            Some(health) => (health.state, health.observed_at_ms, health.reason.clone()),
            None => (
                CapabilityState::Recovering,
                now_millis(),
                Some("browser not yet verified".to_owned()),
            ),
        };
        json!({
            "namespace": "browser",
            "state": state,
            "observed_at": observed_at_ms,
            "reason": reason,
            "operations": self.filtered_operations("browser", &operations),
        })
    }

    fn desktop_entry(&self) -> Value {
        let Some(operations) = &self.desktop_operations else {
            return json!({
                "namespace": "desktop",
                "state": CapabilityState::Disconnected,
                "observed_at": now_millis(),
                "reason": "desktop provider is not available on this platform",
                "operations": Vec::<String>::new(),
            });
        };
        if self.fully_excluded("desktop", operations) {
            return self.unauthorized_entry("desktop", operations);
        }
        // No side-effect-free desktop probe exists, so a present desktop
        // is verified by real executions (outcome tracking) only.
        let (state, observed_at_ms, reason) = match self.health.get("desktop") {
            Some(health) => (health.state, health.observed_at_ms, health.reason),
            None => (
                CapabilityState::Recovering,
                now_millis(),
                Some("desktop not yet verified".to_owned()),
            ),
        };
        json!({
            "namespace": "desktop",
            "state": state,
            "observed_at": observed_at_ms,
            "reason": reason,
            "operations": self.filtered_operations("desktop", operations),
        })
    }

    /// Tracked-or-default resolution for namespaces with no live probe.
    /// In-process namespaces default to ready (construction is the
    /// existence proof); a recorded outcome always wins when present.
    /// A bound profile that grants nothing in the namespace reports
    /// unauthorized, since policy denies before any provider dispatch.
    fn resolve_tracked(&self, namespace: &str) -> (CapabilityState, u64, Option<String>) {
        if let Some(operations) = Self::full_operations(namespace)
            && self.fully_excluded(namespace, &operations)
        {
            return (
                CapabilityState::Unauthorized,
                now_millis(),
                Some(format!(
                    "{namespace}.* is not granted by the active principal profile"
                )),
            );
        }
        if let Some(tracked) = self.health.get(namespace) {
            return (tracked.state, tracked.observed_at_ms, tracked.reason);
        }
        (CapabilityState::Ready, now_millis(), None)
    }

    fn unauthorized_entry(&self, namespace: &str, operations: &[String]) -> Value {
        json!({
            "namespace": namespace,
            "state": CapabilityState::Unauthorized,
            "observed_at": now_millis(),
            "reason": format!("{namespace}.* is not granted by the active principal profile"),
            "operations": self.filtered_operations(namespace, operations),
        })
    }

    /// Full operation surface for grant assessment. Absence is checked
    /// before grants by every caller, so an empty filtered list here
    /// always means "denied", never "missing".
    fn full_operations(namespace: &str) -> Option<Vec<String>> {
        match namespace {
            "device" => Some(vec!["status".to_owned(), "capabilities".to_owned()]),
            "filesystem" => Some(
                [
                    "read",
                    "read_many",
                    "list",
                    "info",
                    "write",
                    "append",
                    "mkdir",
                    "move",
                    "patch",
                ]
                .iter()
                .map(ToString::to_string)
                .collect(),
            ),
            "search" => Some(
                ["start", "read", "stop", "list"]
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
            ),
            "process" => Some(
                [
                    "run",
                    "read",
                    "input",
                    "list_sessions",
                    "list_system",
                    "terminate",
                ]
                .iter()
                .map(ToString::to_string)
                .collect(),
            ),
            "batch" => Some(vec!["execute".to_owned()]),
            "job" => Some(
                [
                    "create",
                    "get",
                    "checkpoint",
                    "acquire_lease",
                    "release_lease",
                ]
                .iter()
                .map(ToString::to_string)
                .collect(),
            ),
            "audit" => Some(vec!["read".to_owned()]),
            _ => None,
        }
    }

    fn fully_excluded(&self, namespace: &str, operations: &[String]) -> bool {
        if operations.is_empty() {
            return false;
        }
        self.allowed_capabilities.as_ref().is_some_and(|allowed| {
            operations
                .iter()
                .all(|operation| !allowed.contains(&format!("{namespace}.{operation}")))
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

    fn filtered_operations(&self, namespace: &str, operations: &[String]) -> Vec<String> {
        operations
            .iter()
            .filter(|operation| {
                self.allowed_capabilities
                    .as_ref()
                    .is_none_or(|allowed| allowed.contains(&format!("{namespace}.{operation}")))
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
mod tests {
    use super::*;
    use tether_core::{ResultStatus, Timing, VerificationStatus};

    fn success_envelope(_capability: &str) -> ResultEnvelope {
        ResultEnvelope {
            protocol_version: "1.0".into(),
            request_id: uuid::Uuid::new_v4(),
            status: ResultStatus::Success,
            data: Some(json!({})),
            delta: None,
            error: None,
            verification: VerificationStatus::Verified,
            continuation: None,
            policy: None,
            timing: Timing { duration_ms: 1 },
        }
    }

    fn error_envelope(_capability: &str, code: ErrorCode, message: &str) -> ResultEnvelope {
        ResultEnvelope {
            protocol_version: "1.0".into(),
            request_id: uuid::Uuid::new_v4(),
            status: ResultStatus::Error,
            data: None,
            delta: None,
            error: Some(CapabilityError {
                code,
                message: message.to_owned(),
                recovery_hint: None,
                details: json!({}),
            }),
            verification: VerificationStatus::Failed,
            continuation: None,
            policy: None,
            timing: Timing { duration_ms: 1 },
        }
    }

    #[test]
    fn fresh_tracker_has_no_recorded_state() {
        let tracker = CapabilityHealthTracker::new();
        assert!(tracker.get("browser").is_none());
        assert!(tracker.get("desktop").is_none());
    }

    #[test]
    fn success_marks_ready_and_heals_anything() {
        let tracker = CapabilityHealthTracker::new();
        tracker.record_outcome(
            "browser.pages",
            &error_envelope("browser.pages", ErrorCode::Disconnected, "down"),
        );
        tracker.record_outcome(
            "browser.pages",
            &error_envelope("browser.pages", ErrorCode::Disconnected, "down"),
        );
        assert_eq!(
            tracker.get("browser").expect("tracked").state,
            CapabilityState::Disconnected
        );
        tracker.record_outcome("browser.pages", &success_envelope("browser.pages"));
        let health = tracker.get("browser").expect("tracked");
        assert_eq!(health.state, CapabilityState::Ready);
        assert!(health.reason.is_none());
    }

    #[test]
    fn single_hard_failure_regresses_to_recovering_not_disconnected() {
        let tracker = CapabilityHealthTracker::new();
        tracker.record_outcome("browser.pages", &success_envelope("browser.pages"));
        tracker.record_outcome(
            "browser.pages",
            &error_envelope("browser.pages", ErrorCode::Disconnected, "bridge gone"),
        );
        let health = tracker.get("browser").expect("tracked");
        assert_eq!(health.state, CapabilityState::Recovering);
        assert!(health.reason.as_deref().unwrap_or("").contains("browser"));
    }

    #[test]
    fn repeated_hard_failure_confirms_disconnected() {
        let tracker = CapabilityHealthTracker::new();
        tracker.record_outcome("browser.pages", &success_envelope("browser.pages"));
        for _ in 0..2 {
            tracker.record_outcome(
                "browser.pages",
                &error_envelope("browser.pages", ErrorCode::Disconnected, "bridge gone"),
            );
        }
        assert_eq!(
            tracker.get("browser").expect("tracked").state,
            CapabilityState::Disconnected
        );
    }

    #[test]
    fn hard_failure_on_never_verified_namespace_condemns_directly() {
        let tracker = CapabilityHealthTracker::new();
        tracker.record_outcome(
            "desktop.snapshot",
            &error_envelope("desktop.snapshot", ErrorCode::Disconnected, "no session"),
        );
        assert_eq!(
            tracker.get("desktop").expect("tracked").state,
            CapabilityState::Disconnected
        );
    }

    #[test]
    fn soft_failures_mark_degraded_and_success_heals() {
        for code in [
            ErrorCode::Timeout,
            ErrorCode::CapabilityUnavailable,
            ErrorCode::ProviderFailure,
        ] {
            let tracker = CapabilityHealthTracker::new();
            tracker.record_outcome("browser.pages", &success_envelope("browser.pages"));
            tracker.record_outcome(
                "browser.pages",
                &error_envelope("browser.pages", code.clone(), "sub-service down"),
            );
            assert_eq!(
                tracker.get("browser").expect("tracked").state,
                CapabilityState::Degraded,
                "code {code:?} must degrade"
            );
            tracker.record_outcome("browser.pages", &success_envelope("browser.pages"));
            assert_eq!(
                tracker.get("browser").expect("tracked").state,
                CapabilityState::Ready
            );
        }
    }

    #[test]
    fn soft_failure_does_not_heal_disconnected() {
        let tracker = CapabilityHealthTracker::new();
        tracker.record_outcome(
            "browser.pages",
            &error_envelope("browser.pages", ErrorCode::Disconnected, "down"),
        );
        assert_eq!(
            tracker.get("browser").expect("tracked").state,
            CapabilityState::Disconnected
        );
        tracker.record_outcome(
            "browser.pages",
            &error_envelope("browser.pages", ErrorCode::Timeout, "slow"),
        );
        assert_eq!(
            tracker.get("browser").expect("tracked").state,
            CapabilityState::Disconnected
        );
    }

    #[test]
    fn caller_and_policy_errors_do_not_touch_health() {
        for code in [
            ErrorCode::InvalidArguments,
            ErrorCode::PermissionDenied,
            ErrorCode::ApprovalRequired,
            ErrorCode::StaleReference,
            ErrorCode::ResourceConflict,
            ErrorCode::PreconditionFailed,
            ErrorCode::ActionUnverified,
        ] {
            let tracker = CapabilityHealthTracker::new();
            tracker.record_outcome(
                "browser.pages",
                &error_envelope("browser.pages", code.clone(), "caller problem"),
            );
            assert!(
                tracker.get("browser").is_none(),
                "code {code:?} must not create health state"
            );
        }
    }

    #[test]
    fn batch_and_unknown_namespaces_are_never_tracked() {
        let tracker = CapabilityHealthTracker::new();
        tracker.record_outcome(
            "batch.execute",
            &error_envelope("batch.execute", ErrorCode::Disconnected, "leaf failed"),
        );
        assert!(tracker.get("batch").is_none());
        tracker.record_outcome(
            "browsre.pages",
            &error_envelope("browsre.pages", ErrorCode::Disconnected, "typo"),
        );
        assert!(tracker.get("browsre").is_none());
        tracker.record_outcome("not-a-capability", &success_envelope("not-a-capability"));
        assert!(tracker.get("not-a-capability").is_none());
    }

    #[test]
    fn confirmed_probe_hard_failure_condemns_directly() {
        let tracker = CapabilityHealthTracker::new();
        tracker.record_outcome("browser.pages", &success_envelope("browser.pages"));
        tracker.record_probe(
            "browser",
            ProbeSignal::HardFail {
                code: ErrorCode::Disconnected,
            },
        );
        assert_eq!(
            tracker.get("browser").expect("tracked").state,
            CapabilityState::Disconnected
        );
    }

    #[test]
    fn probe_success_heals_and_probe_degraded_reports() {
        let tracker = CapabilityHealthTracker::new();
        tracker.record_outcome(
            "browser.pages",
            &error_envelope("browser.pages", ErrorCode::Disconnected, "down"),
        );
        tracker.record_probe("browser", ProbeSignal::Ready);
        assert_eq!(
            tracker.get("browser").expect("tracked").state,
            CapabilityState::Ready
        );
        tracker.record_probe(
            "browser",
            ProbeSignal::Degraded {
                reason: "bridge reports unavailable",
            },
        );
        let health = tracker.get("browser").expect("tracked");
        assert_eq!(health.state, CapabilityState::Degraded);
        assert!(
            health
                .reason
                .as_deref()
                .unwrap_or("")
                .contains("unavailable")
        );
        // A healthy probe heals probe-observed degradation.
        tracker.record_probe("browser", ProbeSignal::Ready);
        assert_eq!(
            tracker.get("browser").expect("tracked").state,
            CapabilityState::Ready
        );
    }

    #[test]
    fn healthy_probe_does_not_conceal_outcome_observed_degradation() {
        let tracker = CapabilityHealthTracker::new();
        tracker.record_outcome("browser.pages", &success_envelope("browser.pages"));
        tracker.record_outcome(
            "browser.snapshot",
            &error_envelope(
                "browser.snapshot",
                ErrorCode::CapabilityUnavailable,
                "checkpoint down",
            ),
        );
        assert_eq!(
            tracker.get("browser").expect("tracked").state,
            CapabilityState::Degraded
        );
        // Status probe is healthy, but the sub-service failure stands
        // until a real execution succeeds.
        tracker.record_probe("browser", ProbeSignal::Ready);
        assert_eq!(
            tracker.get("browser").expect("tracked").state,
            CapabilityState::Degraded
        );
        tracker.record_outcome("browser.pages", &success_envelope("browser.pages"));
        assert_eq!(
            tracker.get("browser").expect("tracked").state,
            CapabilityState::Ready
        );
    }

    #[test]
    fn health_reasons_never_echo_provider_messages() {
        let tracker = CapabilityHealthTracker::new();
        tracker.record_outcome(
            "filesystem.read",
            &error_envelope(
                "filesystem.read",
                ErrorCode::Disconnected,
                "SECRET-MARKER-please-do-not-repeat /etc/shadow",
            ),
        );
        tracker.record_outcome(
            "filesystem.read",
            &error_envelope(
                "filesystem.read",
                ErrorCode::Disconnected,
                "SECRET-MARKER-please-do-not-repeat /etc/shadow",
            ),
        );
        let health = tracker.get("filesystem").expect("tracked");
        assert_eq!(health.state, CapabilityState::Disconnected);
        let reason = health.reason.unwrap_or_default();
        assert!(!reason.contains("SECRET-MARKER"), "reason leaked: {reason}");
        assert!(reason.contains("filesystem"));
    }

    fn test_provider(allowed: Option<BTreeSet<String>>) -> DeviceProvider {
        DeviceProvider::new(
            allowed,
            false,
            false,
            None,
            None,
            Arc::new(CapabilityHealthTracker::new()),
        )
    }

    #[test]
    fn fully_excluded_namespace_reports_unauthorized() {
        let allowed: BTreeSet<String> = ["device.status".to_owned()].into_iter().collect();
        let provider = test_provider(Some(allowed));
        let entry = provider.local_entry("process", &["run", "read", "terminate"]);
        assert_eq!(entry["state"].as_str(), Some("unauthorized"));
        assert!(
            entry["reason"]
                .as_str()
                .unwrap_or("")
                .contains("not granted")
        );
        assert_eq!(
            entry["operations"],
            json!(Vec::<String>::new()),
            "unauthorized namespaces advertise no operations"
        );
    }

    #[test]
    fn partial_grant_stays_ready_with_filtered_operations() {
        let allowed: BTreeSet<String> = ["filesystem.read".to_owned(), "device.status".to_owned()]
            .into_iter()
            .collect();
        let provider = test_provider(Some(allowed));
        let entry = provider.local_entry("filesystem", &["read", "write"]);
        assert_eq!(entry["state"].as_str(), Some("ready"));
        assert_eq!(entry["operations"], json!(["read"]));
    }

    #[test]
    fn unconfigured_namespaces_report_disconnected() {
        let provider = test_provider(None);
        let job =
            provider.configured_entry("job", &["create"], false, "job provider is not configured");
        assert_eq!(job["state"].as_str(), Some("disconnected"));
        let desktop = provider.desktop_entry();
        assert_eq!(desktop["state"].as_str(), Some("disconnected"));
        assert!(
            desktop["reason"]
                .as_str()
                .unwrap_or("")
                .contains("not available")
        );
        let browser = provider.browser_entry();
        assert_eq!(browser["state"].as_str(), Some("disconnected"));
    }

    #[test]
    fn present_desktop_defaults_to_recovering_until_verified() {
        let provider = DeviceProvider::new(
            None,
            false,
            false,
            None,
            Some(vec!["snapshot".to_owned()]),
            Arc::new(CapabilityHealthTracker::new()),
        );
        let entry = provider.desktop_entry();
        assert_eq!(entry["state"].as_str(), Some("recovering"));
        assert_eq!(entry["operations"], json!(["snapshot"]));
    }

    #[test]
    fn observed_at_advances_on_every_signal() {
        let tracker = CapabilityHealthTracker::new();
        tracker.record_outcome("browser.pages", &success_envelope("browser.pages"));
        let first = tracker.get("browser").expect("tracked").observed_at_ms;
        assert!(first > 0);
        std::thread::sleep(std::time::Duration::from_millis(2));
        tracker.record_outcome(
            "browser.pages",
            &error_envelope("browser.pages", ErrorCode::Timeout, "slow"),
        );
        let second = tracker.get("browser").expect("tracked").observed_at_ms;
        assert!(second >= first);
    }
}
