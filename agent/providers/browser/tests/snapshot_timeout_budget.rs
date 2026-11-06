use std::time::Duration;

use serde_json::json;
use tether_browser_provider::{BrowserBridgeConfig, BrowserProvider};
use tether_core::{Actor, ActorKind, CapabilityProvider, InvocationEnvelope, ResponseMode};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use uuid::Uuid;

fn request(capability: &str) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: Uuid::new_v4(),
        device_id: None,
        principal_id: Some("test-operator".into()),
        job_id: None,
        capability: capability.into(),
        arguments: json!({"page_id": "tab:7"}),
        actor: Actor {
            id: "test".into(),
            kind: ActorKind::AiClient,
        },
        session_id: None,
        response_mode: ResponseMode::Compact,
        idempotency_key: None,
        preconditions: vec![],
        expectations: vec![],
    }
}

#[tokio::test]
async fn authorized_snapshot_may_respond_after_short_handshake_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let server = tokio::spawn(async move {
        for step in 0..2 {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            let line = lines.next_line().await.unwrap().unwrap();
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            if step == 0 {
                assert_eq!(request["type"], "handshake");
                let response = json!({
                    "status":"success",
                    "request_id":request["request_id"],
                    "data":{"protocol_version":"1.0","operations":["snapshot","pages"]}
                });
                write
                    .write_all(format!("{response}\n").as_bytes())
                    .await
                    .unwrap();
            } else {
                assert_eq!(request["capability"], "browser.snapshot");
                // This is intentionally longer than the 500ms handshake
                // timeout, demonstrating per-operation timeout selection.
                tokio::time::sleep(Duration::from_millis(900)).await;
                let response = json!({
                    "status":"success",
                    "request_id":request["request_id"],
                    "verification":"not_applicable",
                    "data":{"nodes":[],"revision":7}
                });
                write
                    .write_all(format!("{response}\n").as_bytes())
                    .await
                    .unwrap();
            }
        }
    });
    let provider = BrowserProvider::connect(BrowserBridgeConfig {
        address,
        token: Some("test-local-token".to_owned()),
        timeout_ms: 500,
    })
    .await
    .unwrap();
    let output = provider
        .execute(&request("browser.snapshot"))
        .await
        .unwrap();
    assert_eq!(output.data["revision"], 7);
    server.await.unwrap();
}
