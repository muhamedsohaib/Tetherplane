use std::collections::{BTreeSet, VecDeque};
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{Sink, SinkExt, Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tether_core::{
    AckStatus, CapabilityError, DesiredPolicy, EffectivePolicy, ErrorCode, InvocationEnvelope,
    PolicyAcknowledgment, PrincipalProfile, ResultEnvelope, ResultStatus, Timing,
    VerificationStatus,
};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::{Error as WebSocketError, Message};
use url::Url;

use crate::runtime::AgentRuntime;

const DEVICE_ID_HEADER: HeaderName = HeaderName::from_static("x-tetherplane-device-id");

// S1 heartbeat bounds (normative in docs/CONNECTION_STATE_MACHINE.md):
// one missed/unechoed Pong -> Suspect <= 15s, deadline expiry -> Reconnect.
const RELAY_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const RELAY_SUSPECT_TIMEOUT: Duration = Duration::from_secs(15);
const RELAY_DEAD_TIMEOUT: Duration = Duration::from_secs(20);
// Every socket send (hello/result/Ping/Pong) is bounded so a stalled
// socket can never block the heartbeat or the ordered work queue.
const RELAY_SEND_TIMEOUT: Duration = Duration::from_secs(5);
// Connecting -> Connected bound.
const RELAY_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
// Ordered work queue bounds: 16 queued invokes, 4 MiB queued bytes,
// 5 s maximum wait before dispatch. Overfull/expired work is rejected
// per-route (ResourceConflict) so ordered delivery is never silently dropped.
const RELAY_PENDING_LIMIT: usize = 16;
const RELAY_PENDING_BYTES: usize = 4 * 1024 * 1024;
const RELAY_PENDING_WAIT: Duration = Duration::from_secs(5);

pub(crate) struct RelayConfig {
    pub url: String,
    pub device_id: String,
    pub credential: String,
    pub allow_insecure_localhost: bool,
    pub reconnect_delay: Duration,
    pub principal_profile: Option<PrincipalProfile>,
}

#[derive(Debug)]
enum RelayFailure {
    Fatal(String),
    Retryable(String),
}
/// Large-variant spread is inherent (invoke envelopes dwarf policy
/// pushes) and harmless: values are transient per-message parses.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum RelayInbound {
    #[serde(rename = "invoke")]
    Invoke {
        #[serde(rename = "routeId")]
        route_id: String,
        invocation: InvocationEnvelope,
    },
    #[serde(rename = "policy")]
    Policy {
        version: u64,
        #[serde(rename = "allowedCapabilities")]
        allowed_capabilities: BTreeSet<String>,
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

/// Dedicated policy acknowledgment channel (S4): acks never ride the
/// result path, so they cannot be confused with routed call outcomes.
#[derive(Serialize)]
struct RelayPolicyAck<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    version: u64,
    status: AckStatus,
    #[serde(rename = "appliedCapabilities")]
    applied_capabilities: &'a BTreeSet<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: &'a Option<String>,
}

/// Tracks round-trip liveness independently of work execution.
/// Only an unechoed Ping (missing Pong) advances toward Suspect/Dead;
/// any Pong resets the deadline, so a healthy peer never triggers reconnect.
struct RelayHeartbeat {
    last_pong: Instant,
    suspect_timeout: Duration,
    dead_timeout: Duration,
}

impl RelayHeartbeat {
    fn new(suspect_timeout: Duration, dead_timeout: Duration) -> Self {
        Self {
            last_pong: Instant::now(),
            suspect_timeout,
            dead_timeout,
        }
    }

    fn observe_pong(&mut self) {
        self.last_pong = Instant::now();
    }

    fn is_suspect(&self) -> bool {
        self.last_pong.elapsed() >= self.suspect_timeout
    }

    fn is_dead(&self) -> bool {
        self.last_pong.elapsed() >= self.dead_timeout
    }
}

struct QueuedInvoke {
    route_id: String,
    invocation: InvocationEnvelope,
    bytes: usize,
    received: Instant,
}

#[derive(Default)]
struct RelayQueue {
    messages: VecDeque<QueuedInvoke>,
    bytes: usize,
}

impl RelayQueue {
    /// Enqueue an invoke, or return true when the caller must reject it
    /// immediately per-route (queue full). Never silently drops.
    fn try_enqueue(&mut self, item: QueuedInvoke) -> bool {
        if self.messages.len() >= RELAY_PENDING_LIMIT
            || self.bytes.saturating_add(item.bytes) > RELAY_PENDING_BYTES
        {
            return true;
        }
        self.bytes += item.bytes;
        self.messages.push_back(item);
        false
    }

    fn pop(&mut self) -> Option<QueuedInvoke> {
        let item = self.messages.pop_front()?;
        self.bytes = self.bytes.saturating_sub(item.bytes);
        Some(item)
    }

    #[allow(dead_code)]
    fn len(&self) -> usize {
        self.messages.len()
    }
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

    loop {
        match connect_and_run(Arc::clone(&runtime), &config).await {
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
) -> Result<(), RelayFailure> {
    connect_and_run_with_timing(
        runtime,
        config,
        RELAY_HEARTBEAT_INTERVAL,
        RELAY_SUSPECT_TIMEOUT,
        RELAY_DEAD_TIMEOUT,
        RELAY_PENDING_WAIT,
    )
    .await
}

async fn connect_and_run_with_timing(
    runtime: Arc<AgentRuntime>,
    config: &RelayConfig,
    heartbeat_interval: Duration,
    suspect_timeout: Duration,
    dead_timeout: Duration,
    pending_wait: Duration,
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

    let (socket, _) = tokio::time::timeout(RELAY_CONNECT_TIMEOUT, connect_async(request))
        .await
        .map_err(|_| RelayFailure::Retryable("relay connection handshake timed out".into()))?
        .map_err(|error| classify_connect_error(&error))?;

    let device_id = config.device_id.clone();
    // Fresh sync policy per connection (version 0 = ceiling): a reconnect
    // re-applies the relay's current desired version instead of stalling
    // as stale, and nothing survives across sockets implicitly.
    let effective = Arc::new(match config.principal_profile.clone() {
        Some(profile) => EffectivePolicy::new(profile),
        None => EffectivePolicy::without_ceiling(),
    });
    let effective_worker = Arc::clone(&effective);
    run_loop(
        socket,
        &device_id,
        heartbeat_interval,
        suspect_timeout,
        dead_timeout,
        pending_wait,
        |route_id, invocation| {
            let runtime = Arc::clone(&runtime);
            let device_id = device_id.clone();
            let effective_worker = Arc::clone(&effective_worker);
            async move {
                handle_inbound(
                    &runtime,
                    &device_id,
                    route_id,
                    invocation,
                    &effective_worker,
                )
                .await
            }
        },
        effective,
    )
    .await
}

/// Production executor: enforce local device binding, then the
/// synchronized effective policy, then run. The relay principal is never
/// trusted here; `AgentRuntime::execute` rebinds to the launch-bound
/// principal before policy dispatch, and the sync gate only narrows
/// within the launch-bound ceiling (never grants).
async fn handle_inbound(
    runtime: &AgentRuntime,
    device_id: &str,
    route_id: String,
    invocation: InvocationEnvelope,
    effective: &EffectivePolicy,
) -> (String, ResultEnvelope) {
    let result = if invocation.device_id.as_deref() != Some(device_id) {
        wrong_device_result(&invocation, device_id)
    } else if let Some(reason) = effective.check(&invocation.capability) {
        sync_denied_result(&invocation, &reason)
    } else {
        runtime.execute(invocation).await
    };
    (route_id, result)
}

/// Ordered single-worker session loop with an independent heartbeat.
///
/// The socket read path only enqueues (bounded 16 / 4 MiB) and answers
/// Ping/Pong; execution runs in one spawned worker so a long invoke can
/// never block liveness. Results are sent only on the socket that received
/// them: if this socket dies, in-flight work settles as `disconnected`
/// (the caller reconnects and reconciles via idempotency keys in S5 scope;
/// this function never replays an old result on a new socket).
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
async fn run_loop<S, E, F>(
    mut socket: S,
    device_id: &str,
    heartbeat_interval: Duration,
    suspect_timeout: Duration,
    dead_timeout: Duration,
    pending_wait: Duration,
    mut execute: E,
    effective: Arc<EffectivePolicy>,
) -> Result<(), RelayFailure>
where
    S: Sink<Message, Error = WebSocketError>
        + Stream<Item = Result<Message, WebSocketError>>
        + Unpin,
    E: FnMut(String, InvocationEnvelope) -> F,
    F: Future<Output = (String, ResultEnvelope)> + Send + 'static,
{
    let mut queue = RelayQueue::default();
    let mut active: Option<tokio::task::JoinHandle<(String, ResultEnvelope)>> = None;
    let mut active_route: Option<String> = None;
    let mut heartbeat = RelayHeartbeat::new(suspect_timeout, dead_timeout);
    let mut heartbeat_tick = tokio::time::interval(heartbeat_interval);
    heartbeat_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Consume the immediate first tick so Pings start after one interval.
    heartbeat_tick.tick().await;

    loop {
        dispatch_queued(
            &mut socket,
            device_id,
            pending_wait,
            &mut queue,
            &mut active,
            &mut active_route,
            &mut execute,
        )
        .await?;

        tokio::select! {
            next = socket.next() => {
                let Some(next) = next else {
                    return Ok(());
                };
                let message = next.map_err(|error| {
                    RelayFailure::Retryable(format!("websocket receive failed: {error}"))
                })?;
                match message {
                    Message::Text(text) => {
                        let bytes = text.len();
                        let inbound = parse_inbound(text.as_str())?;
                        match inbound {
                            RelayInbound::Policy {
                                version,
                                allowed_capabilities,
                            } => {
                                apply_policy_and_ack(
                                    &mut socket,
                                    &effective,
                                    version,
                                    allowed_capabilities,
                                )
                                .await?;
                            }
                            RelayInbound::Invoke { route_id, invocation } => {
                                let item = QueuedInvoke {
                                    route_id: route_id.clone(),
                                    invocation: invocation.clone(),
                                    bytes,
                                    received: Instant::now(),
                                };
                                if queue.try_enqueue(item) {
                                    let rejection =
                                        queue_rejection_result(&invocation, device_id);
                                    let payload = encode_result(&route_id, &rejection)?;
                                    send_frame(
                                        &mut socket,
                                        Message::Text(payload.into()),
                                        "queue rejection",
                                    )
                                    .await?;
                                }
                            }
                        }
                    }
                    Message::Ping(payload) => {
                        send_frame(&mut socket, Message::Pong(payload), "pong").await?;
                    }
                    Message::Pong(_) => {
                        heartbeat.observe_pong();
                    }
                    Message::Close(_) => return Ok(()),
                    Message::Binary(_) | Message::Frame(_) => {}
                }
            }
            completed = await_task(&mut active) => {
                let (route_id, result) = completed.map_err(|_| {
                    RelayFailure::Retryable("relay invocation worker failed".into())
                })?;
                let _ = active.take();
                active_route = None;
                let payload = encode_result(&route_id, &result)?;
                send_frame(&mut socket, Message::Text(payload.into()), "result").await?;
            }
            _ = heartbeat_tick.tick() => {
                send_frame(&mut socket, Message::Ping(vec![].into()), "heartbeat ping").await?;
                if heartbeat.is_dead() {
                    // Drop per-generation queue; in-flight work (if any) is
                    // detached and its result never sent on the next socket.
                    if let Some(handle) = active.take() {
                        handle.abort();
                    }
                    let _ = active_route.take();
                    return Err(RelayFailure::Retryable(
                        "relay heartbeat timeout; reconnecting".into(),
                    ));
                }
                if heartbeat.is_suspect() {
                    eprintln!("relay heartbeat suspect: no Pong within suspect timeout");
                }
            }
        }
    }
}

/// Dispatch next queued invoke while the single ordered worker is idle.
/// Expired waits (past `pending_wait`) are rejected per-route, never run stale.
#[allow(clippy::too_many_arguments)]
async fn dispatch_queued<S, E, F>(
    socket: &mut S,
    device_id: &str,
    pending_wait: Duration,
    queue: &mut RelayQueue,
    active: &mut Option<tokio::task::JoinHandle<(String, ResultEnvelope)>>,
    active_route: &mut Option<String>,
    execute: &mut E,
) -> Result<(), RelayFailure>
where
    S: Sink<Message, Error = WebSocketError> + Unpin,
    E: FnMut(String, InvocationEnvelope) -> F,
    F: Future<Output = (String, ResultEnvelope)> + Send + 'static,
{
    while active.is_none() {
        let Some(item) = queue.pop() else {
            break;
        };
        if item.received.elapsed() >= pending_wait {
            let rejection = queue_rejection_result(&item.invocation, device_id);
            let payload = encode_result(&item.route_id, &rejection)?;
            send_frame(socket, Message::Text(payload.into()), "expired queue item").await?;
            continue;
        }
        let route_id = item.route_id.clone();
        let invocation = item.invocation;
        *active_route = Some(route_id.clone());
        *active = Some(tokio::spawn(execute(route_id, invocation)));
    }
    Ok(())
}

async fn await_task<T>(
    task: &mut Option<tokio::task::JoinHandle<T>>,
) -> Result<T, tokio::task::JoinError> {
    match task {
        Some(task) => task.await,
        None => std::future::pending().await,
    }
}

/// Apply one desired-policy push and acknowledge it on the dedicated
/// channel. Stale versions are ignored silently (no ack to send).
async fn apply_policy_and_ack<S>(
    socket: &mut S,
    effective: &EffectivePolicy,
    version: u64,
    allowed_capabilities: BTreeSet<String>,
) -> Result<(), RelayFailure>
where
    S: Sink<Message, Error = WebSocketError> + Unpin,
{
    let desired = DesiredPolicy {
        version,
        allowed_capabilities,
    };
    if let Some(ack) = effective.apply_desired(&desired) {
        let payload = encode_ack(&ack)?;
        send_frame(socket, Message::Text(payload.into()), "policy ack").await?;
    }
    Ok(())
}

async fn send_frame<S>(socket: &mut S, message: Message, label: &str) -> Result<(), RelayFailure>
where
    S: Sink<Message, Error = WebSocketError> + Unpin,
{
    tokio::time::timeout(RELAY_SEND_TIMEOUT, socket.send(message))
        .await
        .map_err(|_| RelayFailure::Retryable(format!("relay {label} send timed out")))?
        .map_err(|error| RelayFailure::Retryable(format!("relay {label} send failed: {error}")))
}

fn parse_inbound(text: &str) -> Result<RelayInbound, RelayFailure> {
    serde_json::from_str(text)
        .map_err(|error| RelayFailure::Retryable(format!("relay sent invalid message: {error}")))
}

fn encode_result(route_id: &str, result: &ResultEnvelope) -> Result<String, RelayFailure> {
    serde_json::to_string(&RelayOutbound {
        kind: "result",
        route_id,
        result,
    })
    .map_err(|error| RelayFailure::Fatal(format!("failed to serialize relay result: {error}")))
}

fn encode_ack(ack: &PolicyAcknowledgment) -> Result<String, RelayFailure> {
    serde_json::to_string(&RelayPolicyAck {
        kind: "policy_ack",
        version: ack.version,
        status: ack.status,
        applied_capabilities: &ack.applied_capabilities,
        reason: &ack.reason,
    })
    .map_err(|error| RelayFailure::Fatal(format!("failed to serialize policy ack: {error}")))
}

/// Per-route backpressure signal: the queue is bounded (16 / 4 MiB / 5 s)
/// and ordered delivery is preserved by rejecting, never silently dropping.
fn queue_rejection_result(
    invocation: &InvocationEnvelope,
    local_device_id: &str,
) -> ResultEnvelope {
    ResultEnvelope {
        protocol_version: "1.0".into(),
        request_id: invocation.request_id,
        status: ResultStatus::Error,
        data: None,
        delta: None,
        error: Some(CapabilityError {
            code: ErrorCode::ResourceConflict,
            message: "relay work queue saturated or expired; retry later".into(),
            recovery_hint: Some("retry with the same idempotency key".into()),
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

fn sync_denied_result(invocation: &InvocationEnvelope, reason: &str) -> ResultEnvelope {
    ResultEnvelope {
        protocol_version: "1.0".into(),
        request_id: invocation.request_id,
        status: ResultStatus::Error,
        data: None,
        delta: None,
        error: Some(CapabilityError {
            code: ErrorCode::PermissionDenied,
            message: "remote invocation is denied by synchronized device policy".into(),
            recovery_hint: Some("owner must restore the grant via desired policy sync".into()),
            details: json!({
                "capability": invocation.capability,
                "reason": reason,
            }),
        }),
        verification: VerificationStatus::Failed,
        continuation: None,
        policy: None,
        timing: Timing { duration_ms: 0 },
    }
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
    use super::*;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::{Context, Poll};
    use tether_core::{Actor, ActorKind, ResponseMode};
    use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

    #[test]
    fn relay_url_requires_wss_except_explicit_loopback_test_mode() {
        assert!(validate_relay_url("wss://relay.example.test/device", false).is_ok());
        assert!(validate_relay_url("ws://127.0.0.1:8765/device", true).is_ok());
        assert!(validate_relay_url("ws://localhost:8765/device", true).is_ok());
        assert!(validate_relay_url("ws://relay.example.test/device", false).is_err());
        assert!(validate_relay_url("http://relay.example.test/device", true).is_err());
    }

    #[test]
    fn heartbeat_state_needs_unechoed_pong_to_go_dead() {
        let mut heartbeat =
            RelayHeartbeat::new(Duration::from_millis(50), Duration::from_millis(100));
        assert!(!heartbeat.is_suspect());
        assert!(!heartbeat.is_dead());
        std::thread::sleep(Duration::from_millis(60));
        assert!(heartbeat.is_suspect());
        assert!(!heartbeat.is_dead());
        heartbeat.observe_pong();
        assert!(!heartbeat.is_suspect());
        assert!(!heartbeat.is_dead());
        std::thread::sleep(Duration::from_millis(110));
        assert!(heartbeat.is_dead());
    }

    #[test]
    fn queue_bounds_reject_overfull_without_dropping_order() {
        let mut queue = RelayQueue::default();
        let invocation = test_invocation("device-a");
        for _ in 0..RELAY_PENDING_LIMIT {
            assert!(!queue.try_enqueue(QueuedInvoke {
                route_id: "r".into(),
                invocation: invocation.clone(),
                bytes: 10,
                received: Instant::now(),
            }));
        }
        assert_eq!(queue.len(), RELAY_PENDING_LIMIT);
        assert!(queue.try_enqueue(QueuedInvoke {
            route_id: "overflow".into(),
            invocation,
            bytes: 10,
            received: Instant::now(),
        }));
        assert_eq!(queue.len(), RELAY_PENDING_LIMIT);
    }

    #[test]
    fn queue_rejects_single_frame_over_byte_cap() {
        let mut queue = RelayQueue::default();
        let invocation = test_invocation("device-a");
        assert!(queue.try_enqueue(QueuedInvoke {
            route_id: "huge".into(),
            invocation,
            bytes: RELAY_PENDING_BYTES + 1,
            received: Instant::now(),
        }));
        assert_eq!(queue.len(), 0);
    }

    /// In-memory socket pair: no TCP, no relay, no browser probe.
    struct FakeSocket {
        rx: UnboundedReceiver<Result<Message, WebSocketError>>,
        tx: UnboundedSender<Message>,
    }

    impl Stream for FakeSocket {
        type Item = Result<Message, WebSocketError>;
        fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            self.rx.poll_recv(cx)
        }
    }

    impl Sink<Message> for FakeSocket {
        type Error = WebSocketError;
        fn poll_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
        fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
            self.tx
                .send(item)
                .map_err(|_| WebSocketError::ConnectionClosed)?;
            Ok(())
        }
        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
        fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    fn fake_pair() -> (
        FakeSocket,
        UnboundedReceiver<Message>,
        UnboundedSender<Result<Message, WebSocketError>>,
    ) {
        let (client_tx, server_rx) = mpsc::unbounded_channel();
        let (server_tx, client_rx) = mpsc::unbounded_channel();
        (
            FakeSocket {
                rx: client_rx,
                tx: client_tx,
            },
            server_rx,
            server_tx,
        )
    }

    fn test_invocation(device_id: &str) -> InvocationEnvelope {
        InvocationEnvelope {
            protocol_version: "1.0".into(),
            request_id: uuid::Uuid::new_v4(),
            device_id: Some(device_id.into()),
            principal_id: None,
            job_id: None,
            capability: "device.status".into(),
            arguments: json!({}),
            actor: Actor {
                id: "test".into(),
                kind: ActorKind::System,
            },
            session_id: None,
            response_mode: ResponseMode::Compact,
            idempotency_key: None,
            preconditions: vec![],
            expectations: vec![],
        }
    }

    fn invoke_text(route_id: &str, invocation: &InvocationEnvelope) -> String {
        serde_json::to_string(&json!({
            "type": "invoke",
            "routeId": route_id,
            "invocation": invocation,
        }))
        .expect("invoke serializes")
    }

    fn success_envelope(invocation: &InvocationEnvelope) -> ResultEnvelope {
        ResultEnvelope {
            protocol_version: "1.0".into(),
            request_id: invocation.request_id,
            status: ResultStatus::Success,
            data: Some(json!({"ok": true})),
            delta: None,
            error: None,
            verification: VerificationStatus::Verified,
            continuation: None,
            policy: None,
            timing: Timing { duration_ms: 0 },
        }
    }

    #[tokio::test]
    async fn silent_socket_detects_without_browser_probe() {
        let (socket, _server_rx, _server_tx) = fake_pair();
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            run_loop(
                socket,
                "device-a",
                Duration::from_millis(20),
                Duration::from_millis(60),
                Duration::from_millis(100),
                Duration::from_secs(5),
                |_route_id: String, _invocation: InvocationEnvelope| async move {
                    panic!("silent-socket detection must not dispatch work or probe providers")
                },
                open_policy(),
            ),
        )
        .await
        .expect("detection completes within timeout");
        match result {
            Err(RelayFailure::Retryable(message)) => {
                assert!(
                    message.contains("heartbeat"),
                    "unexpected message: {message}"
                );
            }
            other => panic!("silent socket must end Retryable, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn heartbeat_fires_during_genuinely_blocking_invoke() {
        let (socket, mut server_rx, server_tx) = fake_pair();
        let invocation = test_invocation("device-a");
        let loop_handle = tokio::spawn(run_loop(
            socket,
            "device-a",
            Duration::from_millis(20),
            Duration::from_secs(5),
            Duration::from_secs(10),
            Duration::from_secs(5),
            move |route_id: String, invocation: InvocationEnvelope| async move {
                // Genuinely long-running and non-cooperative: blocks the OS
                // thread without yielding, unlike `tokio::time::sleep`.
                std::thread::sleep(Duration::from_millis(400));
                (route_id, success_envelope(&invocation))
            },
            open_policy(),
        ));
        server_tx
            .send(Ok(Message::Text(
                invoke_text("route-long", &invocation).into(),
            )))
            .expect("server sends invoke");

        let mut pings_seen = 0_u32;
        let mut result_seen = false;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && !(pings_seen >= 2 && result_seen) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, server_rx.recv()).await {
                Ok(Some(Message::Ping(_))) => pings_seen += 1,
                Ok(Some(Message::Text(_))) => result_seen = true,
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        loop_handle.abort();
        assert!(
            pings_seen >= 2,
            "heartbeat must send Pings while a blocking invoke runs, saw {pings_seen}"
        );
        assert!(
            result_seen,
            "ordered result must still arrive after blocking work"
        );
    }

    #[tokio::test]
    async fn healthy_pong_causes_no_reconnect() {
        let (socket, mut server_rx, server_tx) = fake_pair();
        let pings_seen = Arc::new(AtomicUsize::new(0));
        let pings_seen_server = Arc::clone(&pings_seen);
        let responder = tokio::spawn(async move {
            while let Some(message) = server_rx.recv().await {
                if let Message::Ping(_) = message {
                    pings_seen_server.fetch_add(1, Ordering::SeqCst);
                    let _ = server_tx.send(Ok(Message::Pong(vec![].into())));
                }
            }
        });
        let outcome = tokio::time::timeout(
            Duration::from_millis(250),
            run_loop(
                socket,
                "device-a",
                Duration::from_millis(20),
                Duration::from_millis(100),
                Duration::from_millis(300),
                Duration::from_secs(5),
                |route_id: String, invocation: InvocationEnvelope| async move {
                    (route_id, success_envelope(&invocation))
                },
                open_policy(),
            ),
        )
        .await;
        responder.abort();
        assert!(
            outcome.is_err(),
            "healthy Pongs must not trigger reconnect; loop must still be running"
        );
        assert!(
            pings_seen.load(Ordering::SeqCst) >= 2,
            "expected steady Pings with Pong replies"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn queue_full_rejects_per_route_with_conflict() {
        let (socket, mut server_rx, server_tx) = fake_pair();
        let loop_handle = tokio::spawn(run_loop(
            socket,
            "device-a",
            Duration::from_millis(20),
            Duration::from_secs(5),
            Duration::from_secs(10),
            Duration::from_secs(5),
            |route_id: String, invocation: InvocationEnvelope| async move {
                std::thread::sleep(Duration::from_millis(500));
                (route_id, success_envelope(&invocation))
            },
            open_policy(),
        ));
        for index in 0..(RELAY_PENDING_LIMIT + 2) {
            let invocation = test_invocation("device-a");
            server_tx
                .send(Ok(Message::Text(
                    invoke_text(&format!("route-{index}"), &invocation).into(),
                )))
                .expect("server sends invoke");
        }
        let mut conflict_seen = false;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && !conflict_seen {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, server_rx.recv()).await {
                Ok(Some(Message::Text(text))) => {
                    if text.contains("resource_conflict") {
                        conflict_seen = true;
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        loop_handle.abort();
        assert!(
            conflict_seen,
            "overfull bounded queue must reject per-route with resource_conflict"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[allow(clippy::similar_names, clippy::too_many_lines)]
    async fn old_generation_result_never_reaches_replacement_connection() {
        // Session 1 receives an invoke whose worker never finishes (held on
        // a future that never resolves). Heartbeat death must fence it: the
        // result is never produced and never delivered anywhere.
        let events = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let events_s1 = Arc::clone(&events);
        let (socket1, mut server_rx1, server_tx1) = fake_pair();
        let session1 = tokio::spawn(run_loop(
            socket1,
            "device-a",
            Duration::from_millis(20),
            Duration::from_millis(60),
            Duration::from_millis(100),
            Duration::from_secs(5),
            move |route_id: String, _invocation: InvocationEnvelope| {
                let events_s1 = Arc::clone(&events_s1);
                async move {
                    events_s1
                        .lock()
                        .expect("event log")
                        .push(format!("s1-start:{route_id}"));
                    loop {
                        std::future::pending::<()>().await;
                    }
                }
            },
            open_policy(),
        ));
        let invocation = test_invocation("device-a");
        server_tx1
            .send(Ok(Message::Text(
                invoke_text("route-old", &invocation).into(),
            )))
            .expect("server sends invoke");
        let outcome = tokio::time::timeout(Duration::from_secs(2), session1)
            .await
            .expect("session 1 ends")
            .expect("session 1 joinable");
        match outcome {
            Err(RelayFailure::Retryable(_)) => {}
            other => panic!("session 1 must die Retryable, got {other:?}"),
        }
        // Drain session 1: Pings only, never a result for route-old.
        let mut s1_texts = Vec::new();
        loop {
            match tokio::time::timeout(Duration::from_millis(200), server_rx1.recv()).await {
                Ok(Some(Message::Text(text))) => s1_texts.push(text.to_string()),
                Ok(Some(_)) => {}
                // `None` (session ended, channel closed) or a quiet window
                // both end the drain: buffered frames were already collected
                // above, and no late frame can arrive after close. Looping on
                // `None` instead would spin forever without ever timing out.
                Ok(None) | Err(_) => break,
            }
        }
        assert!(
            s1_texts.is_empty(),
            "dead session must not deliver any result, saw {s1_texts:?}"
        );
        assert_eq!(
            *events.lock().expect("event log"),
            vec!["s1-start:route-old".to_string()],
            "in-flight work started but never completed"
        );

        // Session 2 is the replacement connection. It must only ever see
        // its own routes — nothing from session 1 crosses generations.
        let events_s2 = Arc::clone(&events);
        let (socket2, mut server_rx2, server_tx2) = fake_pair();
        let session2 = tokio::spawn(run_loop(
            socket2,
            "device-a",
            Duration::from_millis(20),
            Duration::from_secs(5),
            Duration::from_secs(10),
            Duration::from_secs(5),
            move |route_id: String, invocation: InvocationEnvelope| {
                let events_s2 = Arc::clone(&events_s2);
                async move {
                    events_s2
                        .lock()
                        .expect("event log")
                        .push(format!("s2-exec:{route_id}"));
                    (route_id, success_envelope(&invocation))
                }
            },
            open_policy(),
        ));
        let invocation2 = test_invocation("device-a");
        server_tx2
            .send(Ok(Message::Text(
                invoke_text("route-new", &invocation2).into(),
            )))
            .expect("server sends invoke");
        let mut s2_result: Option<String> = None;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && s2_result.is_none() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, server_rx2.recv()).await {
                Ok(Some(Message::Text(text))) => s2_result = Some(text.to_string()),
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        session2.abort();
        let result = s2_result.expect("replacement session delivers its own result");
        assert!(
            result.contains("route-new"),
            "replacement session must deliver route-new, saw {result}"
        );
        assert!(
            !result.contains("route-old"),
            "old-generation route must never cross connections, saw {result}"
        );
        let log = events.lock().expect("event log").clone();
        assert!(
            !log.iter().any(|entry| entry == "s1-done"),
            "aborted work must never report completion, log: {log:?}"
        );
        assert!(
            log.iter().all(|entry| entry != "s2-exec:route-old"),
            "replacement session must never execute the old route, log: {log:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn disconnect_fences_result_but_does_not_roll_back_side_effect() {
        // abort() stops delivery of the result; it is NOT a rollback of an
        // already-performed side effect. The effect below fires before the
        // block, so after heartbeat death the effect exists exactly once
        // while no result is ever transmitted. Reconciling that uncertain
        // outcome via idempotency keys is S5 scope, not S1.
        let side_effects = Arc::new(AtomicUsize::new(0));
        let side_effects_worker = Arc::clone(&side_effects);
        let (socket, mut server_rx, server_tx) = fake_pair();
        let session = tokio::spawn(run_loop(
            socket,
            "device-a",
            Duration::from_millis(20),
            Duration::from_millis(60),
            Duration::from_millis(100),
            Duration::from_secs(5),
            move |_route_id: String, _invocation: InvocationEnvelope| {
                let side_effects_worker = Arc::clone(&side_effects_worker);
                async move {
                    side_effects_worker.fetch_add(1, Ordering::SeqCst);
                    loop {
                        std::future::pending::<()>().await;
                    }
                }
            },
            open_policy(),
        ));
        let invocation = test_invocation("device-a");
        server_tx
            .send(Ok(Message::Text(
                invoke_text("route-effect", &invocation).into(),
            )))
            .expect("server sends invoke");
        let outcome = tokio::time::timeout(Duration::from_secs(2), session)
            .await
            .expect("session ends")
            .expect("session joinable");
        assert!(
            matches!(outcome, Err(RelayFailure::Retryable(_))),
            "silent session must die Retryable, got {outcome:?}"
        );
        // Grace window: any late delivery would appear here. None must.
        let mut texts = Vec::new();
        loop {
            match tokio::time::timeout(Duration::from_millis(300), server_rx.recv()).await {
                Ok(Some(Message::Text(text))) => texts.push(text.to_string()),
                Ok(Some(_)) => {}
                // `None` (session ended, channel closed) or a quiet window
                // both end the drain: buffered frames were already collected
                // above, and no late frame can arrive after close. Looping on
                // `None` instead would spin forever without ever timing out.
                Ok(None) | Err(_) => break,
            }
        }
        assert!(
            texts.is_empty(),
            "fenced result must never be transmitted, saw {texts:?}"
        );
        assert_eq!(
            side_effects.load(Ordering::SeqCst),
            1,
            "the side effect already happened exactly once and is not rolled back"
        );
    }

    #[test]
    fn auth_401_403_are_fatal_others_retryable() {
        for status in [401_u16, 403_u16] {
            let response = tokio_tungstenite::tungstenite::http::Response::builder()
                .status(status)
                .body(None::<Vec<u8>>)
                .expect("response builds");
            match classify_connect_error(&WebSocketError::Http(Box::new(response))) {
                RelayFailure::Fatal(message) => {
                    assert!(
                        message.contains(&status.to_string()),
                        "fatal message must name the status, saw {message}"
                    );
                }
                other @ RelayFailure::Retryable(_) => {
                    panic!("HTTP {status} must be Fatal, got {other:?}")
                }
            }
        }
        let response = tokio_tungstenite::tungstenite::http::Response::builder()
            .status(500_u16)
            .body(None::<Vec<u8>>)
            .expect("response builds");
        assert!(
            matches!(
                classify_connect_error(&WebSocketError::Http(Box::new(response))),
                RelayFailure::Retryable(_)
            ),
            "HTTP 500 must stay retryable"
        );
        assert!(
            matches!(
                classify_connect_error(&WebSocketError::ConnectionClosed),
                RelayFailure::Retryable(_)
            ),
            "transport errors must stay retryable"
        );
    }

    /// One-shot HTTP server on std net (no tokio net feature required):
    /// accepts a single connection, ignores the upgrade request, answers
    /// with the given status, then exits.
    fn http_status_server_once(status: u16) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("loopback listener binds");
        let port = listener.local_addr().expect("port known").port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut buffer = [0_u8; 8192];
            let _ = stream.read(&mut buffer);
            let reason = match status {
                401 => "Unauthorized",
                403 => "Forbidden",
                _ => "Error",
            };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        });
        port
    }

    fn test_runtime() -> Arc<AgentRuntime> {
        Arc::new(AgentRuntime::new(Vec::new(), None, None, None).expect("test runtime builds"))
    }

    fn loopback_config(port: u16) -> RelayConfig {
        RelayConfig {
            url: format!("ws://127.0.0.1:{port}/device"),
            device_id: "device-a".into(),
            credential: "test-credential-0123456789".into(),
            allow_insecure_localhost: true,
            reconnect_delay: Duration::from_millis(50),
            principal_profile: None,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn http_401_reaches_fatal_without_retry() {
        let port = http_status_server_once(401);
        let runtime = test_runtime();
        let config = loopback_config(port);
        // Connect level: the handshake failure maps to Fatal.
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            connect_and_run_with_timing(
                Arc::clone(&runtime),
                &config,
                Duration::from_millis(20),
                Duration::from_millis(60),
                Duration::from_millis(100),
                Duration::from_secs(5),
            ),
        )
        .await
        .expect("connect attempt finishes");
        match outcome {
            Err(RelayFailure::Fatal(message)) => {
                assert!(
                    message.contains("401"),
                    "fatal must name 401, saw {message}"
                );
            }
            other => panic!("HTTP 401 must be Fatal, got {other:?}"),
        }
        // Serve level: Fatal terminates the loop — serve returns instead
        // of retrying forever. The timeout would elapse on a retry loop.
        let port = http_status_server_once(401);
        let config = loopback_config(port);
        let outcome = tokio::time::timeout(Duration::from_secs(10), serve(runtime, config)).await;
        match outcome {
            Ok(Err(message)) => {
                assert!(
                    message.contains("401"),
                    "serve error must name 401, saw {message}"
                );
            }
            Ok(Ok(())) => panic!("serve must fail on 401, not succeed"),
            Err(elapsed) => panic!("serve retried on fatal 401 instead of terminating ({elapsed})"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn byte_cap_saturates_across_frames_with_truthful_rejection() {
        // Five ~900 KiB frames fit (one in the worker, four queued) under
        // the 4 MiB queued-bytes cap while the worker is held; the sixth
        // frame exceeds it and must be rejected per-route with its own
        // request_id — never silently dropped, never attributed to another
        // route.
        let (socket, mut server_rx, server_tx) = fake_pair();
        let loop_handle = tokio::spawn(run_loop(
            socket,
            "device-a",
            Duration::from_millis(20),
            Duration::from_secs(5),
            Duration::from_secs(10),
            Duration::from_secs(5),
            |_route_id: String, _invocation: InvocationEnvelope| async move {
                loop {
                    std::future::pending::<()>().await;
                }
            },
            open_policy(),
        ));
        let pad = "x".repeat(900 * 1024);
        let mut rejected_request_id: Option<String> = None;
        for index in 0..6 {
            let mut invocation = test_invocation("device-a");
            invocation.arguments = serde_json::json!({ "pad": pad.clone() });
            if index == 5 {
                rejected_request_id = Some(invocation.request_id.to_string());
            }
            server_tx
                .send(Ok(Message::Text(
                    invoke_text(&format!("route-b{index}"), &invocation).into(),
                )))
                .expect("server sends invoke");
        }
        let expected_request_id = rejected_request_id.expect("rejected request id recorded");
        let mut pings_seen = 0_u32;
        let mut conflicts: Vec<serde_json::Value> = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, server_rx.recv()).await {
                Ok(Some(Message::Ping(_))) => pings_seen += 1,
                Ok(Some(Message::Text(text))) => {
                    let value: serde_json::Value =
                        serde_json::from_str(text.as_str()).expect("result parses");
                    if value
                        .pointer("/result/error/code")
                        .and_then(serde_json::Value::as_str)
                        == Some("resource_conflict")
                    {
                        conflicts.push(value);
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
            if pings_seen >= 2 && !conflicts.is_empty() {
                break;
            }
        }
        loop_handle.abort();
        assert!(
            pings_seen >= 2,
            "heartbeat must continue while the byte cap is saturated, saw {pings_seen} pings"
        );
        assert_eq!(
            conflicts.len(),
            1,
            "exactly one frame must be rejected, saw {}",
            conflicts.len()
        );
        let conflict = &conflicts[0];
        assert_eq!(
            conflict
                .pointer("/routeId")
                .and_then(serde_json::Value::as_str),
            Some("route-b5"),
            "rejection must name the over-cap route, saw {conflict}"
        );
        assert_eq!(
            conflict
                .pointer("/result/request_id")
                .and_then(serde_json::Value::as_str),
            Some(expected_request_id.as_str()),
            "rejection must carry the rejected invoke's own request_id"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn expired_queue_items_are_rejected_never_executed() {
        // route-first holds the single worker on a release gate.
        // route-expired waits past pending_wait, then the gate opens:
        // route-first completes normally while route-expired is rejected
        // with resource_conflict and never reaches the executor — no
        // delayed (cross-generation-style) execution.
        let executed = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let executed_worker = Arc::clone(&executed);
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let release_rx = Arc::new(std::sync::Mutex::new(Some(release_rx)));
        let (socket, mut server_rx, server_tx) = fake_pair();
        let loop_handle = tokio::spawn(run_loop(
            socket,
            "device-a",
            Duration::from_millis(20),
            Duration::from_secs(5),
            Duration::from_secs(10),
            Duration::from_millis(100),
            move |route_id: String, invocation: InvocationEnvelope| {
                let executed_worker = Arc::clone(&executed_worker);
                let release_rx = Arc::clone(&release_rx);
                async move {
                    executed_worker.lock().expect("log").push(route_id.clone());
                    if route_id == "route-first" {
                        let receiver = release_rx
                            .lock()
                            .expect("gate")
                            .take()
                            .expect("release gate present");
                        let _ = receiver.await;
                    }
                    (route_id, success_envelope(&invocation))
                }
            },
            open_policy(),
        ));
        let first = test_invocation("device-a");
        server_tx
            .send(Ok(Message::Text(invoke_text("route-first", &first).into())))
            .expect("server sends first");
        // Let route-first reach the worker before queueing the second.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let expired = test_invocation("device-a");
        let expired_request_id = expired.request_id.to_string();
        server_tx
            .send(Ok(Message::Text(
                invoke_text("route-expired", &expired).into(),
            )))
            .expect("server sends expired");
        // Wait out the 100 ms pending budget while the worker is held.
        tokio::time::sleep(Duration::from_millis(250)).await;
        release_tx.send(()).expect("release gate opens");
        let mut texts: Vec<String> = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && texts.len() < 2 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, server_rx.recv()).await {
                Ok(Some(Message::Text(text))) => texts.push(text.to_string()),
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        loop_handle.abort();
        assert_eq!(texts.len(), 2, "both routes must settle, saw {texts:?}");
        let expired_text = texts
            .iter()
            .find(|text| text.contains("route-expired"))
            .expect("expired route settles");
        let value: serde_json::Value = serde_json::from_str(expired_text).expect("result parses");
        assert_eq!(
            value
                .pointer("/result/error/code")
                .and_then(serde_json::Value::as_str),
            Some("resource_conflict"),
            "expired wait must reject truthfully, saw {value}"
        );
        assert_eq!(
            value
                .pointer("/result/request_id")
                .and_then(serde_json::Value::as_str),
            Some(expired_request_id.as_str()),
            "expired rejection must carry its own request_id"
        );
        // Grace window: a delayed execution would appear in the log. None must.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            *executed.lock().expect("log"),
            vec!["route-first".to_string()],
            "expired item must never reach the executor, even late"
        );
    }

    #[tokio::test]
    async fn reports_measured_silent_socket_detection_time() {
        // Production ratios at 1:100 (interval 5 s, suspect 15 s, dead
        // 20 s become 50/150/200 ms). Detection must land at or just past
        // the dead bound — bounded, not instant (no false trip) and not
        // hanging (fault-matrix row 2 goes from "hangs forever" to timed).
        let (socket, _server_rx, _server_tx) = fake_pair();
        let started = Instant::now();
        let outcome = run_loop(
            socket,
            "device-a",
            Duration::from_millis(50),
            Duration::from_millis(150),
            Duration::from_millis(200),
            Duration::from_secs(5),
            |_route_id: String, _invocation: InvocationEnvelope| async move {
                panic!("measurement needs no executor: silence alone must trip death")
            },
            open_policy(),
        )
        .await;
        let elapsed_ms = started.elapsed().as_millis();
        eprintln!("measured silent-socket detection: {elapsed_ms} ms (dead bound 200 ms)");
        assert!(
            matches!(outcome, Err(RelayFailure::Retryable(_))),
            "silence must end Retryable, got {outcome:?}"
        );
        assert!(
            (150..2_000).contains(&elapsed_ms),
            "detection must respect the dead bound, took {elapsed_ms} ms"
        );
    }

    #[test]
    fn heartbeat_independent_under_production_runtime_shape() {
        // main.rs runs #[tokio::main] with defaults: multi-thread
        // scheduler, worker threads sized to available parallelism, all
        // drivers enabled. Rebuild that shape explicitly instead of relying
        // on the harness runtime, and repeat the blocking-invoke proof.
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("production-shaped runtime builds");
        runtime.block_on(async {
            let (socket, mut server_rx, server_tx) = fake_pair();
            let invocation = test_invocation("device-a");
            let loop_handle = tokio::spawn(run_loop(
                socket,
                "device-a",
                Duration::from_millis(20),
                Duration::from_secs(5),
                Duration::from_secs(10),
                Duration::from_secs(5),
                move |route_id: String, invocation: InvocationEnvelope| async move {
                    // Non-cooperative block on a pool thread, as a slow
                    // provider would under the production scheduler.
                    std::thread::sleep(Duration::from_millis(500));
                    (route_id, success_envelope(&invocation))
                },
                open_policy(),
            ));
            server_tx
                .send(Ok(Message::Text(
                    invoke_text("route-prod", &invocation).into(),
                )))
                .expect("server sends invoke");
            let mut pings_seen = 0_u32;
            let mut result_seen = false;
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline && !(pings_seen >= 2 && result_seen) {
                let remaining = deadline.saturating_duration_since(Instant::now());
                match tokio::time::timeout(remaining, server_rx.recv()).await {
                    Ok(Some(Message::Ping(_))) => pings_seen += 1,
                    Ok(Some(Message::Text(_))) => result_seen = true,
                    Ok(Some(_)) => {}
                    Ok(None) | Err(_) => break,
                }
            }
            loop_handle.abort();
            assert!(
                pings_seen >= 2,
                "production scheduler: heartbeat must outlive blocking work, saw {pings_seen}"
            );
            assert!(
                result_seen,
                "production scheduler: ordered result must still arrive"
            );
        });
    }

    // ---- S4: Desired/Effective/Acknowledged policy sync ----

    fn sync_ceiling() -> PrincipalProfile {
        PrincipalProfile {
            principal_id: "model:owner-managed".into(),
            authentication: tether_core::PrincipalAuthentication::LocalProcessBinding,
            allowed_devices: BTreeSet::from(["device-a".into()]),
            allowed_capabilities: BTreeSet::from(["device.status".into(), "browser.pages".into()]),
            allowed_directories: Vec::new(),
        }
    }

    fn open_policy() -> Arc<EffectivePolicy> {
        Arc::new(EffectivePolicy::without_ceiling())
    }

    fn synced_policy() -> Arc<EffectivePolicy> {
        Arc::new(EffectivePolicy::new(sync_ceiling()))
    }

    fn policy_text(version: u64, capabilities: &[&str]) -> String {
        serde_json::to_string(&json!({
            "type": "policy",
            "version": version,
            "allowedCapabilities": capabilities,
        }))
        .expect("policy serializes")
    }

    async fn next_text(
        server_rx: &mut UnboundedReceiver<Message>,
        what: &str,
    ) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, server_rx.recv()).await {
                Ok(Some(Message::Text(text))) => {
                    return serde_json::from_str(text.as_str()).expect("result parses");
                }
                Ok(Some(_)) => {}
                Ok(None) => panic!("socket closed while waiting for {what}"),
                Err(elapsed) => panic!("timed out waiting for {what} ({elapsed})"),
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn policy_push_applies_and_acks_on_dedicated_channel() {
        let (socket, mut server_rx, server_tx) = fake_pair();
        let effective = synced_policy();
        let loop_handle = tokio::spawn(run_loop(
            socket,
            "device-a",
            Duration::from_millis(20),
            Duration::from_secs(5),
            Duration::from_secs(10),
            Duration::from_secs(5),
            |route_id: String, invocation: InvocationEnvelope| async move {
                (route_id, success_envelope(&invocation))
            },
            Arc::clone(&effective),
        ));
        server_tx
            .send(Ok(Message::Text(policy_text(1, &["device.status"]).into())))
            .expect("server sends policy");
        let ack = next_text(&mut server_rx, "policy ack").await;
        loop_handle.abort();
        assert_eq!(
            ack.pointer("/type").and_then(serde_json::Value::as_str),
            Some("policy_ack"),
            "ack must use the dedicated channel, saw {ack}"
        );
        assert!(ack.get("routeId").is_none(), "ack carries no route: {ack}");
        assert_eq!(
            ack.pointer("/version").and_then(serde_json::Value::as_u64),
            Some(1)
        );
        assert_eq!(
            ack.pointer("/status").and_then(serde_json::Value::as_str),
            Some("applied")
        );
        assert!(
            effective.check("browser.pages").is_some(),
            "narrowed capability must be denied after apply"
        );
        assert_eq!(effective.snapshot().0, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn policy_push_exceeding_ceiling_rejects_without_applying() {
        let (socket, mut server_rx, server_tx) = fake_pair();
        let effective = synced_policy();
        let loop_handle = tokio::spawn(run_loop(
            socket,
            "device-a",
            Duration::from_millis(20),
            Duration::from_secs(5),
            Duration::from_secs(10),
            Duration::from_secs(5),
            |route_id: String, invocation: InvocationEnvelope| async move {
                (route_id, success_envelope(&invocation))
            },
            Arc::clone(&effective),
        ));
        server_tx
            .send(Ok(Message::Text(
                policy_text(1, &["device.status", "process.run"]).into(),
            )))
            .expect("server sends policy");
        let ack = next_text(&mut server_rx, "policy ack").await;
        loop_handle.abort();
        assert_eq!(
            ack.pointer("/status").and_then(serde_json::Value::as_str),
            Some("rejected")
        );
        assert!(
            ack.pointer("/reason")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .contains("ceiling"),
            "rejection must name the ceiling, saw {ack}"
        );
        assert_eq!(effective.snapshot().0, 0, "version must not advance");
        assert!(
            effective.check("device.status").is_none(),
            "ceiling still stands after rejection"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn stale_policy_push_is_ignored_silently() {
        let (socket, mut server_rx, server_tx) = fake_pair();
        let effective = synced_policy();
        let loop_handle = tokio::spawn(run_loop(
            socket,
            "device-a",
            Duration::from_millis(20),
            Duration::from_secs(5),
            Duration::from_secs(10),
            Duration::from_secs(5),
            |route_id: String, invocation: InvocationEnvelope| async move {
                (route_id, success_envelope(&invocation))
            },
            Arc::clone(&effective),
        ));
        server_tx
            .send(Ok(Message::Text(policy_text(2, &["device.status"]).into())))
            .expect("server sends policy");
        let ack = next_text(&mut server_rx, "policy ack").await;
        assert_eq!(
            ack.pointer("/version").and_then(serde_json::Value::as_u64),
            Some(2)
        );
        server_tx
            .send(Ok(Message::Text(policy_text(1, &["device.status"]).into())))
            .expect("server sends stale policy");
        let deadline = Instant::now() + Duration::from_millis(150);
        let mut texts = 0_u32;
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, server_rx.recv()).await {
                Ok(Some(Message::Text(_))) => texts += 1,
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        loop_handle.abort();
        assert_eq!(texts, 0, "stale push must produce no ack");
        assert_eq!(effective.snapshot().0, 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sync_denied_invoke_never_reaches_provider() {
        // The test runtime is wide open (no launch profile, no browser
        // bridge): without the sync gate this invoke would reach the
        // (absent) browser provider and fail capability_unavailable.
        // permission_denied therefore proves the sync gate fired first.
        let (socket, mut server_rx, server_tx) = fake_pair();
        let effective = synced_policy();
        let runtime = test_runtime();
        let effective_worker = Arc::clone(&effective);
        let loop_handle = tokio::spawn(run_loop(
            socket,
            "device-a",
            Duration::from_millis(20),
            Duration::from_secs(5),
            Duration::from_secs(10),
            Duration::from_secs(5),
            move |route_id: String, invocation: InvocationEnvelope| {
                let runtime = Arc::clone(&runtime);
                let effective_worker = Arc::clone(&effective_worker);
                async move {
                    handle_inbound(
                        &runtime,
                        "device-a",
                        route_id,
                        invocation,
                        &effective_worker,
                    )
                    .await
                }
            },
            Arc::clone(&effective),
        ));
        server_tx
            .send(Ok(Message::Text(policy_text(1, &["device.status"]).into())))
            .expect("server sends policy");
        let ack = next_text(&mut server_rx, "policy ack").await;
        assert_eq!(
            ack.pointer("/status").and_then(serde_json::Value::as_str),
            Some("applied")
        );
        let mut denied = test_invocation("device-a");
        denied.capability = "browser.pages".into();
        let request_id = denied.request_id.to_string();
        server_tx
            .send(Ok(Message::Text(
                invoke_text("route-denied", &denied).into(),
            )))
            .expect("server sends invoke");
        let result = next_text(&mut server_rx, "denial result").await;
        loop_handle.abort();
        assert_eq!(
            result
                .pointer("/result/error/code")
                .and_then(serde_json::Value::as_str),
            Some("permission_denied"),
            "sync gate must deny before provider dispatch, saw {result}"
        );
        assert_eq!(
            result
                .pointer("/result/request_id")
                .and_then(serde_json::Value::as_str),
            Some(request_id.as_str())
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sync_allowed_invoke_executes_normally() {
        let (socket, mut server_rx, server_tx) = fake_pair();
        let effective = synced_policy();
        let runtime = test_runtime();
        let effective_worker = Arc::clone(&effective);
        let loop_handle = tokio::spawn(run_loop(
            socket,
            "device-a",
            Duration::from_millis(20),
            Duration::from_secs(5),
            Duration::from_secs(10),
            Duration::from_secs(5),
            move |route_id: String, invocation: InvocationEnvelope| {
                let runtime = Arc::clone(&runtime);
                let effective_worker = Arc::clone(&effective_worker);
                async move {
                    handle_inbound(
                        &runtime,
                        "device-a",
                        route_id,
                        invocation,
                        &effective_worker,
                    )
                    .await
                }
            },
            Arc::clone(&effective),
        ));
        server_tx
            .send(Ok(Message::Text(policy_text(1, &["device.status"]).into())))
            .expect("server sends policy");
        let _ = next_text(&mut server_rx, "policy ack").await;
        let invocation = test_invocation("device-a");
        server_tx
            .send(Ok(Message::Text(
                invoke_text("route-allowed", &invocation).into(),
            )))
            .expect("server sends invoke");
        let result = next_text(&mut server_rx, "result").await;
        loop_handle.abort();
        assert_eq!(
            result
                .pointer("/result/status")
                .and_then(serde_json::Value::as_str),
            Some("success")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[allow(clippy::similar_names)]
    async fn fresh_policy_per_connection_reconverges_without_version_growth() {
        // Session 1 applies v1, then dies. Session 2 starts a fresh
        // connection policy (version 0): the relay's re-push of the same
        // v1 applies cleanly instead of stalling as stale.
        let (socket1, mut server_rx1, server_tx1) = fake_pair();
        let policy1 = synced_policy();
        let session1 = tokio::spawn(run_loop(
            socket1,
            "device-a",
            Duration::from_millis(20),
            Duration::from_secs(5),
            Duration::from_secs(10),
            Duration::from_secs(5),
            |route_id: String, invocation: InvocationEnvelope| async move {
                (route_id, success_envelope(&invocation))
            },
            Arc::clone(&policy1),
        ));
        server_tx1
            .send(Ok(Message::Text(policy_text(1, &["device.status"]).into())))
            .expect("server sends policy");
        let ack1 = next_text(&mut server_rx1, "policy ack").await;
        assert_eq!(
            ack1.pointer("/status").and_then(serde_json::Value::as_str),
            Some("applied")
        );
        drop(server_tx1);
        let outcome = tokio::time::timeout(Duration::from_secs(2), session1)
            .await
            .expect("session 1 ends")
            .expect("session 1 joinable");
        assert!(outcome.is_ok(), "clean close must end Ok, got {outcome:?}");

        let (socket2, mut server_rx2, server_tx2) = fake_pair();
        let policy2 = synced_policy();
        let session2 = tokio::spawn(run_loop(
            socket2,
            "device-a",
            Duration::from_millis(20),
            Duration::from_secs(5),
            Duration::from_secs(10),
            Duration::from_secs(5),
            |route_id: String, invocation: InvocationEnvelope| async move {
                (route_id, success_envelope(&invocation))
            },
            Arc::clone(&policy2),
        ));
        server_tx2
            .send(Ok(Message::Text(policy_text(1, &["device.status"]).into())))
            .expect("server re-pushes same version");
        let ack2 = next_text(&mut server_rx2, "policy ack").await;
        session2.abort();
        assert_eq!(
            ack2.pointer("/status").and_then(serde_json::Value::as_str),
            Some("applied"),
            "fresh connection must converge on re-push, saw {ack2}"
        );
        assert_eq!(policy2.snapshot().0, 1);
    }

    fn read_text_frame(
        socket: &mut tokio_tungstenite::tungstenite::WebSocket<std::net::TcpStream>,
    ) -> serde_json::Value {
        loop {
            match socket.read().expect("fake relay reads") {
                Message::Text(text) => {
                    return serde_json::from_str(text.as_str()).expect("frame parses");
                }
                Message::Ping(payload) => {
                    socket
                        .send(Message::Pong(payload))
                        .expect("fake relay pongs");
                }
                Message::Pong(_) => {}
                other => panic!("unexpected frame from agent: {other:?}"),
            }
        }
    }

    /// Scripted fake relay over real TCP: accepts two sequential agent
    /// connections; each gets a v1 narrow push (acked), one allowed and
    /// one sync-denied invoke, then a clean close.
    fn policy_relay_twice() -> (u16, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listener binds");
        let port = listener.local_addr().expect("port known").port();
        let listener = Arc::new(listener);
        let relay = std::thread::spawn({
            let listener = Arc::clone(&listener);
            move || policy_relay_accept_twice(&listener)
        });
        (port, relay)
    }

    fn policy_relay_accept_twice(listener: &std::net::TcpListener) {
        for _ in 0..2 {
            let (stream, _) = listener.accept().expect("agent connects");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("read timeout set");
            let mut socket =
                tokio_tungstenite::tungstenite::accept(stream).expect("upgrade accepted");
            socket
                .send(Message::Text(policy_text(1, &["device.status"]).into()))
                .expect("policy pushed");
            let ack = read_text_frame(&mut socket);
            assert_eq!(
                ack.pointer("/status").and_then(serde_json::Value::as_str),
                Some("applied"),
                "re-push must apply on a fresh connection, saw {ack}"
            );
            let invocation = test_invocation("device-a");
            socket
                .send(Message::Text(
                    invoke_text("route-allowed", &invocation).into(),
                ))
                .expect("invoke sent");
            let result = read_text_frame(&mut socket);
            assert_eq!(
                result
                    .pointer("/result/status")
                    .and_then(serde_json::Value::as_str),
                Some("success"),
                "allowed call must succeed, saw {result}"
            );
            let mut denied = test_invocation("device-a");
            denied.capability = "browser.pages".into();
            socket
                .send(Message::Text(invoke_text("route-denied", &denied).into()))
                .expect("invoke sent");
            let denial = read_text_frame(&mut socket);
            assert_eq!(
                denial
                    .pointer("/result/error/code")
                    .and_then(serde_json::Value::as_str),
                Some("permission_denied"),
                "sync gate must deny narrowed call, saw {denial}"
            );
            socket.close(None).expect("clean close");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn production_path_push_apply_ack_and_enforce_over_real_handshake() {
        let (port, relay) = policy_relay_twice();
        let runtime = test_runtime();
        for _ in 0..2 {
            let mut config = loopback_config(port);
            config.principal_profile = Some(sync_ceiling());
            let outcome = tokio::time::timeout(
                Duration::from_secs(15),
                connect_and_run_with_timing(
                    Arc::clone(&runtime),
                    &config,
                    Duration::from_millis(20),
                    Duration::from_secs(5),
                    Duration::from_secs(10),
                    Duration::from_secs(5),
                ),
            )
            .await
            .expect("connection completes");
            assert!(outcome.is_ok(), "clean close must end Ok, got {outcome:?}");
        }
        relay.join().expect("fake relay completes");
    }
}
