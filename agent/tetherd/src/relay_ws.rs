use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

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

pub(crate) struct RelayConfig {
    pub url: String,
    pub device_id: String,
    pub credential: String,
    pub allow_insecure_localhost: bool,
    pub reconnect_delay: Duration,
    // Read-only in-process observer; not a socket, credential or device-control channel.
    #[cfg(feature = "developer-beta-notification-feed")]
    pub notification_sink: Option<std::sync::mpsc::SyncSender<tether_notifications::Event>>,
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

// The handshake is separately testable without initializing a Windows desktop/UIA
// provider. Only an accepted WebSocket may create an authenticated-session alert.
async fn connect_device_socket(
    config: &RelayConfig,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    RelayFailure,
> {
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
    Ok(socket)
}

async fn connect_and_run(
    runtime: Arc<AgentRuntime>,
    config: &RelayConfig,
) -> Result<(), RelayFailure> {
    let mut socket = connect_device_socket(config).await?;

    // Deliberately created only AFTER the device-authenticated WebSocket upgrade.
    // On any transport error, RAII teardown reports UNKNOWN (never relay-confirmed offline).
    // A full observer queue never disrupts the authenticated device connection.
    #[cfg(feature = "developer-beta-notification-feed")]
    let _notification_session = config.notification_sink.as_ref().and_then(|sink| {
        tether_notifications::session_feed::AcceptedRelaySession::after_authenticated_upgrade(
            sink.clone(),
            &config.device_id,
        )
        .ok()
    });

    while let Some(next) = socket.next().await {
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
            Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }

    Ok(())
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

    #[test]
    fn relay_url_requires_wss_except_explicit_loopback_test_mode() {
        assert!(validate_relay_url("wss://relay.example.test/device", false).is_ok());
        assert!(validate_relay_url("ws://127.0.0.1:8765/device", true).is_ok());
        assert!(validate_relay_url("ws://localhost:8765/device", true).is_ok());
        assert!(validate_relay_url("ws://relay.example.test/device", false).is_err());
        assert!(validate_relay_url("http://relay.example.test/device", true).is_err());
    }
}

#[cfg(all(test, feature = "developer-beta-notification-feed"))]
mod notification_feed_contract_tests {
    use super::*;
    use std::sync::mpsc::sync_channel;
    use tether_notifications::{EventKind, Provenance};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn config(
        port: u16,
        sink: std::sync::mpsc::SyncSender<tether_notifications::Event>,
    ) -> RelayConfig {
        RelayConfig {
            url: format!("ws://127.0.0.1:{port}/device"),
            device_id: "TP_BETA_TEST".into(),
            credential: "synthetic-test-credential-no-permissions".into(),
            allow_insecure_localhost: true,
            reconnect_delay: Duration::from_millis(10),
            notification_sink: Some(sink),
        }
    }

    #[tokio::test]
    async fn accepted_upgrade_emits_connected_then_unknown_after_close_without_credentials() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = server.local_addr().unwrap().port();
        let server_task = tokio::spawn(async move {
            let (socket, _) = server.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            ws.close(None).await.unwrap();
        });
        let (tx, rx) = sync_channel(8);
        let cfg = config(port, tx.clone());
        let mut socket = tokio::time::timeout(Duration::from_secs(5), connect_device_socket(&cfg))
            .await
            .expect("accepted upgrade must complete")
            .expect("synthetic relay should accept WebSocket");
        let session =
            tether_notifications::session_feed::AcceptedRelaySession::after_authenticated_upgrade(
                tx,
                &cfg.device_id,
            )
            .expect("post-upgrade event must be queued");
        let _ = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("server should close socket");
        server_task.await.unwrap();
        drop(session);
        let a = rx.try_recv().unwrap();
        let b = rx.try_recv().unwrap();
        assert_eq!(a.kind, EventKind::DeviceConnected);
        assert_eq!(a.provenance, Provenance::AuthenticatedRelay);
        assert_eq!(b.kind, EventKind::LocalStatusUnknown);
        assert_eq!(b.provenance, Provenance::LocalAgentTransport);
        assert_eq!(a.device_id, "TP_BETA_TEST");
        assert_eq!(a.source_epoch, b.source_epoch);
        assert!(!format!("{a:?}{b:?}").contains("synthetic-test-credential"));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn denied_upgrade_never_emits_a_connected_event() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = server.local_addr().unwrap().port();
        let server_task = tokio::spawn(async move {
            let (mut socket, _) = server.accept().await.unwrap();
            let mut buffer = [0u8; 2048];
            let _ = socket.read(&mut buffer).await.unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let (tx, rx) = sync_channel(8);
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            connect_device_socket(&config(port, tx)),
        )
        .await
        .expect("denied upgrade must complete");
        assert!(result.is_err());
        server_task.await.unwrap();
        assert!(
            rx.try_recv().is_err(),
            "rejected pairing must not claim connected"
        );
    }
}
