use std::{collections::HashMap, sync::Arc, time::Instant};

use serde_json::json;

use crate::{
    CapabilityError, CapabilityProvider, ErrorCode, InvocationEnvelope, ProviderResult,
    ResultEnvelope, ResultStatus, Timing, VerificationStatus,
};

pub struct CapabilityRouter {
    providers: HashMap<&'static str, Arc<dyn CapabilityProvider>>,
}

impl CapabilityRouter {
    #[must_use]
    pub fn new() -> Self {
        Self {
            providers: HashMap::new(),
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
