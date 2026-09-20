#![forbid(unsafe_code)]

use std::net::SocketAddr;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tether_core::{
    CapabilityError, CapabilityProvider, ErrorCode, InvocationEnvelope, ProviderResult,
    VerificationStatus,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time::timeout;

#[derive(Clone, Debug)]
pub struct BrowserBridgeConfig {
    pub address: String,
    pub token: Option<String>,
    pub timeout_ms: u64,
}

pub struct BrowserProvider {
    config: BrowserBridgeConfig,
    operations: Vec<String>,
}

impl BrowserProvider {
    /// Connects to an authenticated local browser bridge and records its advertised operations.
    ///
    /// # Errors
    ///
    /// Returns a capability error when the endpoint is invalid or non-loopback, the bridge cannot
    /// be reached within the configured timeout, authentication fails, or the handshake is malformed.
    pub async fn connect(config: BrowserBridgeConfig) -> Result<Self, CapabilityError> {
        if config.address.trim().is_empty() {
            return Err(invalid("browser bridge address must be non-empty"));
        }
        let address = config
            .address
            .parse::<SocketAddr>()
            .map_err(|_| invalid("browser bridge address must be an IP socket address"))?;
        if !address.ip().is_loopback() {
            return Err(invalid("browser bridge address must be loopback-only"));
        }
        let response = rpc_call(
            &config,
            json!({
                "type": "handshake",
                "request_id": "handshake",
                "token": config.token,
            }),
        )
        .await?;
        if response["status"] != "success" {
            return Err(response_error(&response));
        }
        let operations = response
            .pointer("/data/operations")
            .and_then(Value::as_array)
            .ok_or_else(|| provider_failure("browser bridge handshake omitted operations"))?
            .iter()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        Ok(Self { config, operations })
    }

    #[must_use]
    pub fn operations(&self) -> &[String] {
        &self.operations
    }
}

#[async_trait]
impl CapabilityProvider for BrowserProvider {
    fn namespace(&self) -> &'static str {
        "browser"
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let mut arguments = invocation.arguments.clone();
        if let Some(object) = arguments.as_object_mut() {
            object.remove("ownership");
        }
        let response = rpc_call(
            &self.config,
            json!({
                "type": "invoke",
                "request_id": invocation.request_id.to_string(),
                "token": self.config.token,
                "capability": invocation.capability,
                "arguments": arguments,
                "principal_id": invocation.principal_id,
                "job_id": invocation.job_id,
                "session_id": invocation.session_id,
                "idempotency_key": invocation.idempotency_key,
                "preconditions": invocation.preconditions,
                "expectations": invocation.expectations,
            }),
        )
        .await?;

        if response["status"] != "success" {
            return Err(response_error(&response));
        }

        Ok(ProviderResult {
            data: response.get("data").cloned().unwrap_or(Value::Null),
            delta: response.get("delta").cloned(),
            verification: parse_verification(response.get("verification")),
        })
    }
}

async fn rpc_call(config: &BrowserBridgeConfig, request: Value) -> Result<Value, CapabilityError> {
    let duration = Duration::from_millis(config.timeout_ms.clamp(100, 60_000));
    let stream = timeout(duration, TcpStream::connect(&config.address))
        .await
        .map_err(|_| timeout_error("timed out connecting to browser bridge"))?
        .map_err(|_| disconnected("browser bridge is unavailable"))?;
    let (read, mut write) = stream.into_split();
    let encoded = serde_json::to_vec(&request)
        .map_err(|_| provider_failure("failed to serialize browser bridge request"))?;
    timeout(duration, async {
        write.write_all(&encoded).await?;
        write.write_all(b"\n").await?;
        write.flush().await
    })
    .await
    .map_err(|_| timeout_error("timed out writing to browser bridge"))?
    .map_err(|_| disconnected("browser bridge disconnected during request"))?;

    let mut lines = BufReader::new(read).lines();
    let line = timeout(duration, lines.next_line())
        .await
        .map_err(|_| timeout_error("timed out waiting for browser bridge"))?
        .map_err(|_| disconnected("browser bridge disconnected during response"))?
        .ok_or_else(|| disconnected("browser bridge closed without a response"))?;
    serde_json::from_str(&line)
        .map_err(|_| provider_failure("browser bridge returned invalid JSON"))
}

fn response_error(response: &Value) -> CapabilityError {
    let error = response.get("error").unwrap_or(&Value::Null);
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("provider_failure");
    CapabilityError {
        code: map_error_code(code),
        message: error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("browser provider failed")
            .to_owned(),
        recovery_hint: error
            .get("recovery_hint")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        details: error.get("details").cloned().unwrap_or(Value::Null),
    }
}

fn map_error_code(code: &str) -> ErrorCode {
    match code {
        "invalid_arguments" => ErrorCode::InvalidArguments,
        "capability_unavailable" => ErrorCode::CapabilityUnavailable,
        "permission_denied" => ErrorCode::PermissionDenied,
        "approval_required" => ErrorCode::ApprovalRequired,
        "foreground_lease_required" => ErrorCode::ForegroundLeaseRequired,
        "human_activity_conflict" => ErrorCode::HumanActivityConflict,
        "stale_reference" => ErrorCode::StaleReference,
        "resource_conflict" => ErrorCode::ResourceConflict,
        "precondition_failed" => ErrorCode::PreconditionFailed,
        "action_unverified" | "validation_failed" | "semantic_wait_timeout" => {
            ErrorCode::ActionUnverified
        }
        "timeout" => ErrorCode::Timeout,
        "disconnected" => ErrorCode::Disconnected,
        _ => ErrorCode::ProviderFailure,
    }
}

fn parse_verification(value: Option<&Value>) -> VerificationStatus {
    match value.and_then(Value::as_str) {
        Some("verified") => VerificationStatus::Verified,
        Some("executed_unverified") => VerificationStatus::ExecutedUnverified,
        Some("failed") => VerificationStatus::Failed,
        _ => VerificationStatus::NotApplicable,
    }
}

fn invalid(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}
fn provider_failure(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ProviderFailure,
        message: message.to_owned(),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}
fn disconnected(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::Disconnected,
        message: message.to_owned(),
        recovery_hint: Some("restart or reconnect the local browser bridge".into()),
        details: serde_json::json!({}),
    }
}
fn timeout_error(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::Timeout,
        message: message.to_owned(),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}
