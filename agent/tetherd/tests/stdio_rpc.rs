use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

const REQUEST_ID: &str = "00000000-0000-4000-8000-000000000009";

fn device_status_invocation(request_id: &str) -> Value {
    json!({
        "protocol_version": "1.0",
        "request_id": request_id,
        "device_id": "Leno",
        "capability": "device.status",
        "arguments": {},
        "actor": {
            "id": "stdio-rpc-test",
            "kind": "ai_client"
        },
        "session_id": null,
        "response_mode": "compact",
        "idempotency_key": null,
        "preconditions": [],
        "expectations": []
    })
}

#[test]
fn stdio_rpc_returns_one_correlated_result_line() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tetherd"))
        .arg("--stdio-rpc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let invocation = device_status_invocation(REQUEST_ID);
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{}", serde_json::to_string(&invocation).unwrap()).unwrap();
    drop(stdin);

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let read = reader.read_line(&mut line).unwrap();

    assert!(read > 0, "tetherd produced no JSONL response");
    let result: Value = serde_json::from_str(line.trim_end()).unwrap();
    assert_eq!(result["request_id"].as_str(), Some(REQUEST_ID));
    assert_eq!(result["status"].as_str(), Some("success"));

    let status = child.wait().unwrap();
    assert!(status.success());
}

#[test]
fn malformed_json_with_recoverable_request_id_returns_error_result() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tetherd"))
        .arg("--stdio-rpc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{{\"request_id\":\"{REQUEST_ID}\",\"capability\":").unwrap();
    drop(stdin);

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let read = reader.read_line(&mut line).unwrap();

    assert!(
        read > 0,
        "malformed request with recoverable ID got no response"
    );
    let result: Value = serde_json::from_str(line.trim_end()).unwrap();
    assert_eq!(result["request_id"].as_str(), Some(REQUEST_ID));
    assert_eq!(result["status"].as_str(), Some("error"));
    assert_eq!(result["error"]["code"].as_str(), Some("invalid_arguments"));

    let status = child.wait().unwrap();
    assert!(status.success());
}

#[cfg(windows)]
fn slow_process_invocation(request_id: &str) -> Value {
    json!({
        "protocol_version": "1.0",
        "request_id": request_id,
        "device_id": "Leno",
        "capability": "process.run",
        "arguments": {
            "program": "cmd.exe",
            "args": ["/C", "ping -n 2 127.0.0.1 >NUL"],
            "wait_ms": 250
        },
        "actor": { "id": "stdio-rpc-test", "kind": "ai_client" },
        "session_id": null,
        "response_mode": "compact",
        "idempotency_key": null,
        "preconditions": [],
        "expectations": []
    })
}

#[cfg(unix)]
fn slow_process_invocation(request_id: &str) -> Value {
    json!({
        "protocol_version": "1.0",
        "request_id": request_id,
        "device_id": "Leno",
        "capability": "process.run",
        "arguments": {
            "program": "/bin/sh",
            "args": ["-c", "sleep 0.4"],
            "wait_ms": 250
        },
        "actor": { "id": "stdio-rpc-test", "kind": "ai_client" },
        "session_id": null,
        "response_mode": "compact",
        "idempotency_key": null,
        "preconditions": [],
        "expectations": []
    })
}

#[test]
fn concurrent_requests_remain_correlated_and_jsonl_framed() {
    const IDS: [&str; 4] = [
        "00000000-0000-4000-8000-000000000091",
        "00000000-0000-4000-8000-000000000092",
        "00000000-0000-4000-8000-000000000093",
        "00000000-0000-4000-8000-000000000094",
    ];

    let mut child = Command::new(env!("CARGO_BIN_EXE_tetherd"))
        .arg("--stdio-rpc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    writeln!(
        stdin,
        "{}",
        serde_json::to_string(&slow_process_invocation(IDS[0])).unwrap()
    )
    .unwrap();
    for request_id in &IDS[1..] {
        writeln!(
            stdin,
            "{}",
            serde_json::to_string(&device_status_invocation(request_id)).unwrap()
        )
        .unwrap();
    }
    drop(stdin);

    let stdout = child.stdout.take().unwrap();
    let reader = BufReader::new(stdout);
    let mut seen = std::collections::BTreeSet::new();
    for line in reader.lines().take(IDS.len()) {
        let line = line.unwrap();
        let result: Value = serde_json::from_str(&line).unwrap();
        let request_id = result["request_id"].as_str().unwrap().to_owned();
        assert!(IDS.contains(&request_id.as_str()));
        assert!(seen.insert(request_id), "duplicate request ID response");
    }

    assert_eq!(seen.len(), IDS.len());
    let status = child.wait().unwrap();
    assert!(status.success());
}

#[test]
fn device_status_and_capabilities_are_minimal_and_truthful() {
    const STATUS_ID: &str = "00000000-0000-4000-8000-000000000095";
    const CAPS_ID: &str = "00000000-0000-4000-8000-000000000096";

    let mut child = Command::new(env!("CARGO_BIN_EXE_tetherd"))
        .arg("--stdio-rpc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let status_request = device_status_invocation(STATUS_ID);
    let mut capabilities_request = device_status_invocation(CAPS_ID);
    capabilities_request["capability"] = json!("device.capabilities");

    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{}", serde_json::to_string(&status_request).unwrap()).unwrap();
    writeln!(
        stdin,
        "{}",
        serde_json::to_string(&capabilities_request).unwrap()
    )
    .unwrap();
    drop(stdin);

    let stdout = child.stdout.take().unwrap();
    let reader = BufReader::new(stdout);
    let mut responses = std::collections::BTreeMap::new();
    for line in reader.lines().take(2) {
        let result: Value = serde_json::from_str(&line.unwrap()).unwrap();
        responses.insert(result["request_id"].as_str().unwrap().to_owned(), result);
    }

    let status = &responses[STATUS_ID]["data"];
    let keys: std::collections::BTreeSet<&str> = status
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        std::collections::BTreeSet::from([
            "agent_version",
            "arch",
            "os",
            "policy_mode",
            "uptime_ms",
        ])
    );
    assert_eq!(status["policy_mode"].as_str(), Some("background_only"));

    let providers = responses[CAPS_ID]["data"]["providers"].as_array().unwrap();
    for namespace in ["filesystem", "search", "process", "device", "batch"] {
        let provider = providers
            .iter()
            .find(|provider| provider["namespace"].as_str() == Some(namespace))
            .unwrap();
        assert_eq!(provider["available"].as_bool(), Some(true));
    }
    for namespace in ["browser", "desktop"] {
        let provider = providers
            .iter()
            .find(|provider| provider["namespace"].as_str() == Some(namespace))
            .unwrap();
        assert_eq!(provider["available"].as_bool(), Some(false));
    }

    let exit = child.wait().unwrap();
    assert!(exit.success());
}
