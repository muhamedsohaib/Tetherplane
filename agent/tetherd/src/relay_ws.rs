use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject;
use rustls::{ClientConfig, RootCertStore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tether_core::{
    CapabilityError, ErrorCode, InvocationEnvelope, ResultEnvelope, ResultStatus,
    SynchronizedDevicePolicy, Timing, VerificationStatus,
};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::{Error as WebSocketError, Message};
use tokio_tungstenite::{Connector, connect_async_tls_with_config};
use url::Url;

use crate::runtime::AgentRuntime;

const DEVICE_ID_HEADER: HeaderName = HeaderName::from_static("x-tetherplane-device-id");

pub(crate) struct RelayConfig {
    pub url: String,
    pub device_id: String,
    pub credential: String,
    pub allow_insecure_localhost: bool,
    pub tls_connector: Option<Connector>,
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

pub(crate) fn load_tls_connector(ca_cert_path: Option<&Path>) -> Result<Option<Connector>, String> {
    let Some(path) = ca_cert_path else {
        return Ok(None);
    };

    let pem_bytes = std::fs::read(path).map_err(|error| {
        format!(
            "failed to read relay CA certificate file {}: {error}",
            path.display()
        )
    })?;

    let mut root_store = RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    let mut added = 0usize;
    for item in CertificateDer::pem_slice_iter(&pem_bytes) {
        let cert = item
            .map_err(|error| format!("invalid PEM certificate in {}: {error}", path.display()))?;
        root_store
            .add(cert)
            .map_err(|error| format!("invalid CA certificate in {}: {error}", path.display()))?;
        added += 1;
    }

    if added == 0 {
        return Err(format!(
            "relay CA certificate file {} contains no PEM certificates",
            path.display()
        ));
    }

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let client_config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("failed to configure TLS protocol versions: {error}"))?
        .with_root_certificates(root_store)
        .with_no_client_auth();

    Ok(Some(Connector::Rustls(Arc::new(client_config))))
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

    let (mut socket, _) =
        connect_async_tls_with_config(request, None, false, config.tls_connector.clone())
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
            tls_connector: None,
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

    // Ephemeral localhost test certificates (EC P-256, valid 2026-2126) for custom CA verification tests.
    const TEST_CA_A_PEM: &str = "-----BEGIN CERTIFICATE-----\n\
MIIBwjCCAWegAwIBAgIUGTzA9sn/9iQdoGOsqEw8HCGqHu0wCgYIKoZIzj0EAwIw\n\
LTErMCkGA1UEAwwiVGV0aGVycGxhbmUgU3RhZ2luZyBGaXh0dXJlIFJvb3QgQTAg\n\
Fw0yNjExMTgwMDU5NDRaGA8yMTI2MTAyNTAwNTk0NFowLTErMCkGA1UEAwwiVGV0\n\
aGVycGxhbmUgU3RhZ2luZyBGaXh0dXJlIFJvb3QgQTBZMBMGByqGSM49AgEGCCqG\n\
SM49AwEHA0IABEouItx7LLIWOx7mzrRTOQVWRyIj3SYNcva9DPVG+wc+KLVzMmfU\n\
Zr5VDSVUBvgankl4tvMMTdMyhhWIvlACGB2jYzBhMB0GA1UdDgQWBBQos44yE9AI\n\
e8tbLN4w5zXg+nswvzAfBgNVHSMEGDAWgBQos44yE9AIe8tbLN4w5zXg+nswvzAP\n\
BgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAgNJADBG\n\
AiEApN3TC4Y8yNUxfwhWL28tT3gtDFFRR4BB7vDzSpsbvJECIQCVeFqLanu6KXk6\n\
SIz9ptunBcJNQTkMIfPdPTwF6ehHlw==\n\
-----END CERTIFICATE-----\n";

    const TEST_CA_B_PEM: &str = "-----BEGIN CERTIFICATE-----\n\
MIIBwjCCAWegAwIBAgIUEJ9Pe3WR4ChWs2RvSYrHKmdzXPEwCgYIKoZIzj0EAwIw\n\
LTErMCkGA1UEAwwiVGV0aGVycGxhbmUgU3RhZ2luZyBGaXh0dXJlIFJvb3QgQjAg\n\
Fw0yNjExMTgwMDU5NDRaGA8yMTI2MTAyNTAwNTk0NFowLTErMCkGA1UEAwwiVGV0\n\
aGVycGxhbmUgU3RhZ2luZyBGaXh0dXJlIFJvb3QgQjBZMBMGByqGSM49AgEGCCqG\n\
SM49AwEHA0IABOc0GDcaH/CnF6agX4tehBNZqd4aTHnkIwdOv+N5XUFnl/yiXeEr\n\
YR4f31/81n9GPmBPeh8CoM+7Ww5xk9Gs85CjYzBhMB0GA1UdDgQWBBQwtAwztG1/\n\
UcIlJ+hLutrSbUqYbDAfBgNVHSMEGDAWgBQwtAwztG1/UcIlJ+hLutrSbUqYbDAP\n\
BgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAgNJADBG\n\
AiEA5Ah/oPSTqmk+M2jc3Vg8j1U9RlVB0LarBGC5oLqPw6wCIQDJmn9gOSxMTvup\n\
TsVWcXw2jdfw2GrmMaUgNd1mqJd04g==\n\
-----END CERTIFICATE-----\n";

    const TEST_LEAF_A_DER: &[u8] = &[
        0x30, 0x82, 0x01, 0xd9, 0x30, 0x82, 0x01, 0x7e, 0xa0, 0x03, 0x02, 0x01, 0x02, 0x02, 0x14,
        0x06, 0x39, 0xb5, 0x46, 0x65, 0xcb, 0xbe, 0x57, 0xbc, 0xb2, 0x23, 0xf7, 0xf1, 0xd7, 0x18,
        0x0e, 0xd8, 0x52, 0xe4, 0x49, 0x30, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04,
        0x03, 0x02, 0x30, 0x2d, 0x31, 0x2b, 0x30, 0x29, 0x06, 0x03, 0x55, 0x04, 0x03, 0x0c, 0x22,
        0x54, 0x65, 0x74, 0x68, 0x65, 0x72, 0x70, 0x6c, 0x61, 0x6e, 0x65, 0x20, 0x53, 0x74, 0x61,
        0x67, 0x69, 0x6e, 0x67, 0x20, 0x46, 0x69, 0x78, 0x74, 0x75, 0x72, 0x65, 0x20, 0x52, 0x6f,
        0x6f, 0x74, 0x20, 0x41, 0x30, 0x20, 0x17, 0x0d, 0x32, 0x36, 0x31, 0x31, 0x31, 0x38, 0x30,
        0x30, 0x35, 0x39, 0x34, 0x34, 0x5a, 0x18, 0x0f, 0x32, 0x31, 0x32, 0x36, 0x31, 0x30, 0x32,
        0x35, 0x30, 0x30, 0x35, 0x39, 0x34, 0x34, 0x5a, 0x30, 0x14, 0x31, 0x12, 0x30, 0x10, 0x06,
        0x03, 0x55, 0x04, 0x03, 0x0c, 0x09, 0x31, 0x32, 0x37, 0x2e, 0x30, 0x2e, 0x30, 0x2e, 0x31,
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
        0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04, 0xe3, 0xde, 0x65,
        0xe7, 0x84, 0x62, 0x28, 0x8d, 0xd3, 0xd7, 0xfe, 0xc9, 0x7a, 0x05, 0x39, 0xd0, 0xfb, 0xf0,
        0x41, 0x53, 0x66, 0x7f, 0xa2, 0x65, 0x12, 0xed, 0x18, 0x1e, 0xe4, 0x75, 0x89, 0xc1, 0x36,
        0xf2, 0xba, 0x90, 0x7f, 0x36, 0x72, 0x00, 0xcd, 0xe2, 0x9d, 0x68, 0xc6, 0x5c, 0x7f, 0x2b,
        0xa3, 0x85, 0x19, 0x44, 0x5b, 0xa6, 0x49, 0xe6, 0x9c, 0xd5, 0xe6, 0xac, 0x86, 0x51, 0xfc,
        0xcc, 0xa3, 0x81, 0x92, 0x30, 0x81, 0x8f, 0x30, 0x0c, 0x06, 0x03, 0x55, 0x1d, 0x13, 0x01,
        0x01, 0xff, 0x04, 0x02, 0x30, 0x00, 0x30, 0x0e, 0x06, 0x03, 0x55, 0x1d, 0x0f, 0x01, 0x01,
        0xff, 0x04, 0x04, 0x03, 0x02, 0x05, 0xa0, 0x30, 0x13, 0x06, 0x03, 0x55, 0x1d, 0x25, 0x04,
        0x0c, 0x30, 0x0a, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01, 0x30, 0x1a,
        0x06, 0x03, 0x55, 0x1d, 0x11, 0x04, 0x13, 0x30, 0x11, 0x87, 0x04, 0x7f, 0x00, 0x00, 0x01,
        0x82, 0x09, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0x68, 0x6f, 0x73, 0x74, 0x30, 0x1d, 0x06, 0x03,
        0x55, 0x1d, 0x0e, 0x04, 0x16, 0x04, 0x14, 0x00, 0x35, 0x48, 0x3a, 0xb0, 0x93, 0xa0, 0x88,
        0x78, 0x9c, 0x91, 0x87, 0xca, 0x1f, 0x7a, 0x07, 0x48, 0x37, 0x53, 0x20, 0x30, 0x1f, 0x06,
        0x03, 0x55, 0x1d, 0x23, 0x04, 0x18, 0x30, 0x16, 0x80, 0x14, 0x28, 0xb3, 0x8e, 0x32, 0x13,
        0xd0, 0x08, 0x7b, 0xcb, 0x5b, 0x2c, 0xde, 0x30, 0xe7, 0x35, 0xe0, 0xfa, 0x7b, 0x30, 0xbf,
        0x30, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02, 0x03, 0x49, 0x00,
        0x30, 0x46, 0x02, 0x21, 0x00, 0x8b, 0xe3, 0xd2, 0xb1, 0x39, 0x93, 0x38, 0x4f, 0x6c, 0x46,
        0x41, 0xe6, 0x54, 0x46, 0xb0, 0xb1, 0x65, 0x88, 0x7a, 0x8f, 0xc2, 0x0a, 0x2f, 0x77, 0x5e,
        0x48, 0x91, 0x7e, 0xc5, 0x98, 0xf5, 0x44, 0x02, 0x21, 0x00, 0xdb, 0x8a, 0x73, 0xb1, 0x9a,
        0x72, 0x7e, 0xe9, 0xd3, 0xea, 0x4d, 0x82, 0x61, 0x2e, 0xb8, 0xe1, 0xac, 0xe4, 0x05, 0x15,
        0xc9, 0x77, 0xd5, 0x81, 0xd0, 0xf4, 0x20, 0x92, 0xa4, 0x24, 0xb7, 0xbd,
    ];

    const TEST_LEAF_A_KEY_PKCS8_DER: &[u8] = &[
        0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d,
        0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30,
        0x6b, 0x02, 0x01, 0x01, 0x04, 0x20, 0x2a, 0x35, 0x5e, 0x1a, 0xc3, 0xce, 0x84, 0xa4, 0x1c,
        0x46, 0x4c, 0xe2, 0x73, 0x45, 0x79, 0x06, 0xd0, 0xcb, 0xb2, 0x7e, 0x40, 0xce, 0xaf, 0xce,
        0x80, 0x47, 0x4a, 0xd3, 0x39, 0xcb, 0x54, 0x07, 0xa1, 0x44, 0x03, 0x42, 0x00, 0x04, 0xe3,
        0xde, 0x65, 0xe7, 0x84, 0x62, 0x28, 0x8d, 0xd3, 0xd7, 0xfe, 0xc9, 0x7a, 0x05, 0x39, 0xd0,
        0xfb, 0xf0, 0x41, 0x53, 0x66, 0x7f, 0xa2, 0x65, 0x12, 0xed, 0x18, 0x1e, 0xe4, 0x75, 0x89,
        0xc1, 0x36, 0xf2, 0xba, 0x90, 0x7f, 0x36, 0x72, 0x00, 0xcd, 0xe2, 0x9d, 0x68, 0xc6, 0x5c,
        0x7f, 0x2b, 0xa3, 0x85, 0x19, 0x44, 0x5b, 0xa6, 0x49, 0xe6, 0x9c, 0xd5, 0xe6, 0xac, 0x86,
        0x51, 0xfc, 0xcc,
    ];

    async fn spawn_test_wss_server() -> (
        u16,
        tokio::sync::mpsc::UnboundedReceiver<String>,
        tokio::task::JoinHandle<()>,
    ) {
        use futures_util::StreamExt;
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
        use std::sync::Arc;
        use tokio::net::TcpListener;
        use tokio_rustls::TlsAcceptor;

        let server_config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(TEST_LEAF_A_DER.to_vec())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(TEST_LEAF_A_KEY_PKCS8_DER.to_vec())),
        )
        .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(server_config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (hello_tx, hello_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        let server_task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let acceptor = acceptor.clone();
                let hello_tx = hello_tx.clone();
                tokio::spawn(async move {
                    let Ok(tls_stream) = acceptor.accept(stream).await else {
                        return;
                    };
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tls_stream).await else {
                        return;
                    };
                    if let Some(Ok(tokio_tungstenite::tungstenite::Message::Text(txt))) =
                        ws.next().await
                    {
                        let _ = hello_tx.send(txt.to_string());
                    }
                    let _ = ws.close(None).await;
                });
            }
        });

        (port, hello_rx, server_task)
    }

    #[tokio::test]
    async fn custom_relay_ca_cert_connects_to_staging_wss_while_untrusted_fails_closed() {
        use crate::runtime::AgentRuntime;
        use std::sync::Arc;
        use std::time::Duration;
        use uuid::Uuid;

        let dir =
            std::env::temp_dir().join(format!("tetherplane-relay-ca-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let ca_a_path = dir.join("ca-a.crt");
        let ca_b_path = dir.join("ca-b.crt");
        let empty_path = dir.join("empty.crt");
        let invalid_path = dir.join("invalid.crt");
        let missing_path = dir.join("missing.crt");
        std::fs::write(&ca_a_path, TEST_CA_A_PEM).unwrap();
        std::fs::write(&ca_b_path, TEST_CA_B_PEM).unwrap();
        std::fs::write(&empty_path, b"not a pem certificate\n").unwrap();
        std::fs::write(
            &invalid_path,
            b"-----BEGIN CERTIFICATE-----\n!!!not-base64!!!\n-----END CERTIFICATE-----\n",
        )
        .unwrap();

        let (port, mut hello_rx, server_task) = spawn_test_wss_server().await;
        let runtime =
            Arc::new(AgentRuntime::new(vec![std::env::temp_dir()], None, None, None).unwrap());
        let wss_url = format!("wss://127.0.0.1:{port}/device");

        // 1. Default system/webpki roots MUST reject our private staging CA A.
        let default_res = super::connect_and_run(
            Arc::clone(&runtime),
            &super::RelayConfig {
                url: wss_url.clone(),
                device_id: "staging-win-01".into(),
                credential: "staging-device-credential-secret".into(),
                allow_insecure_localhost: false,
                tls_connector: super::load_tls_connector(None).unwrap(),
                reconnect_delay: Duration::from_secs(1),
                probe_interval: Duration::from_secs(1),
            },
        )
        .await;
        assert!(
            default_res.is_err(),
            "custom staging CA must fail without --relay-ca-cert"
        );

        // 2. Providing matching CA A MUST succeed the TLS handshake + WebSocket upgrade and send device_hello.
        let custom_connector = super::load_tls_connector(Some(&ca_a_path))
            .expect("valid custom CA PEM must load cleanly");
        assert!(
            custom_connector.is_some(),
            "custom CA path must construct explicit TLS connector"
        );
        let ok_res = super::connect_and_run(
            Arc::clone(&runtime),
            &super::RelayConfig {
                url: wss_url.clone(),
                device_id: "staging-win-01".into(),
                credential: "staging-device-credential-secret".into(),
                allow_insecure_localhost: false,
                tls_connector: custom_connector,
                reconnect_delay: Duration::from_secs(1),
                probe_interval: Duration::from_secs(1),
            },
        )
        .await;
        assert!(
            ok_res.is_ok(),
            "WSS connection with matching --relay-ca-cert must succeed cleanly, got: {ok_res:?}"
        );
        let hello = tokio::time::timeout(Duration::from_secs(2), hello_rx.recv())
            .await
            .expect("server must receive device_hello over WSS")
            .expect("device_hello payload missing");
        let parsed_hello: serde_json::Value = serde_json::from_str(&hello).unwrap();
        assert_eq!(parsed_hello["type"], "device_hello");
        assert_eq!(parsed_hello["deviceId"], "staging-win-01");

        // 3. Mismatched CA B MUST fail closed against CA A's server certificate.
        let wrong_connector = super::load_tls_connector(Some(&ca_b_path)).unwrap();
        let wrong_res = super::connect_and_run(
            Arc::clone(&runtime),
            &super::RelayConfig {
                url: wss_url,
                device_id: "staging-win-01".into(),
                credential: "staging-device-credential-secret".into(),
                allow_insecure_localhost: false,
                tls_connector: wrong_connector,
                reconnect_delay: Duration::from_secs(1),
                probe_interval: Duration::from_secs(1),
            },
        )
        .await;
        assert!(
            wrong_res.is_err(),
            "wrong custom CA B must reject server signed by CA A"
        );

        // 4. Unreadable, empty, or malformed CA PEM files must fail closed.
        assert!(super::load_tls_connector(Some(&missing_path)).is_err());
        assert!(super::load_tls_connector(Some(&empty_path)).is_err());
        assert!(super::load_tls_connector(Some(&invalid_path)).is_err());

        server_task.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
