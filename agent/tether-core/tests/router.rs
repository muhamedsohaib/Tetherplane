use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;
use tether_core::{
    Actor, ActorKind, CapabilityError, CapabilityProvider, CapabilityRouter, ErrorCode,
    InvocationEnvelope, ProviderResult, ResponseMode, ResultStatus, VerificationStatus,
};
use uuid::Uuid;

struct MockProvider {
    namespace: &'static str,
    calls: AtomicUsize,
    fail: bool,
    delay_ms: u64,
}

impl MockProvider {
    fn new(namespace: &'static str) -> Self {
        Self {
            namespace,
            calls: AtomicUsize::new(0),
            fail: false,
            delay_ms: 0,
        }
    }
}

#[async_trait]
impl CapabilityProvider for MockProvider {
    fn namespace(&self) -> &'static str {
        self.namespace
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(self.delay_ms));
        }
        if self.fail {
            return Err(CapabilityError {
                code: ErrorCode::ProviderFailure,
                message: "provider failed".into(),
                recovery_hint: None,
                details: json!({}),
            });
        }
        Ok(ProviderResult {
            data: json!({"capability": invocation.capability}),
            delta: None,
            verification: VerificationStatus::Verified,
        })
    }
}

fn invocation(capability: &str) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap(),
        device_id: None,
        principal_id: None,
        job_id: None,
        capability: capability.into(),
        arguments: json!({}),
        actor: Actor {
            id: "router-test".into(),
            kind: ActorKind::AiClient,
        },
        session_id: None,
        response_mode: ResponseMode::Compact,
        idempotency_key: None,
        preconditions: vec![],
        expectations: vec![],
    }
}

#[tokio::test]
async fn registered_namespace_receives_capability() {
    let provider = Arc::new(MockProvider::new("filesystem"));
    let mut router = CapabilityRouter::new();
    router.register(provider.clone()).unwrap();

    let result = router.execute(invocation("filesystem.read")).await;

    assert_eq!(result.status, ResultStatus::Success);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(result.data.unwrap()["capability"], "filesystem.read");
}

#[tokio::test]
async fn unknown_namespace_returns_capability_unavailable() {
    let router = CapabilityRouter::new();
    let request = invocation("browser.observe");
    let request_id = request.request_id;

    let result = router.execute(request).await;

    assert_eq!(result.request_id, request_id);
    assert_eq!(result.status, ResultStatus::Error);
    assert_eq!(result.error.unwrap().code, ErrorCode::CapabilityUnavailable);
}

#[test]
fn duplicate_namespace_registration_fails() {
    let mut router = CapabilityRouter::new();
    router
        .register(Arc::new(MockProvider::new("filesystem")))
        .unwrap();
    let error = router
        .register(Arc::new(MockProvider::new("filesystem")))
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::ProviderFailure);
}

#[tokio::test]
async fn provider_error_preserves_request_id() {
    let provider = Arc::new(MockProvider {
        namespace: "process",
        calls: AtomicUsize::new(0),
        fail: true,
        delay_ms: 0,
    });
    let mut router = CapabilityRouter::new();
    router.register(provider).unwrap();
    let request = invocation("process.run");
    let request_id = request.request_id;

    let result = router.execute(request).await;

    assert_eq!(result.request_id, request_id);
    assert_eq!(result.error.unwrap().code, ErrorCode::ProviderFailure);
}

#[tokio::test]
async fn malformed_capability_is_invalid_arguments() {
    let router = CapabilityRouter::new();
    let result = router.execute(invocation("filesystem")).await;
    assert_eq!(result.error.unwrap().code, ErrorCode::InvalidArguments);
}

#[tokio::test]
async fn execution_records_monotonic_duration() {
    let provider = Arc::new(MockProvider {
        namespace: "filesystem",
        calls: AtomicUsize::new(0),
        fail: false,
        delay_ms: 8,
    });
    let mut router = CapabilityRouter::new();
    router.register(provider).unwrap();

    let result = router.execute(invocation("filesystem.read")).await;

    assert!(result.timing.duration_ms >= 5);
}
#[tokio::test]
async fn failure_records_monotonic_duration() {
    let provider = Arc::new(MockProvider {
        namespace: "process",
        calls: AtomicUsize::new(0),
        fail: true,
        delay_ms: 8,
    });
    let mut router = CapabilityRouter::new();
    router.register(provider).unwrap();

    let result = router.execute(invocation("process.run")).await;

    assert_eq!(result.status, ResultStatus::Error);
    assert!(result.timing.duration_ms >= 5);
}
