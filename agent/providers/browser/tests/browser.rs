use std::time::Duration;

use serde_json::json;
use tether_browser_provider::{BrowserBridgeConfig, BrowserProvider};
use tether_core::{Actor, ActorKind, CapabilityProvider, InvocationEnvelope, ResponseMode};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use uuid::Uuid;

fn invocation(capability: &str, arguments: serde_json::Value) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: Uuid::new_v4(),
        device_id: None,
        principal_id: Some("principal-test".into()),
        job_id: Some("job-test".into()),
        capability: capability.into(),
        arguments,
        actor: Actor {
            id: "test".into(),
            kind: ActorKind::AiClient,
        },
        session_id: Some("session-test".into()),
        response_mode: ResponseMode::Compact,
        idempotency_key: Some("idem-test".into()),
        preconditions: vec![json!({"kind":"url"})],
        expectations: vec![json!({"kind":"text"})],
    }
}

async fn fake_bridge(
    response: serde_json::Value,
) -> (String, tokio::task::JoinHandle<serde_json::Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let request: serde_json::Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        write
            .write_all(format!("{response}\n").as_bytes())
            .await
            .unwrap();
        request
    });
    (address, task)
}

#[tokio::test]
async fn handshake_marks_bridge_available_without_exposing_token() {
    let (address, received) = fake_bridge(json!({
        "request_id":"handshake",
        "status":"success",
        "data":{"protocol_version":"1.0","operations":["status","pages","snapshot"]}
    }))
    .await;
    let provider = BrowserProvider::connect(BrowserBridgeConfig {
        address,
        token: Some("secret-token".into()),
        timeout_ms: 2_000,
    })
    .await
    .unwrap();
    assert!(provider.operations().contains(&"snapshot".to_owned()));
    let request = received.await.unwrap();
    assert_eq!(request["type"], "handshake");
    assert_eq!(request["token"], "secret-token");
}

#[tokio::test]
async fn execute_forwards_canonical_context_and_maps_verified_result() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let server = tokio::spawn(async move {
        for index in 0..2 {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            let raw = lines.next_line().await.unwrap().unwrap();
            let request: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if index == 0 {
                write.write_all(b"{\"request_id\":\"handshake\",\"status\":\"success\",\"data\":{\"protocol_version\":\"1.0\",\"operations\":[\"act\"]}}\n").await.unwrap();
            } else {
                let response = json!({
                    "request_id": request["request_id"],
                    "status":"success",
                    "data":{"state":"verified"},
                    "delta":{"semantic_revision":2},
                    "verification":"verified"
                });
                write
                    .write_all(format!("{response}\n").as_bytes())
                    .await
                    .unwrap();
                return request;
            }
        }
        unreachable!()
    });

    let provider = BrowserProvider::connect(BrowserBridgeConfig {
        address,
        token: None,
        timeout_ms: 2_000,
    })
    .await
    .unwrap();
    let call = invocation(
        "browser.act",
        json!({"page_id":"page-1","ownership":"human"}),
    );
    let result = provider.execute(&call).await.unwrap();
    assert_eq!(result.data["state"], "verified");
    assert_eq!(format!("{:?}", result.verification), "Verified");
    let request = server.await.unwrap();
    assert_eq!(request["principal_id"], "principal-test");
    assert_eq!(request["job_id"], "job-test");
    assert_eq!(request["idempotency_key"], "idem-test");
    assert_eq!(request["arguments"]["page_id"], "page-1");
    assert!(
        request["arguments"].get("ownership").is_none(),
        "provider must not forward model-asserted ownership"
    );
}

#[tokio::test]
async fn bridge_errors_remain_machine_readable() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let server = tokio::spawn(async move {
        for index in 0..2 {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            let request: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            let response = if index == 0 {
                json!({"request_id":"handshake","status":"success","data":{"protocol_version":"1.0","operations":["navigate"]}})
            } else {
                json!({"request_id":request["request_id"],"status":"error","error":{"code":"permission_denied","message":"human tab is protected","details":{"page_id":"page-human"}}})
            };
            write
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
        }
    });
    let provider = BrowserProvider::connect(BrowserBridgeConfig {
        address,
        token: None,
        timeout_ms: 2_000,
    })
    .await
    .unwrap();
    let error = provider
        .execute(&invocation(
            "browser.navigate",
            json!({"page_id":"page-human","url":"https://example.test"}),
        ))
        .await
        .unwrap_err();
    assert_eq!(format!("{:?}", error.code), "PermissionDenied");
    assert_eq!(error.details["page_id"], "page-human");
    server.await.unwrap();
}

#[tokio::test]
async fn browser_bridge_endpoint_must_be_loopback() {
    let result = BrowserProvider::connect(BrowserBridgeConfig {
        address: "192.0.2.1:43123".into(),
        token: None,
        timeout_ms: 100,
    })
    .await;
    assert!(result.is_err());
    let error = result.err().unwrap();
    assert_eq!(format!("{:?}", error.code), "InvalidArguments");
    assert!(error.message.contains("loopback"));
}

#[tokio::test]
async fn provider_recovers_after_bridge_restart_on_same_loopback_address() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();

    let handshake = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let request: serde_json::Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(request["type"], "handshake");
        let response = json!({
            "request_id": "handshake",
            "status": "success",
            "data": {
                "protocol_version": "1.0",
                "operations": ["status"]
            },
            "verification": "not_applicable"
        });
        write
            .write_all(format!("{response}\n").as_bytes())
            .await
            .unwrap();
    });

    let provider = BrowserProvider::connect(BrowserBridgeConfig {
        address: address.clone(),
        token: None,
        timeout_ms: 300,
    })
    .await
    .unwrap();
    handshake.await.unwrap();

    let disconnected = provider
        .execute(&invocation("browser.status", json!({})))
        .await
        .unwrap_err();
    assert!(
        matches!(
            format!("{:?}", disconnected.code).as_str(),
            "Disconnected" | "Timeout"
        ),
        "unexpected transient bridge failure: {:?}",
        disconnected.code
    );

    let restarted_listener = TcpListener::bind(&address).await.unwrap();
    let restarted = tokio::spawn(async move {
        let (stream, _) = restarted_listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let request: serde_json::Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(request["type"], "invoke");
        assert_eq!(request["capability"], "browser.status");
        let response = json!({
            "request_id": request["request_id"],
            "status": "success",
            "data": { "available": true, "recovered": true },
            "verification": "not_applicable"
        });
        write
            .write_all(format!("{response}\n").as_bytes())
            .await
            .unwrap();
    });

    let recovered = provider
        .execute(&invocation("browser.status", json!({})))
        .await
        .unwrap();
    assert_eq!(recovered.data["available"], true);
    assert_eq!(recovered.data["recovered"], true);
    restarted.await.unwrap();
}

#[tokio::test]
async fn startup_retry_attaches_when_loopback_bridge_becomes_ready_shortly_after_launch() {
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = reservation.local_addr().unwrap();
    drop(reservation);

    let delayed = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(120)).await;
        let listener = TcpListener::bind(address).await.unwrap();
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let request: serde_json::Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(request["type"], "handshake");
        let response = json!({
            "request_id": "handshake",
            "status": "success",
            "data": {
                "protocol_version": "1.0",
                "operations": ["status", "pages"]
            },
            "verification": "not_applicable"
        });
        write
            .write_all(format!("{response}\n").as_bytes())
            .await
            .unwrap();
    });

    let provider = BrowserProvider::connect_with_retry(
        BrowserBridgeConfig {
            address: address.to_string(),
            token: None,
            timeout_ms: 250,
        },
        8,
        Duration::from_millis(40),
    )
    .await
    .unwrap();

    assert!(provider.operations().contains(&"pages".to_owned()));
    delayed.await.unwrap();
}
