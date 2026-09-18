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

use output::OutputSlice;
use session::ProcessSession;

const DEFAULT_INITIAL_WAIT_MS: u64 = 250;
const MAX_INITIAL_WAIT_MS: u64 = 10_000;
const OUTPUT_DRAIN_GRACE_MS: u64 = 100;
const DEFAULT_READ_WAIT_MS: u64 = 0;
const MAX_READ_WAIT_MS: u64 = 10_000;
const MAX_INPUT_BYTES: usize = 64 * 1024;

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
        let pty = bool_argument(arguments, "pty", false)?;
        let initial_wait_ms = u64_argument(arguments, "initial_wait_ms", DEFAULT_INITIAL_WAIT_MS)?;
        if initial_wait_ms > MAX_INITIAL_WAIT_MS {
            return Err(invalid_arguments(
                "initial_wait_ms exceeds the maximum supported wait",
            ));
        }

        let session =
            tokio::task::spawn_blocking(move || ProcessSession::spawn(&program, &args, pty))
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
            "pty": session.is_pty(),
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

    async fn read(
        &self,
        arguments: &Value,
        response_mode: tether_core::ResponseMode,
    ) -> Result<Value, CapabilityError> {
        let handle = string_argument(arguments, "handle")?;
        let wait_ms = u64_argument(arguments, "wait_ms", DEFAULT_READ_WAIT_MS)?;
        let offset = optional_i64_argument(arguments, "offset")?;
        if wait_ms > MAX_READ_WAIT_MS {
            return Err(invalid_arguments(
                "wait_ms exceeds the maximum supported wait",
            ));
        }

        let session = self.sessions.with(handle, Arc::clone)?;
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(wait_ms))
            .unwrap_or_else(Instant::now);

        let mut status = session.status()?;
        while offset.is_none()
            && !session.has_unseen_output()
            && status.running
            && Instant::now() < deadline
        {
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

        let explicit = offset.is_some();
        let (stdout, stderr) = match offset {
            Some(offset) => session.explicit_snapshot(offset),
            None => session.incremental_snapshot(),
        };
        let budget = ResponseBudget::for_mode(response_mode);
        let stdout = budget_output(&stdout, &budget)?;
        let stderr = budget_output(&stderr, &budget)?;

        if !explicit {
            session.advance_read_cursors(stdout.cursor, stderr.cursor);
        }

        Ok(json!({
            "handle": handle,
            "running": status.running,
            "exit_code": status.exit_code,
            "stdout": stdout.content,
            "stderr": stderr.content,
            "stdout_cursor": stdout.cursor,
            "stderr_cursor": stderr.cursor,
            "stdout_start_cursor": stdout.start_cursor,
            "stderr_start_cursor": stderr.start_cursor,
            "stdout_truncated_before": stdout.truncated_before,
            "stderr_truncated_before": stderr.truncated_before,
            "stdout_continuation": stdout.continuation,
            "stderr_continuation": stderr.continuation,
        }))
    }

    async fn input(&self, arguments: &Value) -> Result<Value, CapabilityError> {
        let handle = string_argument(arguments, "handle")?;
        let data = string_argument(arguments, "data")?.to_owned();
        if data.len() > MAX_INPUT_BYTES {
            return Err(invalid_arguments("process input exceeds the maximum supported size"));
        }

        let session = self.sessions.with(handle, Arc::clone)?;
        if !session.status()?.running {
            return Err(CapabilityError {
                code: ErrorCode::ProcessFinished,
                message: "cannot write input to a finished process".to_owned(),
                recovery_hint: None,
                details: json!({ "handle": handle }),
            });
        }

        let accepted_bytes =
            tokio::task::spawn_blocking(move || session.write_input(data.as_bytes()))
                .await
                .map_err(|error| provider_failure(&format!("process input task failed: {error}")))??;

        Ok(json!({
            "handle": handle,
            "accepted_bytes": accepted_bytes,
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
            "read" => {
                self.read(&invocation.arguments, invocation.response_mode.clone())
                    .await?
            }
            "input" => self.input(&invocation.arguments).await?,
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

fn bool_argument(arguments: &Value, key: &str, default: bool) -> Result<bool, CapabilityError> {
    let Some(value) = arguments.get(key) else {
        return Ok(default);
    };
    if value.is_null() {
        return Ok(default);
    }
    value
        .as_bool()
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a boolean")))
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

fn optional_i64_argument(arguments: &Value, key: &str) -> Result<Option<i64>, CapabilityError> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_i64()
        .map(Some)
        .ok_or_else(|| invalid_arguments(&format!("{key} must be an integer")))
}

struct DeliveredOutput {
    content: String,
    start_cursor: u64,
    cursor: u64,
    continuation: Option<u64>,
    truncated_before: bool,
}

fn budget_output(
    slice: &OutputSlice,
    budget: &ResponseBudget,
) -> Result<DeliveredOutput, CapabilityError> {
    let budgeted = budget.apply_text(&slice.text, 0)?;
    let delivered_bytes = budgeted
        .continuation
        .as_ref()
        .map_or(slice.text.len(), |cursor| cursor.offset);
    let delivered_bytes = u64::try_from(delivered_bytes).unwrap_or(u64::MAX);
    let cursor = slice
        .start_cursor
        .saturating_add(delivered_bytes)
        .min(slice.next_cursor);
    let continuation = budgeted.continuation.map(|relative| {
        slice
            .start_cursor
            .saturating_add(u64::try_from(relative.offset).unwrap_or(u64::MAX))
            .min(slice.next_cursor)
    });

    Ok(DeliveredOutput {
        content: budgeted.content,
        start_cursor: slice.start_cursor,
        cursor,
        continuation,
        truncated_before: slice.truncated_before,
    })
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
