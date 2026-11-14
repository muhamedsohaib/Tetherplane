use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::time::MissedTickBehavior;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tether_core::{
    CapabilityError, ErrorCode, InvocationEnvelope, ResultEnvelope, ResultStatus, Timing,
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
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const HEARTBEAT_PONG_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
struct Heartbeat {
    next_id: u64,
    pending: Option<(u64, Instant)>,
}

impl Heartbeat {
    fn on_tick(&mut self, now: Instant) -> Result<Option<Vec<u8>>, RelayFailure> {
        if let Some((_, sent_at)) = self.pending {
            if now.duration_since(sent_at) >= HEARTBEAT_PONG_TIMEOUT {
                return Err(RelayFailure::Retryable(
                    "relay websocket heartbeat pong timed out".to_owned(),
                ));
            }
            return Ok(None);
        }

        self.next_id = self.next_id.wrapping_add(1);
        self.pending = Some((self.next_id, now));
        Ok(Some(self.next_id.to_be_bytes().to_vec()))
    }

    fn on_pong(&mut self, payload: &[u8]) {
        if let Some((id, _)) = self.pending
            && payload == id.to_be_bytes().as_slice()
        {
            self.pending = None;
        }
    }

    fn on_invocation_completed(&mut self) {
        // Long-running device work may prevent the receive loop from processing
        // a queued pong. Do not classify a healthy connection as stale solely
        // because an authorized invocation took longer than the heartbeat TTL.
        self.pending = None;
    }
}

pub(crate) struct RelayConfig {
    pub url: String,
    pub device_id: String,
    pub credential: String,
    pub allow_insecure_localhost: bool,
    pub reconnect_delay: Duration,
}

#[derive(Debug)]
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

    let (mut socket, _) = tokio::time::timeout(CONNECT_TIMEOUT, connect_async(request))
        .await
        .map_err(|_| {
            RelayFailure::Retryable("relay websocket connection attempt timed out".to_owned())
        })?
        .map_err(|error| classify_connect_error(&error))?;

    let mut heartbeat = Heartbeat::default();
    let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    interval.tick().await; // The first tick is immediate; start after one full interval.

    loop {
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
                        let inbound = serde_json::from_str::<RelayInbound>(text.as_str()).map_err(
                            |error| {
                                RelayFailure::Retryable(format!(
                                    "relay sent invalid invocation message: {error}"
                                ))
                            },
                        )?;
                        match inbound {
                            RelayInbound::Invoke {
                                route_id,
                                invocation,
                            } => {
                                let result =
                                    if invocation.device_id.as_deref() == Some(config.device_id.as_str()) {
                                        runtime.execute(invocation).await
                                    } else {
                                        wrong_device_result(&invocation, &config.device_id)
                                    };
                                heartbeat.on_invocation_completed();
                                interval.reset();
                                let payload = serde_json::to_string(&RelayOutbound {
                                    kind: "result",
                                    route_id: &route_id,
                                    result: &result,
                                })
                                .map_err(|error| {
                                    RelayFailure::Fatal(format!(
                                        "failed to serialize relay result: {error}"
                                    ))
                                })?;
                                socket
                                    .send(Message::Text(payload.into()))
                                    .await
                                    .map_err(|error| {
                                        RelayFailure::Retryable(format!(
                                            "websocket result send failed: {error}"
                                        ))
                                    })?;
                            }
                        }
                    }
                    Message::Ping(payload) => {
                        socket.send(Message::Pong(payload)).await.map_err(|error| {
                            RelayFailure::Retryable(format!("websocket pong failed: {error}"))
                        })?;
                    }
                    Message::Close(_) => return Ok(()),
                    Message::Pong(payload) => heartbeat.on_pong(&payload),
                    Message::Binary(_) | Message::Frame(_) => {}
                }
            }
            _ = interval.tick() => {
                if let Some(payload) = heartbeat.on_tick(Instant::now())? {
                    socket.send(Message::Ping(payload.into())).await.map_err(|error| {
                        RelayFailure::Retryable(format!("websocket heartbeat send failed: {error}"))
                    })?;
                }
            }
        }
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
    use std::time::{Duration, Instant};

    use super::{Heartbeat, RelayFailure, validate_relay_url};

    #[test]
    fn unanswered_heartbeat_forces_reconnection() {
        let start = Instant::now();
        let mut heartbeat = Heartbeat::default();
        let ping = heartbeat.on_tick(start).expect("first heartbeat succeeds");
        assert_eq!(ping.expect("send a ping").len(), 8);
        assert!(
            heartbeat
                .on_tick(start + Duration::from_secs(5))
                .expect("still within timeout")
                .is_none()
        );
        assert!(matches!(
            heartbeat.on_tick(start + Duration::from_secs(10)),
            Err(RelayFailure::Retryable(_))
        ));
    }

    #[test]
    fn only_the_matching_pong_acknowledges_the_heartbeat() {
        let start = Instant::now();
        let mut heartbeat = Heartbeat::default();
        let ping = heartbeat
            .on_tick(start)
            .expect("first heartbeat succeeds")
            .expect("send a ping");
        heartbeat.on_pong(&u64::MAX.to_be_bytes());
        assert!(matches!(
            heartbeat.on_tick(start + Duration::from_secs(10)),
            Err(RelayFailure::Retryable(_))
        ));

        heartbeat.on_pong(&ping);
        assert!(
            heartbeat
                .on_tick(start + Duration::from_secs(11))
                .expect("matching pong clears deadline")
                .is_some()
        );
    }

    #[test]
    fn completed_long_running_invocation_resets_stale_heartbeat() {
        let start = Instant::now();
        let mut heartbeat = Heartbeat::default();
        heartbeat.on_tick(start).expect("first heartbeat succeeds");
        heartbeat.on_invocation_completed();
        assert!(
            heartbeat
                .on_tick(start + Duration::from_secs(120))
                .expect("long invocation does not cause false timeout")
                .is_some()
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
