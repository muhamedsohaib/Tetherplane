#![forbid(unsafe_code)]

mod output;
mod session;

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{Value, json};
use tether_core::{
    CapabilityError, CapabilityProvider, ErrorCode, HandleRegistry, InvocationEnvelope,
    ProviderResult, ResponseBudget, VerificationStatus,
};

use session::ProcessSession;

const DEFAULT_INITIAL_WAIT_MS: u64 = 250;
const MAX_INITIAL_WAIT_MS: u64 = 10_000;
const OUTPUT_DRAIN_GRACE_MS: u64 = 100;

pub struct ProcessProvider {
    sessions: HandleRegistry<Arc<ProcessSession>>,
}

impl ProcessProvider {
    #[must_use]
    pub fn new() -> Self {
        Self {
            sessions: HandleRegistry::new(),
        }
    }

    async fn run(
        &self,
        arguments: &Value,
        response_mode: tether_core::ResponseMode,
    ) -> Result<Value, CapabilityError> {
        let program = string_argument(arguments, "program")?.to_owned();
        let args = string_array_argument(arguments, "args")?;
        let initial_wait_ms = u64_argument(arguments, "initial_wait_ms", DEFAULT_INITIAL_WAIT_MS)?;
        if initial_wait_ms > MAX_INITIAL_WAIT_MS {
            return Err(invalid_arguments(
                "initial_wait_ms exceeds the maximum supported wait",
            ));
        }

        let session = tokio::task::spawn_blocking(move || ProcessSession::spawn(program, args))
            .await
            .map_err(|error| provider_failure(&format!("process spawn task failed: {error}")))??;
        let handle = self.sessions.insert("proc", Arc::clone(&session));

        let deadline = Instant::now()
            .checked_add(Duration::from_millis(initial_wait_ms))
            .unwrap_or_else(Instant::now);

        let mut status = session.status()?;
        while status.running && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
            status = session.status()?;
        }

        if !status.running {
            let drain_deadline = Instant::now()
                .checked_add(Duration::from_millis(OUTPUT_DRAIN_GRACE_MS))
                .unwrap_or_else(Instant::now);
            while !session.outputs_drained() && Instant::now() < drain_deadline {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        }

        let stdout = session.stdout_snapshot();
        let stderr = session.stderr_snapshot();
        let budget = ResponseBudget::for_mode(response_mode);
        let stdout_budget = budget.apply_text(&stdout.text, 0)?;
        let stderr_budget = budget.apply_text(&stderr.text, 0)?;

        Ok(json!({
            "handle": handle,
            "running": status.running,
            "exit_code": status.exit_code,
            "stdout": stdout_budget.content,
            "stderr": stderr_budget.content,
            "stdout_cursor": stdout.next_cursor,
            "stderr_cursor": stderr.next_cursor,
            "stdout_start_cursor": stdout.start_cursor,
            "stderr_start_cursor": stderr.start_cursor,
            "stdout_truncated_before": stdout.truncated_before,
            "stderr_truncated_before": stderr.truncated_before,
            "stdout_continuation": stdout_budget.continuation.map(|cursor| cursor.offset),
            "stderr_continuation": stderr_budget.continuation.map(|cursor| cursor.offset),
        }))
    }
}

impl Default for ProcessProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl CapabilityProvider for ProcessProvider {
    fn namespace(&self) -> &'static str {
        "process"
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let operation = invocation
            .capability
            .strip_prefix("process.")
            .ok_or_else(|| invalid_arguments("capability must use the process namespace"))?;

        let data = match operation {
            "run" => {
                self.run(&invocation.arguments, invocation.response_mode.clone())
                    .await?
            }
            _ => {
                return Err(CapabilityError {
                    code: ErrorCode::CapabilityUnavailable,
                    message: format!("process operation is unavailable: {operation}"),
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

fn string_argument<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, CapabilityError> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a non-empty string")))
}

fn string_array_argument(arguments: &Value, key: &str) -> Result<Vec<String>, CapabilityError> {
    let Some(value) = arguments.get(key) else {
        return Ok(Vec::new());
    };
    let Some(values) = value.as_array() else {
        return Err(invalid_arguments(&format!(
            "{key} must be an array of strings"
        )));
    };

    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| invalid_arguments(&format!("{key} must contain only strings")))
        })
        .collect()
}

fn u64_argument(arguments: &Value, key: &str, default: u64) -> Result<u64, CapabilityError> {
    let Some(value) = arguments.get(key) else {
        return Ok(default);
    };
    if value.is_null() {
        return Ok(default);
    }
    value
        .as_u64()
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a non-negative integer")))
}

fn invalid_arguments(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
        details: Value::Null,
    }
}

fn provider_failure(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ProviderFailure,
        message: message.to_owned(),
        recovery_hint: None,
        details: Value::Null,
    }
}

pub const CRATE_NAME: &str = "tether-process-provider";
