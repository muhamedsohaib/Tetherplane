use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{Value, json};
use tether_core::{
    CapabilityError, CapabilityProvider, CapabilityRouter, ErrorCode, InvocationEnvelope,
    LocalPolicyBroker, LocalPolicyConfig, ProviderResult, ResultEnvelope, VerificationStatus,
};
use tether_filesystem_provider::FilesystemProvider;
use tether_process_provider::ProcessProvider;
use tether_search_provider::SearchProvider;

pub struct AgentRuntime {
    router: CapabilityRouter,
}

impl AgentRuntime {
    pub fn new(mut allowed_roots: Vec<PathBuf>) -> Result<Self, CapabilityError> {
        if allowed_roots.is_empty() {
            allowed_roots.push(std::env::current_dir().map_err(|error| CapabilityError {
                code: ErrorCode::ProviderFailure,
                message: format!("failed to resolve runtime working directory: {error}"),
                recovery_hint: None,
                details: Value::Null,
            })?);
        }
        let policy = Arc::new(LocalPolicyBroker::new(LocalPolicyConfig::new(
            allowed_roots,
        )));
        let mut router = CapabilityRouter::with_policy(policy);

        router.register(Arc::new(DeviceProvider::new()))?;
        router.register(Arc::new(FilesystemProvider::new()))?;
        router.register(Arc::new(SearchProvider::new()))?;
        router.register(Arc::new(ProcessProvider::new()))?;
        router.register(Arc::new(UnavailableProvider::new("browser")))?;
        router.register(Arc::new(UnavailableProvider::new("desktop")))?;

        Ok(Self { router })
    }

    pub async fn execute(&self, invocation: InvocationEnvelope) -> ResultEnvelope {
        self.router.execute(invocation).await
    }
}

struct DeviceProvider {
    started: Instant,
}

impl DeviceProvider {
    fn new() -> Self {
        Self {
            started: Instant::now(),
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

    fn capabilities() -> Value {
        json!({
            "providers": [
                { "namespace": "device", "available": true, "operations": ["status", "capabilities"] },
                { "namespace": "filesystem", "available": true, "operations": ["read", "read_many", "list", "info", "write", "append", "mkdir", "move", "patch"] },
                { "namespace": "search", "available": true, "operations": ["start", "read", "stop", "list"] },
                { "namespace": "process", "available": true, "operations": ["run", "read", "input", "list_sessions", "list_system", "terminate"] },
                { "namespace": "batch", "available": true, "operations": ["execute"] },
                { "namespace": "browser", "available": false, "operations": [] },
                { "namespace": "desktop", "available": false, "operations": [] }
            ]
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
            "capabilities" => Self::capabilities(),
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
