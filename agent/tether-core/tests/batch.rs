use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::json;
use tether_core::{
    Actor, ActorKind, CapabilityError, CapabilityProvider, CapabilityRouter, InvocationEnvelope,
    ProviderResult, ResponseMode, ResultStatus, VerificationStatus,
};
use uuid::Uuid;

struct DelayProvider {
    namespace: &'static str,
    delay: Duration,
}

#[async_trait]
impl CapabilityProvider for DelayProvider {
    fn namespace(&self) -> &'static str {
        self.namespace
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        tokio::time::sleep(self.delay).await;
        Ok(ProviderResult {
            data: json!({ "capability": invocation.capability }),
            delta: None,
            verification: VerificationStatus::Verified,
        })
    }
}

fn batch_invocation(mode: &str) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: Uuid::parse_str("33333333-3333-4333-8333-333333333333").unwrap(),
        device_id: Some("Leno".into()),
        principal_id: None,
        capability: "batch.execute".into(),
        arguments: json!({
            "mode": mode,
            "operations": [
                { "capability": "slow_a.read", "arguments": {} },
                { "capability": "slow_b.read", "arguments": {} }
            ]
        }),
        actor: Actor {
            id: "batch-test".into(),
            kind: ActorKind::AiClient,
        },
        session_id: Some("batch-session".into()),
        response_mode: ResponseMode::Compact,
        idempotency_key: None,
        preconditions: vec![],
        expectations: vec![],
    }
}

#[tokio::test]
async fn parallel_batch_is_materially_faster_than_sequential() {
    let mut router = CapabilityRouter::new();
    router
        .register(Arc::new(DelayProvider {
            namespace: "slow_a",
            delay: Duration::from_millis(120),
        }))
        .unwrap();
    router
        .register(Arc::new(DelayProvider {
            namespace: "slow_b",
            delay: Duration::from_millis(120),
        }))
        .unwrap();

    let sequential_started = Instant::now();
    let sequential = router.execute(batch_invocation("sequential")).await;
    let sequential_elapsed = sequential_started.elapsed();

    let parallel_started = Instant::now();
    let parallel = router.execute(batch_invocation("parallel")).await;
    let parallel_elapsed = parallel_started.elapsed();

    assert_eq!(sequential.status, ResultStatus::Success);
    assert_eq!(parallel.status, ResultStatus::Success);
    assert!(
        parallel_elapsed + Duration::from_millis(60) < sequential_elapsed,
        "parallel={parallel_elapsed:?} sequential={sequential_elapsed:?}"
    );
}

use std::sync::atomic::{AtomicUsize, Ordering};

use tether_core::{PolicyBroker, PolicyDecision};

struct CountingProvider {
    namespace: &'static str,
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl CapabilityProvider for CountingProvider {
    fn namespace(&self) -> &'static str {
        self.namespace
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ProviderResult {
            data: json!({ "capability": invocation.capability }),
            delta: None,
            verification: VerificationStatus::Verified,
        })
    }
}

struct DenyBlocked;

impl PolicyBroker for DenyBlocked {
    fn evaluate(&self, invocation: &InvocationEnvelope) -> PolicyDecision {
        if invocation.capability == "blocked.read" {
            PolicyDecision::Deny {
                reason: "blocked by batch policy test".into(),
            }
        } else {
            PolicyDecision::Allow
        }
    }
}

#[tokio::test]
async fn batch_policy_checks_each_child_and_never_invokes_denied_provider() {
    let allowed_calls = Arc::new(AtomicUsize::new(0));
    let blocked_calls = Arc::new(AtomicUsize::new(0));
    let mut router = CapabilityRouter::with_policy(Arc::new(DenyBlocked));
    router
        .register(Arc::new(CountingProvider {
            namespace: "allowed",
            calls: Arc::clone(&allowed_calls),
        }))
        .unwrap();
    router
        .register(Arc::new(CountingProvider {
            namespace: "blocked",
            calls: Arc::clone(&blocked_calls),
        }))
        .unwrap();

    let mut request = batch_invocation("parallel");
    request.arguments = json!({
        "mode": "parallel",
        "operations": [
            { "capability": "allowed.read", "arguments": {} },
            { "capability": "blocked.read", "arguments": {} }
        ]
    });

    let result = router.execute(request).await;

    assert_eq!(result.status, ResultStatus::Success);
    let data = result.data.unwrap();
    let results = data["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["status"], "success");
    assert_eq!(results[1]["status"], "error");
    assert_eq!(results[1]["error"]["code"], "permission_denied");
    assert_eq!(allowed_calls.load(Ordering::SeqCst), 1);
    assert_eq!(blocked_calls.load(Ordering::SeqCst), 0);
}

struct StepProvider {
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl CapabilityProvider for StepProvider {
    fn namespace(&self) -> &'static str {
        "steps"
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if invocation.capability == "steps.fail" {
            return Err(CapabilityError {
                code: tether_core::ErrorCode::ProviderFailure,
                message: "step failed".into(),
                recovery_hint: None,
                details: json!({}),
            });
        }

        Ok(ProviderResult {
            data: json!({ "capability": invocation.capability }),
            delta: None,
            verification: VerificationStatus::Verified,
        })
    }
}

fn sequential_failure_request(stop_on_error: Option<bool>) -> InvocationEnvelope {
    let mut request = batch_invocation("sequential");
    let mut arguments = json!({
        "mode": "sequential",
        "operations": [
            { "capability": "steps.fail", "arguments": {} },
            { "capability": "steps.ok", "arguments": {} }
        ]
    });
    if let Some(value) = stop_on_error {
        arguments["stop_on_error"] = json!(value);
    }
    request.arguments = arguments;
    request
}

#[tokio::test]
async fn sequential_batch_stops_on_first_error_by_default() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut router = CapabilityRouter::new();
    router
        .register(Arc::new(StepProvider {
            calls: Arc::clone(&calls),
        }))
        .unwrap();

    let result = router.execute(sequential_failure_request(None)).await;

    assert_eq!(result.status, ResultStatus::Success);
    let data = result.data.unwrap();
    let results = data["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["status"], "error");
    assert_eq!(data["stopped_early"], true);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn sequential_batch_can_continue_after_error_when_requested() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut router = CapabilityRouter::new();
    router
        .register(Arc::new(StepProvider {
            calls: Arc::clone(&calls),
        }))
        .unwrap();

    let result = router
        .execute(sequential_failure_request(Some(false)))
        .await;

    assert_eq!(result.status, ResultStatus::Success);
    let data = result.data.unwrap();
    let results = data["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["status"], "error");
    assert_eq!(results[1]["status"], "success");
    assert_eq!(data["stopped_early"], false);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

struct VariableDelayProvider {
    namespace: &'static str,
    delay: Duration,
}

#[async_trait]
impl CapabilityProvider for VariableDelayProvider {
    fn namespace(&self) -> &'static str {
        self.namespace
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        tokio::time::sleep(self.delay).await;
        Ok(ProviderResult {
            data: json!({ "capability": invocation.capability }),
            delta: None,
            verification: VerificationStatus::Verified,
        })
    }
}

#[tokio::test]
async fn parallel_batch_preserves_input_order_when_completion_order_differs() {
    let mut router = CapabilityRouter::new();
    router
        .register(Arc::new(VariableDelayProvider {
            namespace: "order_slow",
            delay: Duration::from_millis(100),
        }))
        .unwrap();
    router
        .register(Arc::new(VariableDelayProvider {
            namespace: "order_fast",
            delay: Duration::from_millis(10),
        }))
        .unwrap();

    let mut request = batch_invocation("parallel");
    request.arguments = json!({
        "mode": "parallel",
        "operations": [
            { "capability": "order_slow.read", "arguments": {} },
            { "capability": "order_fast.read", "arguments": {} }
        ]
    });

    let result = router.execute(request).await;
    let data = result.data.unwrap();
    let results = data["results"].as_array().unwrap();

    assert_eq!(results[0]["data"]["capability"], "order_slow.read");
    assert_eq!(results[1]["data"]["capability"], "order_fast.read");
}

struct ConcurrencyProvider {
    current: Arc<AtomicUsize>,
    maximum: Arc<AtomicUsize>,
}

#[async_trait]
impl CapabilityProvider for ConcurrencyProvider {
    fn namespace(&self) -> &'static str {
        "tracked"
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let current = self.current.fetch_add(1, Ordering::SeqCst) + 1;
        self.maximum.fetch_max(current, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(40)).await;
        self.current.fetch_sub(1, Ordering::SeqCst);

        Ok(ProviderResult {
            data: json!({ "id": invocation.arguments["id"] }),
            delta: None,
            verification: VerificationStatus::Verified,
        })
    }
}

#[tokio::test]
async fn parallel_batch_caps_concurrency_at_eight() {
    let current = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let mut router = CapabilityRouter::new();
    router
        .register(Arc::new(ConcurrencyProvider {
            current: Arc::clone(&current),
            maximum: Arc::clone(&maximum),
        }))
        .unwrap();

    let operations = (0..12)
        .map(|id| {
            json!({
                "capability": "tracked.work",
                "arguments": { "id": id }
            })
        })
        .collect::<Vec<_>>();
    let mut request = batch_invocation("parallel");
    request.arguments = json!({
        "mode": "parallel",
        "operations": operations
    });

    let result = router.execute(request).await;

    assert_eq!(result.status, ResultStatus::Success);
    assert_eq!(
        result.data.unwrap()["results"].as_array().unwrap().len(),
        12
    );
    let observed_maximum = maximum.load(Ordering::SeqCst);
    assert!(
        (2..=8).contains(&observed_maximum),
        "observed maximum concurrency was {observed_maximum}"
    );
}

struct DenyBatch;

impl PolicyBroker for DenyBatch {
    fn evaluate(&self, invocation: &InvocationEnvelope) -> PolicyDecision {
        if invocation.capability == "batch.execute" {
            PolicyDecision::Deny {
                reason: "batch denied by parent policy".into(),
            }
        } else {
            PolicyDecision::Allow
        }
    }
}

#[tokio::test]
async fn parent_batch_policy_can_deny_before_any_child_runs() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut router = CapabilityRouter::with_policy(Arc::new(DenyBatch));
    router
        .register(Arc::new(CountingProvider {
            namespace: "allowed",
            calls: Arc::clone(&calls),
        }))
        .unwrap();

    let mut request = batch_invocation("parallel");
    request.arguments = json!({
        "mode": "parallel",
        "operations": [
            { "capability": "allowed.read", "arguments": {} }
        ]
    });

    let result = router.execute(request).await;

    assert_eq!(result.status, ResultStatus::Error);
    assert_eq!(
        result.error.unwrap().code,
        tether_core::ErrorCode::PermissionDenied
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
