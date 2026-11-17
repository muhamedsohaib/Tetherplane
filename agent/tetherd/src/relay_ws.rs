use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tether_core::{
    CapabilityError, ErrorCode, InvocationEnvelope, ResultEnvelope, ResultStatus,
    SynchronizedDevicePolicy, Timing, VerificationStatus,
};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::{Error as WebSocketError, Message};
use url::Url;

use crate::runtime::AgentRuntime;

const DEVICE_ID_HEADER: HeaderName = HeaderName::from_static("x-tetherplane-device-id");

pub(crate) struct RelayConfig {
    pub url: String,
    pub device_id: String,
    pub credential: String,
    pub allow_insecure_localhost: bool,
    pub reconnect_delay: Duration,
    pub probe_interval: Duration,
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
    #[serde(rename = "policy_sync")]
    PolicySync { policy: SynchronizedDevicePolicy },
}

#[derive(Serialize)]
struct RelayResultOutbound<'a> {
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

    let (mut socket, _) = connect_async(request)
        .await
        .map_err(|error| classify_connect_error(&error))?;

    let _ = runtime.refresh_browser_availability().await;
    let hello_payload = json!({
        "type": "device_hello",
        "deviceId": config.device_id,
        "appliedPolicyRevision": runtime.applied_policy_revision(),
        "status": runtime.device_status(),
        "capabilities": runtime.device_capabilities(None, Some(&config.device_id)),
    });
    if let Ok(hello_text) = serde_json::to_string(&hello_payload) {
        socket
            .send(Message::Text(hello_text.into()))
            .await
            .map_err(|error| {
                RelayFailure::Retryable(format!("websocket hello send failed: {error}"))
            })?;
    }

    let mut probe_tick = tokio::time::interval(config.probe_interval);
    probe_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let _ = probe_tick.tick().await;

    loop {
        tokio::select! {
            next = socket.next() => {
                let Some(next) = next else {
                    return Ok(());
                };
                let message = next.map_err(|error| {
                    RelayFailure::Retryable(format!("websocket receive failed: {error}"))
                })?;
                if handle_ws_frame(&mut socket, &runtime, config, message).await? {
                    return Ok(());
                }
            }
            _ = probe_tick.tick(), if runtime.has_browser_provider() => {
                if runtime.refresh_browser_availability().await {
                    send_device_telemetry(&mut socket, &runtime, &config.device_id).await?;
                }
            }
        }
    }
}

async fn handle_ws_frame<S>(
    socket: &mut S,
    runtime: &Arc<AgentRuntime>,
    config: &RelayConfig,
    message: Message,
) -> Result<bool, RelayFailure>
where
    S: futures_util::Sink<Message, Error = WebSocketError> + Unpin,
{
    match message {
        Message::Text(text) => {
            let outbound = handle_inbound_text(runtime, config, text.as_str()).await?;
            socket
                .send(Message::Text(outbound.into()))
                .await
                .map_err(|error| {
                    RelayFailure::Retryable(format!("websocket send failed: {error}"))
                })?;
        }
        Message::Ping(payload) => {
            socket.send(Message::Pong(payload)).await.map_err(|error| {
                RelayFailure::Retryable(format!("websocket pong failed: {error}"))
            })?;
        }
        Message::Close(_) => return Ok(true),
        Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
    }
    Ok(false)
}

async fn send_device_telemetry<S>(
    socket: &mut S,
    runtime: &AgentRuntime,
    device_id: &str,
) -> Result<(), RelayFailure>
where
    S: futures_util::Sink<Message, Error = WebSocketError> + Unpin,
{
    let payload = json!({
        "type": "device_telemetry",
        "deviceId": device_id,
        "status": runtime.device_status(),
        "capabilities": runtime.device_capabilities(None, Some(device_id)),
    });
    if let Ok(text) = serde_json::to_string(&payload) {
        socket
            .send(Message::Text(text.into()))
            .await
            .map_err(|error| {
                RelayFailure::Retryable(format!("websocket telemetry send failed: {error}"))
            })?;
    }
    Ok(())
}

async fn handle_inbound_text(
    runtime: &Arc<AgentRuntime>,
    config: &RelayConfig,
    text: &str,
) -> Result<String, RelayFailure> {
    let inbound = serde_json::from_str::<RelayInbound>(text)
        .map_err(|error| RelayFailure::Retryable(format!("relay sent invalid message: {error}")))?;
    match inbound {
        RelayInbound::Invoke {
            route_id,
            invocation,
        } => {
            let result = if invocation.device_id.as_deref() == Some(config.device_id.as_str()) {
                runtime.execute(invocation).await
            } else {
                wrong_device_result(&invocation, &config.device_id)
            };
            serde_json::to_string(&RelayResultOutbound {
                kind: "result",
                route_id: &route_id,
                result: &result,
            })
            .map_err(|error| {
                RelayFailure::Fatal(format!("failed to serialize relay result: {error}"))
            })
        }
        RelayInbound::PolicySync { policy } => {
            let pushed_revision = policy.revision;
            let ack_payload = if policy.device_id == config.device_id {
                match runtime.apply_synchronized_policy(policy) {
                    Ok(ack_data) => build_policy_ack(&config.device_id, &ack_data, None),
                    Err(error) => json!({
                        "type": "policy_ack",
                        "deviceId": config.device_id,
                        "revision": pushed_revision,
                        "currentRevision": runtime.applied_policy_revision(),
                        "applied": false,
                        "error": error.message,
                    }),
                }
            } else {
                json!({
                    "type": "policy_ack",
                    "deviceId": config.device_id,
                    "revision": pushed_revision,
                    "currentRevision": runtime.applied_policy_revision(),
                    "applied": false,
                    "error": "policy_sync target device does not match local device_id",
                })
            };
            serde_json::to_string(&ack_payload).map_err(|error| {
                RelayFailure::Fatal(format!("failed to serialize policy_ack: {error}"))
            })
        }
    }
}

fn build_policy_ack(device_id: &str, ack_data: &Value, error: Option<&str>) -> Value {
    json!({
        "type": "policy_ack",
        "deviceId": device_id,
        "revision": ack_data["revision"],
        "currentRevision": ack_data["revision"],
        "applied": ack_data["applied"],
        "appliedAtMs": ack_data["appliedAtMs"],
        "status": ack_data["status"],
        "capabilities": ack_data["capabilities"],
        "error": error,
    })
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
    use super::{RelayInbound, validate_relay_url};
    use serde_json::json;

    #[test]
    fn relay_url_requires_wss_except_explicit_loopback_test_mode() {
        assert!(validate_relay_url("wss://relay.example.test/device", false).is_ok());
        assert!(validate_relay_url("ws://127.0.0.1:8765/device", true).is_ok());
        assert!(validate_relay_url("ws://localhost:8765/device", true).is_ok());
        assert!(validate_relay_url("ws://relay.example.test/device", false).is_err());
        assert!(validate_relay_url("http://relay.example.test/device", true).is_err());
    }

    #[test]
    fn policy_sync_inbound_message_deserializes_universal_owner_policy() {
        let message = json!({
            "type": "policy_sync",
            "policy": {
                "device_id": "Leno",
                "owner_account_id": "account-a",
                "owner_principal_id": "human:account-a",
                "revision": 3,
                "updated_at_ms": 1_700_000_000_000_u64,
                "updated_by": "human:account-a",
                "reason": "Grant universal access",
                "emergency_lockdown": false,
                "owner_policy": {
                    "principal_id": "human:account-a",
                    "role": "owner",
                    "profile_id": "universal",
                    "universal_permissions": true,
                    "allowed_families": ["device", "files", "process", "browser", "desktop", "batch"],
                    "denied_families": [],
                    "allowed_capabilities": [],
                    "denied_capabilities": [],
                    "allowed_roots": [],
                    "allow_destructive": true
                },
                "operator_policies": {}
            }
        });

        let parsed: RelayInbound = serde_json::from_value(message).unwrap();
        match parsed {
            RelayInbound::PolicySync { policy } => {
                assert_eq!(policy.device_id, "Leno");
                assert_eq!(policy.revision, 3);
                assert!(policy.owner_policy.universal_permissions);
            }
            RelayInbound::Invoke { .. } => panic!("expected PolicySync"),
        }
    }

    #[tokio::test]
    async fn stale_policy_sync_returns_failed_policy_ack_with_current_revision() {
        use crate::runtime::AgentRuntime;
        use std::sync::Arc;
        use std::time::Duration;
        use tether_core::{SynchronizedDevicePolicy, ToolFamily};

        let runtime =
            Arc::new(AgentRuntime::new(vec![std::env::temp_dir()], None, None, None).unwrap());
        let rev1 =
            SynchronizedDevicePolicy::universal_for_owner("Leno", "account-a", "human:account-a");
        let mut rev2 = rev1.clone();
        rev2.revision = 2;
        rev2.emergency_lockdown = true;
        rev2.owner_policy
            .denied_families
            .insert(ToolFamily::Process);
        runtime.apply_synchronized_policy(rev2).unwrap();

        let config = super::RelayConfig {
            url: "ws://127.0.0.1:1/device".into(),
            device_id: "Leno".into(),
            credential: "device-secret-token-for-unit-test".into(),
            allow_insecure_localhost: true,
            reconnect_delay: Duration::from_secs(1),
            probe_interval: Duration::from_secs(1),
        };
        let stale_payload = json!({
            "type": "policy_sync",
            "policy": rev1,
        });
        let raw = serde_json::to_string(&stale_payload).unwrap();
        let reply_text = super::handle_inbound_text(&runtime, &config, &raw)
            .await
            .expect("handle_inbound_text should return policy_ack JSON");
        let reply: serde_json::Value = serde_json::from_str(&reply_text).unwrap();
        assert_eq!(reply["type"], "policy_ack");
        assert_eq!(reply["deviceId"], "Leno");
        assert_eq!(reply["revision"], 1);
        assert_eq!(reply["currentRevision"], 2);
        assert_eq!(reply["applied"], false);
        assert!(reply["error"].as_str().is_some());
    }
}
