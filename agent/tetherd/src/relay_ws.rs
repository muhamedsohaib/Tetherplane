use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{Sink, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tether_core::{
    CapabilityError, ErrorCode, InvocationEnvelope, ResultEnvelope, ResultStatus, Timing,
    VerificationStatus,
};
use tokio::sync::{Mutex, Semaphore};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::{Error as WebSocketError, Message};
use url::Url;

use crate::runtime::AgentRuntime;

const DEVICE_ID_HEADER: HeaderName = HeaderName::from_static("x-tetherplane-device-id");
const MAX_IN_FLIGHT_WORK: usize = 16;
const MAX_IN_FLIGHT_CONTROL: usize = 4;

pub(crate) struct RelayConfig {
    pub url: String,
    pub device_id: String,
    pub credential: String,
    pub allow_insecure_localhost: bool,
    pub reconnect_delay: Duration,
}

enum RelayFailure {
    Fatal(String),
    Retryable(String),
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum RelayInbound {
    #[serde(rename = "invoke")]
    Invoke {
        #[serde(rename = "routeId")]
        route_id: String,
        invocation: InvocationEnvelope,
    },
}

#[derive(Serialize)]
struct RelayOutbound<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(rename = "routeId")]
    route_id: &'a str,
    result: &'a ResultEnvelope,
}

pub(crate) fn validate_relay_url(url: &str, allow_insecure_localhost: bool) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|error| format!("invalid relay URL: {error}"))?;
    match parsed.scheme() {
        "wss" => Ok(()),
        "ws" if allow_insecure_localhost && is_loopback_host(parsed.host_str()) => Ok(()),
        "ws" => Err(
            "relay URL must use wss://; ws:// is allowed only for explicit loopback test mode"
                .to_owned(),
        ),
        _ => Err("relay URL must use wss://".to_owned()),
    }
}

fn is_loopback_host(host: Option<&str>) -> bool {
    matches!(host, Some("localhost" | "127.0.0.1" | "::1"))
}
pub(crate) fn load_device_credential(path: &Path) -> Result<String, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("failed to read device credential file: {error}"))?;
    let credential = content.trim();
    if credential.len() < 16 {
        return Err("device credential file is empty or too short".to_owned());
    }
    Ok(credential.to_owned())
}

pub(crate) async fn serve(runtime: Arc<AgentRuntime>, config: RelayConfig) -> Result<(), String> {
    validate_relay_url(&config.url, config.allow_insecure_localhost)?;
    // Persist budgets across reconnects so orphaned operations cannot evade limits.
    let work_slots = Arc::new(Semaphore::new(MAX_IN_FLIGHT_WORK));
    let control_slots = Arc::new(Semaphore::new(MAX_IN_FLIGHT_CONTROL));

    loop {
        match connect_and_run(
            Arc::clone(&runtime),
            &config,
            Arc::clone(&work_slots),
            Arc::clone(&control_slots),
        )
        .await
        {
            Ok(()) => {
                tokio::time::sleep(config.reconnect_delay).await;
            }
            Err(RelayFailure::Fatal(message)) => return Err(message),
            Err(RelayFailure::Retryable(message)) => {
                eprintln!("relay connection lost: {message}");
                tokio::time::sleep(config.reconnect_delay).await;
            }
        }
    }
}

async fn connect_and_run(
    runtime: Arc<AgentRuntime>,
    config: &RelayConfig,
    work_slots: Arc<Semaphore>,
    control_slots: Arc<Semaphore>,
) -> Result<(), RelayFailure> {
    let mut request = config
        .url
        .as_str()
        .into_client_request()
        .map_err(|error| RelayFailure::Fatal(format!("invalid relay request: {error}")))?;
    let authorization =
        HeaderValue::from_str(&format!("Device {}", config.credential)).map_err(|_| {
            RelayFailure::Fatal("device credential contains invalid header bytes".into())
        })?;
    let device_id = HeaderValue::from_str(&config.device_id)
        .map_err(|_| RelayFailure::Fatal("device ID contains invalid header bytes".into()))?;
    request.headers_mut().insert(AUTHORIZATION, authorization);
    request.headers_mut().insert(DEVICE_ID_HEADER, device_id);

    let (socket, _) = connect_async(request)
        .await
        .map_err(|error| classify_connect_error(&error))?;

    // Execution never owns the socket reader. A blocked provider must not
    // prevent independent status requests or WebSocket Ping from being read.
    let (writer, mut reader) = socket.split();
    let writer = Arc::new(Mutex::new(writer));
    while let Some(next) = reader.next().await {
        let message = next.map_err(|error| {
            RelayFailure::Retryable(format!("websocket receive failed: {error}"))
        })?;
        match message {
            Message::Text(text) => {
                let inbound =
                    serde_json::from_str::<RelayInbound>(text.as_str()).map_err(|error| {
                        RelayFailure::Retryable(format!(
                            "relay sent invalid invocation message: {error}"
                        ))
                    })?;
                let RelayInbound::Invoke {
                    route_id,
                    invocation,
                } = inbound;
                // Reserved control capacity survives a saturated work queue.
                let slots = if matches!(
                    invocation.capability.as_str(),
                    "device.status" | "device.capabilities"
                ) {
                    Arc::clone(&control_slots)
                } else {
                    Arc::clone(&work_slots)
                };
                let permit = match slots.try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        let busy = overloaded_result(&invocation);
                        write_invocation_result(Arc::clone(&writer), route_id, async move { busy })
                            .await;
                        continue;
                    }
                };
                let local_device_id = config.device_id.clone();
                let runtime = Arc::clone(&runtime);
                let writer = Arc::clone(&writer);
                // Dropping the JoinHandle detaches execution: a connection
                // failure must not cancel a mutation after it has begun.
                drop(tokio::spawn(async move {
                    let _permit = permit;
                    write_invocation_result(writer, route_id, async move {
                        if invocation.device_id.as_deref() == Some(local_device_id.as_str()) {
                            runtime.execute(invocation).await
                        } else {
                            wrong_device_result(&invocation, &local_device_id)
                        }
                    })
                    .await;
                }));
            }
            Message::Ping(payload) => {
                writer
                    .lock()
                    .await
                    .send(Message::Pong(payload))
                    .await
                    .map_err(|error| {
                        RelayFailure::Retryable(format!("websocket pong failed: {error}"))
                    })?;
            }
            Message::Close(_) => return Ok(()),
            Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }

    Ok(())
}

// The lock is acquired only after the provider future is complete, so a
// stalled operation cannot monopolize the result writer.
async fn write_invocation_result<S, F>(writer: Arc<Mutex<S>>, route_id: String, execution: F)
where
    S: Sink<Message> + Unpin + Send + 'static,
    S::Error: std::fmt::Display,
    F: Future<Output = ResultEnvelope> + Send,
{
    let result = execution.await;
    let payload = match serde_json::to_string(&RelayOutbound {
        kind: "result",
        route_id: &route_id,
        result: &result,
    }) {
        Ok(payload) => payload,
        Err(error) => {
            eprintln!("failed to serialize relay result: {error}");
            return;
        }
    };
    if let Err(error) = writer
        .lock()
        .await
        .send(Message::Text(payload.into()))
        .await
    {
        eprintln!("websocket result send failed: {error}");
    }
}

fn overloaded_result(invocation: &InvocationEnvelope) -> ResultEnvelope {
    ResultEnvelope {
        protocol_version: "1.0".into(),
        request_id: invocation.request_id,
        status: ResultStatus::Error,
        data: None,
        delta: None,
        error: Some(CapabilityError {
            code: ErrorCode::ResourceConflict,
            message: "device execution capacity is temporarily exhausted".into(),
            recovery_hint: None,
            details: json!({}),
        }),
        verification: VerificationStatus::Failed,
        continuation: None,
        policy: None,
        timing: Timing { duration_ms: 0 },
    }
}

fn classify_connect_error(error: &WebSocketError) -> RelayFailure {
    if let WebSocketError::Http(response) = &error
        && matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        )
    {
        return RelayFailure::Fatal(format!(
            "relay rejected device authentication with HTTP {}",
            response.status()
        ));
    }
    RelayFailure::Retryable(format!("relay connection failed: {error}"))
}

fn wrong_device_result(invocation: &InvocationEnvelope, local_device_id: &str) -> ResultEnvelope {
    ResultEnvelope {
        protocol_version: "1.0".into(),
        request_id: invocation.request_id,
        status: ResultStatus::Error,
        data: None,
        delta: None,
        error: Some(CapabilityError {
            code: ErrorCode::PermissionDenied,
            message: "remote invocation is addressed to a different device".into(),
            recovery_hint: None,
            details: json!({
                "requested_device": invocation.device_id,
                "local_device": local_device_id,
            }),
        }),
        verification: VerificationStatus::Failed,
        continuation: None,
        policy: None,
        timing: Timing { duration_ms: 0 },
    }
}
#[cfg(test)]
mod tests {
    use super::validate_relay_url;

    // Regression gate: a stalled operation must not block the socket reader,
    // which also handles independent device.status requests and WebSocket Ping.
    #[test]
    fn relay_reader_does_not_await_invocation_execution_inline() {
        let source = include_str!("relay_ws.rs");
        assert!(
            !source.contains(&["while let Some(next)", " = socket.next().await"].concat()),
            "a single socket-read loop must not await individual operations"
        );
    }

    #[tokio::test]
    async fn stalled_work_does_not_block_control_result_delivery() {
        use super::{
            ResultEnvelope, ResultStatus, Timing, VerificationStatus, write_invocation_result,
        };
        use futures_util::{StreamExt, channel::mpsc};
        use std::sync::Arc;
        use std::time::Duration;
        use tokio::sync::Mutex;

        let (sink, mut messages) = mpsc::channel(4);
        let writer = Arc::new(Mutex::new(sink));
        let stalled = tokio::spawn(write_invocation_result(
            Arc::clone(&writer),
            "slow-route".to_owned(),
            std::future::pending::<ResultEnvelope>(),
        ));
        let status = tokio::spawn(write_invocation_result(
            Arc::clone(&writer),
            "status-route".to_owned(),
            async {
                ResultEnvelope {
                    protocol_version: "1.0".into(),
                    request_id: uuid::Uuid::new_v4(),
                    status: ResultStatus::Success,
                    data: Some(serde_json::json!({ "agent": "ready" })),
                    delta: None,
                    error: None,
                    verification: VerificationStatus::NotApplicable,
                    continuation: None,
                    policy: None,
                    timing: Timing { duration_ms: 0 },
                }
            },
        ));
        let received = tokio::time::timeout(Duration::from_millis(250), messages.next())
            .await
            .expect("control response must not wait for stalled work")
            .expect("result writer disconnected");
        let tokio_tungstenite::tungstenite::Message::Text(payload) = received else {
            panic!("expected a result message");
        };
        let parsed: serde_json::Value = serde_json::from_str(payload.as_str()).unwrap();
        assert_eq!(parsed["routeId"], "status-route");
        assert_eq!(parsed["result"]["status"], "success");
        status.await.unwrap();
        stalled.abort();
    }

    #[test]
    fn relay_url_requires_wss_except_explicit_loopback_test_mode() {
        assert!(validate_relay_url("wss://relay.example.test/device", false).is_ok());
        assert!(validate_relay_url("ws://127.0.0.1:8765/device", true).is_ok());
        assert!(validate_relay_url("ws://localhost:8765/device", true).is_ok());
        assert!(validate_relay_url("ws://relay.example.test/device", false).is_err());
        assert!(validate_relay_url("http://relay.example.test/device", true).is_err());
    }
}
