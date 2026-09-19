use std::{collections::HashMap, sync::Arc, time::Instant};

use futures::future::join_all;
use serde_json::json;
use tokio::sync::Semaphore;

use crate::{
    CapabilityError, CapabilityProvider, ErrorCode, InvocationEnvelope, PolicyBroker,
    PolicyDecision, ProviderResult, ResultEnvelope, ResultStatus, Timing, VerificationStatus,
    batch::{BatchMode, MAX_BATCH_CONCURRENCY, batch_result, child_invocation, parse_batch},
};

pub struct CapabilityRouter {
    providers: HashMap<&'static str, Arc<dyn CapabilityProvider>>,
    policy: Option<Arc<dyn PolicyBroker>>,
}

impl CapabilityRouter {
    #[must_use]
    pub fn new() -> Self {
        Self {
            providers: HashMap::new(),
            policy: None,
        }
    }

    #[must_use]
    pub fn with_policy(policy: Arc<dyn PolicyBroker>) -> Self {
        Self {
            providers: HashMap::new(),
            policy: Some(policy),
        }
    }
    /// Registers one provider for its canonical namespace.
    ///
    /// # Errors
    ///
    /// Returns an error when the namespace is already registered.
    pub fn register(
        &mut self,
        provider: Arc<dyn CapabilityProvider>,
    ) -> Result<(), CapabilityError> {
        let namespace = provider.namespace();
        if self.providers.contains_key(namespace) {
            return Err(CapabilityError {
                code: ErrorCode::ProviderFailure,
                message: format!("provider namespace already registered: {namespace}"),
                recovery_hint: None,
                details: json!({ "namespace": namespace }),
            });
        }

        self.providers.insert(namespace, provider);
        Ok(())
    }

    pub async fn execute(&self, invocation: InvocationEnvelope) -> ResultEnvelope {
        if invocation.capability == "batch.execute" {
            return self.execute_batch(invocation).await;
        }

        self.execute_single(invocation).await
    }

    async fn execute_single(&self, invocation: InvocationEnvelope) -> ResultEnvelope {
        let started = Instant::now();
        let Some((namespace, _operation)) = invocation.capability.split_once('.') else {
            return error_envelope(
                &invocation,
                CapabilityError {
                    code: ErrorCode::InvalidArguments,
                    message: "capability must include a namespace separator".into(),
                    recovery_hint: Some("use namespace.operation form".into()),
                    details: json!({ "capability": invocation.capability }),
                },
                started,
            );
        };

        if let Some(result) = self.policy_result(&invocation, started) {
            return result;
        }
        let Some(provider) = self.providers.get(namespace) else {
            return error_envelope(
                &invocation,
                CapabilityError {
                    code: ErrorCode::CapabilityUnavailable,
                    message: format!("capability namespace is unavailable: {namespace}"),
                    recovery_hint: None,
                    details: json!({ "namespace": namespace }),
                },
                started,
            );
        };

        match provider.execute(&invocation).await {
            Ok(output) => success_envelope(&invocation, output, started),
            Err(error) => error_envelope(&invocation, error, started),
        }
    }

    fn policy_result(
        &self,
        invocation: &InvocationEnvelope,
        started: Instant,
    ) -> Option<ResultEnvelope> {
        let policy = self.policy.as_ref()?;
        match policy.evaluate(invocation) {
            PolicyDecision::Allow => None,
            PolicyDecision::Deny { reason } => Some(error_envelope(
                invocation,
                CapabilityError {
                    code: ErrorCode::PermissionDenied,
                    message: reason,
                    recovery_hint: None,
                    details: json!({}),
                },
                started,
            )),
            PolicyDecision::RequireApproval {
                reason,
                approval_scope,
            } => Some(error_envelope(
                invocation,
                CapabilityError {
                    code: ErrorCode::ApprovalRequired,
                    message: reason,
                    recovery_hint: None,
                    details: json!({ "capability": approval_scope.capability }),
                },
                started,
            )),
        }
    }

    async fn execute_batch(&self, invocation: InvocationEnvelope) -> ResultEnvelope {
        let started = Instant::now();
        if let Some(result) = self.policy_result(&invocation, started) {
            return result;
        }

        let request = match parse_batch(&invocation.arguments) {
            Ok(request) => request,
            Err(error) => return error_envelope(&invocation, error, started),
        };

        let (results, stopped_early) = match request.mode {
            BatchMode::Sequential => {
                let mut results = Vec::with_capacity(request.operations.len());
                let mut stopped_early = false;

                for operation in &request.operations {
                    let child = child_invocation(&invocation, operation);
                    let result = self.execute_single(child).await;
                    let failed = result.status == ResultStatus::Error;
                    results.push(result);
                    if failed && request.stop_on_error {
                        stopped_early = true;
                        break;
                    }
                }

                (results, stopped_early)
            }
            BatchMode::Parallel => {
                let semaphore = Arc::new(Semaphore::new(MAX_BATCH_CONCURRENCY));
                let futures = request.operations.iter().map(|operation| {
                    let semaphore = Arc::clone(&semaphore);
                    let child = child_invocation(&invocation, operation);
                    async move {
                        match semaphore.acquire_owned().await {
                            Ok(_permit) => self.execute_single(child).await,
                            Err(error) => error_envelope(
                                &child,
                                CapabilityError {
                                    code: ErrorCode::ProviderFailure,
                                    message: format!(
                                        "batch concurrency limiter closed unexpectedly: {error}"
                                    ),
                                    recovery_hint: None,
                                    details: json!({}),
                                },
                                Instant::now(),
                            ),
                        }
                    }
                });

                (join_all(futures).await, false)
            }
        };

        success_envelope(
            &invocation,
            batch_result(request.mode, &results, stopped_early),
            started,
        )
    }
}

impl Default for CapabilityRouter {
    fn default() -> Self {
        Self::new()
    }
}

fn success_envelope(
    invocation: &InvocationEnvelope,
    output: ProviderResult,
    started: Instant,
) -> ResultEnvelope {
    ResultEnvelope {
        protocol_version: invocation.protocol_version.clone(),
        request_id: invocation.request_id,
        status: ResultStatus::Success,
        data: Some(output.data),
        delta: output.delta,
        error: None,
        verification: output.verification,
        continuation: None,
        policy: None,
        timing: Timing {
            duration_ms: duration_ms(started),
        },
    }
}

fn error_envelope(
    invocation: &InvocationEnvelope,
    error: CapabilityError,
    started: Instant,
) -> ResultEnvelope {
    ResultEnvelope {
        protocol_version: invocation.protocol_version.clone(),
        request_id: invocation.request_id,
        status: ResultStatus::Error,
        data: None,
        delta: None,
        error: Some(error),
        verification: VerificationStatus::Failed,
        continuation: None,
        policy: None,
        timing: Timing {
            duration_ms: duration_ms(started),
        },
    }
}

fn duration_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}
