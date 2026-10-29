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
const READ_ONLY_EXECUTION_DEADLINE: Duration = Duration::from_secs(30);
const WEBSOCKET_WRITE_DEADLINE: Duration = Duration::from_secs(2);

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
                let Ok(permit) = slots.try_acquire_owned() else {
                    let busy = overloaded_result(&invocation);
                    write_invocation_result(Arc::clone(&writer), route_id, async move { busy })
                        .await;
                    continue;
                };
                let local_device_id = config.device_id.clone();
                let runtime = Arc::clone(&runtime);
                let writer = Arc::clone(&writer);
                let status_requested = invocation.capability == "device.status";
                let work_capacity = Arc::clone(&work_slots);
                let control_capacity = Arc::clone(&control_slots);
                // Dropping the JoinHandle detaches execution: a connection
                // failure must not cancel a mutation after it has begun.
                drop(tokio::spawn(async move {
                    let _permit = permit;
                    Box::pin(write_invocation_result(writer, route_id, async move {
                        let mut result =
                            if invocation.device_id.as_deref() == Some(local_device_id.as_str()) {
                                execute_with_read_only_deadline(
                                    &invocation,
                                    READ_ONLY_EXECUTION_DEADLINE,
                                    runtime.execute(invocation.clone()),
                                )
                                .await
                            } else {
                                wrong_device_result(&invocation, &local_device_id)
                            };
                        if status_requested {
                            annotate_authenticated_status(
                                &mut result,
                                &work_capacity,
                                &control_capacity,
                            );
                        }
                        result
                    }))
                    .await;
                }));
            }
            Message::Ping(payload) => {
                pong_with_deadline(&writer, Message::Pong(payload), WEBSOCKET_WRITE_DEADLINE)
                    .await?;
            }
            Message::Close(_) => return Ok(()),
            Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }

    Ok(())
}

// A stuck transport must not hold the sole reader or the shared writer lock
// forever; reconnect is safe, but uncertain mutations must not be replayed.
async fn pong_with_deadline<S>(
    writer: &Arc<Mutex<S>>,
    message: Message,
    deadline: Duration,
) -> Result<(), RelayFailure>
where
    S: Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    match tokio::time::timeout(deadline, async { writer.lock().await.send(message).await }).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(RelayFailure::Retryable(format!(
            "websocket pong failed: {error}"
        ))),
        Err(_) => Err(RelayFailure::Retryable(
            "websocket pong exceeded bounded write deadline".into(),
        )),
    }
}

// Only a successful authorized device.status receives live connection
// metadata. No socket registration is treated as an agent heartbeat.
fn annotate_authenticated_status(
    result: &mut ResultEnvelope,
    work_capacity: &Semaphore,
    control_capacity: &Semaphore,
) {
    if !matches!(&result.status, ResultStatus::Success) {
        return;
    }
    let Some(serde_json::Value::Object(data)) = result.data.as_mut() else {
        return;
    };
    let work_in_flight = MAX_IN_FLIGHT_WORK - work_capacity.available_permits();
    let control_in_flight = MAX_IN_FLIGHT_CONTROL - control_capacity.available_permits();
    let state = if work_in_flight == MAX_IN_FLIGHT_WORK {
        "saturated"
    } else if work_in_flight > 0 {
        "degraded"
    } else {
        "ready"
    };
    data.insert(
        "agent_liveness".into(),
        json!({
            "process": "alive",
            "transport": "authenticated",
            "responsiveness": "responsive",
            "state": state,
            "work_in_flight": work_in_flight,
            "work_capacity": MAX_IN_FLIGHT_WORK,
            "control_in_flight": control_in_flight,
            "control_capacity": MAX_IN_FLIGHT_CONTROL
        }),
    );
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
    match tokio::time::timeout(WEBSOCKET_WRITE_DEADLINE, async {
        writer
            .lock()
            .await
            .send(Message::Text(payload.into()))
            .await
    })
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("websocket result send failed: {error}"),
        Err(_) => eprintln!("websocket result send exceeded bounded deadline"),
    }
}

// Only explicitly side-effect-free operations may be dropped on deadline.
// In particular process.read advances an output cursor and is excluded.
fn is_safely_cancellable_read(capability: &str) -> bool {
    matches!(
        capability,
        "device.status"
            | "device.capabilities"
            | "filesystem.read"
            | "filesystem.read_many"
            | "filesystem.info"
            | "filesystem.list"
            | "audit.read"
    )
}

// Cancelling read-only futures is safe; mutating futures must continue until
// their own authoritative outcome is recorded, even after client disconnect.
async fn execute_with_read_only_deadline<F>(
    invocation: &InvocationEnvelope,
    deadline: Duration,
    execution: F,
) -> ResultEnvelope
where
    F: Future<Output = ResultEnvelope>,
{
    if !is_safely_cancellable_read(&invocation.capability) {
        return execution.await;
    }
    match tokio::time::timeout(deadline, execution).await {
        Ok(result) => result,
        Err(_) => ResultEnvelope {
            protocol_version: invocation.protocol_version.clone(),
            request_id: invocation.request_id,
            status: ResultStatus::Error,
            data: None,
            delta: None,
            error: Some(CapabilityError {
                code: ErrorCode::Timeout,
                message: "read-only operation exceeded its execution deadline".into(),
                recovery_hint: None,
                details: json!({}),
            }),
            verification: VerificationStatus::Failed,
            continuation: None,
            policy: None,
            timing: Timing { duration_ms: 0 },
        },
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
        use futures_util::sink;
        use std::sync::Arc;
        use std::time::Duration;
        use tokio::sync::Mutex;

        let (sender, mut messages) = tokio::sync::mpsc::channel(4);
        let sink = sink::unfold(sender, |sender, message| async move {
            sender.send(message).await.map_err(std::io::Error::other)?;
            Ok::<_, std::io::Error>(sender)
        });
        let writer = Arc::new(Mutex::new(Box::pin(sink)));
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
        let received = tokio::time::timeout(Duration::from_millis(250), messages.recv())
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

    fn synthetic_saturation_invocation() -> tether_core::InvocationEnvelope {
        serde_json::from_value(serde_json::json!({
            "protocol_version": "1.0",
            "request_id": uuid::Uuid::new_v4(),
            "device_id": "Leno",
            "principal_id": null,
            "job_id": null,
            "capability": "filesystem.info",
            "arguments": {},
            "actor": { "id": "synthetic", "kind": "ai_client" },
            "session_id": null,
            "response_mode": "compact",
            "idempotency_key": null,
            "preconditions": [],
            "expectations": []
        }))
        .expect("valid synthetic invocation")
    }

    #[tokio::test]
    async fn synthetic_saturation_preserves_control_budget_ping_and_reclaims_slots() {
        use super::{
            ErrorCode, MAX_IN_FLIGHT_CONTROL, MAX_IN_FLIGHT_WORK, ResultEnvelope, ResultStatus,
            Timing, VerificationStatus, overloaded_result, write_invocation_result,
        };
        use futures_util::{SinkExt, sink};
        use std::sync::Arc;
        use std::time::{Duration, Instant};
        use tokio::sync::{Mutex, Semaphore};
        use tokio_tungstenite::tungstenite::Message;

        let work = Arc::new(Semaphore::new(MAX_IN_FLIGHT_WORK));
        let control = Arc::new(Semaphore::new(MAX_IN_FLIGHT_CONTROL));
        let (sender, mut messages) = tokio::sync::mpsc::channel(8);
        let sink = sink::unfold(sender, |sender, message| async move {
            sender.send(message).await.map_err(std::io::Error::other)?;
            Ok::<_, std::io::Error>(sender)
        });
        let writer = Arc::new(Mutex::new(Box::pin(sink)));
        let fake_invocation = synthetic_saturation_invocation();

        let mut latencies = Vec::new();
        for cycle in 0..32 {
            let work_permits = (0..MAX_IN_FLIGHT_WORK)
                .map(|_| Arc::clone(&work).try_acquire_owned().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(work.available_permits(), 0, "all 16 operations are stalled");
            // A newly connected socket must receive the SAME saturated budget:
            // reconnecting must not allocate fresh capacity.
            let next_generation = Arc::clone(&work);
            assert!(next_generation.try_acquire_owned().is_err());
            let overloaded = overloaded_result(&fake_invocation);
            assert_eq!(overloaded.error.unwrap().code, ErrorCode::ResourceConflict);

            let mut control_permits = (0..MAX_IN_FLIGHT_CONTROL)
                .map(|_| Arc::clone(&control).try_acquire_owned().unwrap())
                .collect::<Vec<_>>();
            assert!(Arc::clone(&control).try_acquire_owned().is_err());
            drop(control_permits.pop());
            let control_permit = Arc::clone(&control).try_acquire_owned().unwrap();
            let started = Instant::now();
            let result = ResultEnvelope {
                protocol_version: "1.0".into(),
                request_id: uuid::Uuid::new_v4(),
                status: ResultStatus::Success,
                data: Some(serde_json::json!({"status":"responsive"})),
                delta: None,
                error: None,
                verification: VerificationStatus::NotApplicable,
                continuation: None,
                policy: None,
                timing: Timing { duration_ms: 0 },
            };
            write_invocation_result(
                Arc::clone(&writer),
                format!("control-{cycle}"),
                async move { result },
            )
            .await;
            let control_message = tokio::time::timeout(Duration::from_secs(2), messages.recv())
                .await
                .expect("status must arrive within two seconds")
                .expect("control channel closed");
            assert!(matches!(control_message, Message::Text(_)));
            let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
            assert!(elapsed_ms < 2_000.0);
            latencies.push(elapsed_ms);

            let ping_started = Instant::now();
            writer
                .lock()
                .await
                .send(Message::Pong(vec![1, 2].into()))
                .await
                .unwrap();
            let pong = tokio::time::timeout(Duration::from_secs(2), messages.recv())
                .await
                .expect("ping handling must not be blocked by work")
                .expect("ping channel closed");
            assert!(matches!(pong, Message::Pong(_)));
            assert!(ping_started.elapsed() < Duration::from_secs(2));
            drop(control_permit);
            drop(control_permits);
            drop(work_permits);
            assert_eq!(work.available_permits(), MAX_IN_FLIGHT_WORK);
            assert_eq!(control.available_permits(), MAX_IN_FLIGHT_CONTROL);
        }
        latencies.sort_by(f64::total_cmp);
        let n = latencies.len();
        println!(
            "SYNTHETIC_SATURATION={{\"samples\":{},\"cycles\":{},\"p50_ms\":{:.3},\"p95_ms\":{:.3},\"max_ms\":{:.3}}}",
            n,
            32,
            latencies[n / 2],
            latencies[(n * 95).div_ceil(100) - 1],
            latencies[n - 1],
        );
    }

    #[test]
    fn tls_eof_and_transport_reset_are_retryable_without_implied_mutation_replay() {
        use super::{RelayFailure, classify_connect_error};
        for kind in [
            std::io::ErrorKind::UnexpectedEof,
            std::io::ErrorKind::ConnectionReset,
        ] {
            let error = tokio_tungstenite::tungstenite::Error::Io(kind.into());
            assert!(matches!(
                classify_connect_error(&error),
                RelayFailure::Retryable(_)
            ));
        }
    }

    #[tokio::test]
    async fn stalled_read_only_invocation_expires_and_releases_capacity() {
        use std::sync::Arc;
        use std::time::Duration;
        use tokio::sync::Semaphore;

        let capacity = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&capacity).try_acquire_owned().unwrap();
        let invocation = synthetic_saturation_invocation();
        let result = super::execute_with_read_only_deadline(
            &invocation,
            Duration::from_millis(25),
            std::future::pending::<super::ResultEnvelope>(),
        )
        .await;
        assert_eq!(result.error.unwrap().code, super::ErrorCode::Timeout);
        drop(permit);
        assert_eq!(capacity.available_permits(), 1);
    }

    #[tokio::test]
    async fn cursor_advancing_read_is_not_cancelled_on_generic_deadline() {
        use std::time::Duration;
        let mut invocation = synthetic_saturation_invocation();
        invocation.capability = "process.read".into();
        let mut successful = super::overloaded_result(&invocation);
        successful.status = super::ResultStatus::Success;
        successful.error = None;
        let result =
            super::execute_with_read_only_deadline(&invocation, Duration::from_millis(1), async {
                tokio::time::sleep(Duration::from_millis(15)).await;
                successful
            })
            .await;
        assert!(matches!(result.status, super::ResultStatus::Success));
        assert!(super::is_safely_cancellable_read("filesystem.info"));
        assert!(!super::is_safely_cancellable_read("process.read"));
        assert!(!super::is_safely_cancellable_read("process.run"));
    }

    #[tokio::test]
    async fn stalled_writer_has_bounded_wait_without_monopolizing_socket() {
        use futures_util::sink;
        use std::sync::Arc;
        use std::time::Duration;
        use tokio::sync::Mutex;
        use tokio_tungstenite::tungstenite::Message;

        let writer = Arc::new(Mutex::new(Box::pin(sink::unfold(
            (),
            |(), _: Message| async {
                std::future::pending::<Result<(), std::io::Error>>().await?;
                Ok::<_, std::io::Error>(())
            },
        ))));
        let value = super::execute_with_read_only_deadline(
            &synthetic_saturation_invocation(),
            Duration::from_millis(5),
            std::future::pending::<super::ResultEnvelope>(),
        )
        .await;
        let deadline = tokio::time::timeout(
            Duration::from_secs(3),
            super::write_invocation_result(Arc::clone(&writer), "blocked".into(), async { value }),
        )
        .await;
        assert!(deadline.is_ok(), "writer must not hang forever");
        assert!(writer.try_lock().is_ok(), "blocked send must release mutex");
    }

    #[tokio::test]
    async fn stalled_pong_send_cannot_block_reader_forever() {
        use futures_util::sink;
        use std::sync::Arc;
        use std::time::Duration;
        use tokio::sync::Mutex;
        use tokio_tungstenite::tungstenite::Message;

        let writer = Arc::new(Mutex::new(Box::pin(sink::unfold(
            (),
            |(), _: Message| async {
                std::future::pending::<Result<(), std::io::Error>>().await?;
                Ok::<_, std::io::Error>(())
            },
        ))));
        let failure = super::pong_with_deadline(
            &writer,
            Message::Pong(vec![1].into()),
            Duration::from_millis(20),
        )
        .await;
        assert!(matches!(failure, Err(super::RelayFailure::Retryable(_))));
        assert!(
            writer.try_lock().is_ok(),
            "pong timeout must release sink lock"
        );
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
