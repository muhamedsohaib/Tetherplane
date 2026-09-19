use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    CapabilityError, ErrorCode, InvocationEnvelope, ProviderResult, ResultEnvelope,
    VerificationStatus,
};

pub(crate) const MAX_BATCH_CONCURRENCY: usize = 8;
const MAX_BATCH_OPERATIONS: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BatchMode {
    Parallel,
    Sequential,
}

#[derive(Clone, Debug)]
pub(crate) struct BatchOperation {
    pub capability: String,
    pub arguments: Value,
}

#[derive(Clone, Debug)]
pub(crate) struct BatchRequest {
    pub mode: BatchMode,
    pub operations: Vec<BatchOperation>,
    pub stop_on_error: bool,
}

pub(crate) fn parse_batch(arguments: &Value) -> Result<BatchRequest, CapabilityError> {
    let mode = match arguments.get("mode").and_then(Value::as_str) {
        Some("parallel") => BatchMode::Parallel,
        Some("sequential") => BatchMode::Sequential,
        _ => {
            return Err(invalid_arguments(
                "batch mode must be parallel or sequential",
            ));
        }
    };

    let operations = arguments
        .get("operations")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_arguments("batch operations must be an array"))?;

    if operations.is_empty() {
        return Err(invalid_arguments("batch operations cannot be empty"));
    }
    if operations.len() > MAX_BATCH_OPERATIONS {
        return Err(invalid_arguments(
            "batch operations exceed the supported limit",
        ));
    }

    let mut parsed = Vec::with_capacity(operations.len());
    for operation in operations {
        let capability = operation
            .get("capability")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid_arguments("each batch operation requires capability"))?;
        let arguments = operation
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !arguments.is_object() {
            return Err(invalid_arguments(
                "batch operation arguments must be an object",
            ));
        }
        parsed.push(BatchOperation {
            capability: capability.to_owned(),
            arguments,
        });
    }

    let stop_on_error = match arguments.get("stop_on_error") {
        None | Some(Value::Null) => mode == BatchMode::Sequential,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err(invalid_arguments("stop_on_error must be a boolean")),
    };

    Ok(BatchRequest {
        mode,
        operations: parsed,
        stop_on_error,
    })
}

pub(crate) fn child_invocation(
    parent: &InvocationEnvelope,
    operation: &BatchOperation,
) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: parent.protocol_version.clone(),
        request_id: Uuid::new_v4(),
        device_id: parent.device_id.clone(),
        principal_id: parent.principal_id.clone(),
        capability: operation.capability.clone(),
        arguments: operation.arguments.clone(),
        actor: parent.actor.clone(),
        session_id: parent.session_id.clone(),
        response_mode: parent.response_mode.clone(),
        idempotency_key: None,
        preconditions: vec![],
        expectations: vec![],
    }
}

pub(crate) fn batch_result(
    mode: BatchMode,
    results: &[ResultEnvelope],
    stopped_early: bool,
) -> ProviderResult {
    let mode = match mode {
        BatchMode::Parallel => "parallel",
        BatchMode::Sequential => "sequential",
    };

    ProviderResult {
        data: json!({
            "mode": mode,
            "results": results,
            "stopped_early": stopped_early,
        }),
        delta: None,
        verification: VerificationStatus::NotApplicable,
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
