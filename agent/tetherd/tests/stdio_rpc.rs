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
    let browser = providers
        .iter()
        .find(|provider| provider["namespace"].as_str() == Some("browser"))
        .unwrap();
    assert_eq!(browser["available"].as_bool(), Some(false));

    let desktop = providers
        .iter()
        .find(|provider| provider["namespace"].as_str() == Some("desktop"))
        .unwrap();
    #[cfg(windows)]
    {
        assert_eq!(desktop["available"].as_bool(), Some(true));
        let operations = desktop["operations"].as_array().unwrap();
        let operations = operations
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            operations,
            std::collections::BTreeSet::from([
                "act",
                "foreground_lease_acquire",
                "foreground_lease_get",
                "foreground_lease_release",
                "physical_pointer_move",
                "private_clipboard_get",
                "private_clipboard_set",
                "snapshot",
            ])
        );
    }
    #[cfg(not(windows))]
    assert_eq!(desktop["available"].as_bool(), Some(false));

    let exit = child.wait().unwrap();
    assert!(exit.success());
}

#[test]
fn launch_bound_principal_overrides_caller_claim_and_enforces_grants() {
    const STATUS_ID: &str = "00000000-0000-4000-8000-0000000000a1";
    const DENIED_ID: &str = "00000000-0000-4000-8000-0000000000a2";

    let profile_path = std::env::temp_dir().join(format!(
        "tetherplane-principal-{}-{}.json",
        std::process::id(),
        STATUS_ID
    ));
    std::fs::write(
        &profile_path,
        serde_json::to_vec_pretty(&json!({
            "principal_id": "model:deepseek-engineer",
            "authentication": "local_process_binding",
            "allowed_devices": ["Leno"],
            "allowed_capabilities": ["device.status"],
            "allowed_roots": []
        }))
        .unwrap(),
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_tetherd"))
        .arg("--stdio-rpc")
        .arg("--principal-profile")
        .arg(&profile_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut status_request = device_status_invocation(STATUS_ID);
    status_request["principal_id"] = json!("model:spoofed");

    let mut denied_request = slow_process_invocation(DENIED_ID);
    denied_request["principal_id"] = json!("model:spoofed");

    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{}", serde_json::to_string(&status_request).unwrap()).unwrap();
    writeln!(stdin, "{}", serde_json::to_string(&denied_request).unwrap()).unwrap();
    drop(stdin);

    let stdout = child.stdout.take().unwrap();
    let reader = BufReader::new(stdout);
    let mut responses = std::collections::BTreeMap::new();
    for line in reader.lines().take(2) {
        let result: Value = serde_json::from_str(&line.unwrap()).unwrap();
        responses.insert(result["request_id"].as_str().unwrap().to_owned(), result);
    }

    assert_eq!(responses[STATUS_ID]["status"], "success");
    assert_eq!(responses[DENIED_ID]["status"], "error");
    assert_eq!(responses[DENIED_ID]["error"]["code"], "permission_denied");

    let exit = child.wait().unwrap();
    let _ = std::fs::remove_file(&profile_path);
    assert!(exit.success());
}

#[test]
fn principal_capability_discovery_filters_ungranted_operations() {
    const CAPS_ID: &str = "00000000-0000-4000-8000-0000000000b1";

    let profile_path = std::env::temp_dir().join(format!(
        "tetherplane-capabilities-{}-{}.json",
        std::process::id(),
        CAPS_ID
    ));
    std::fs::write(
        &profile_path,
        serde_json::to_vec_pretty(&json!({
            "principal_id": "model:observer",
            "authentication": "local_process_binding",
            "allowed_devices": ["Leno"],
            "allowed_capabilities": [
                "device.capabilities",
                "device.status",
                "filesystem.read"
            ],
            "allowed_roots": []
        }))
        .unwrap(),
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_tetherd"))
        .arg("--stdio-rpc")
        .arg("--principal-profile")
        .arg(&profile_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut request = device_status_invocation(CAPS_ID);
    request["capability"] = json!("device.capabilities");
    request["principal_id"] = json!("model:spoofed");

    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{}", serde_json::to_string(&request).unwrap()).unwrap();
    drop(stdin);

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    assert!(reader.read_line(&mut line).unwrap() > 0);
    let result: Value = serde_json::from_str(line.trim_end()).unwrap();
    assert_eq!(result["status"], "success");

    let providers = result["data"]["providers"].as_array().unwrap();
    let device = providers
        .iter()
        .find(|provider| provider["namespace"] == "device")
        .unwrap();
    let filesystem = providers
        .iter()
        .find(|provider| provider["namespace"] == "filesystem")
        .unwrap();
    let process = providers
        .iter()
        .find(|provider| provider["namespace"] == "process")
        .unwrap();

    assert_eq!(device["operations"], json!(["status", "capabilities"]));
    assert_eq!(filesystem["operations"], json!(["read"]));
    assert_eq!(process["operations"], json!([]));

    let exit = child.wait().unwrap();
    let _ = std::fs::remove_file(&profile_path);
    assert!(exit.success());
}

#[test]
fn successful_browser_handshake_registers_real_provider_and_capabilities() {
    use std::net::TcpListener;
    use std::thread;

    const CAPS_ID: &str = "00000000-0000-4000-8000-0000000000c1";
    const BROWSER_ID: &str = "00000000-0000-4000-8000-0000000000c2";

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let bridge = thread::spawn(move || {
        for index in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            let request: Value = serde_json::from_str(line.trim_end()).unwrap();
            let response = if index == 0 {
                json!({
                    "request_id": "handshake",
                    "status": "success",
                    "data": {
                        "protocol_version": "1.0",
                        "operations": ["status", "pages", "snapshot"]
                    },
                    "verification": "not_applicable"
                })
            } else {
                assert_eq!(request["capability"], "browser.status");
                json!({
                    "request_id": request["request_id"],
                    "status": "success",
                    "data": {"available": true, "backend": "fake"},
                    "verification": "not_applicable"
                })
            };
            writeln!(stream, "{}", serde_json::to_string(&response).unwrap()).unwrap();
        }
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_tetherd"))
        .arg("--stdio-rpc")
        .arg("--browser-bridge")
        .arg(&address)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut caps = device_status_invocation(CAPS_ID);
    caps["capability"] = json!("device.capabilities");
    let mut browser = device_status_invocation(BROWSER_ID);
    browser["capability"] = json!("browser.status");

    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{}", serde_json::to_string(&caps).unwrap()).unwrap();
    writeln!(stdin, "{}", serde_json::to_string(&browser).unwrap()).unwrap();
    drop(stdin);

    let stdout = child.stdout.take().unwrap();
    let reader = BufReader::new(stdout);
    let mut responses = std::collections::BTreeMap::new();
    for line in reader.lines().take(2) {
        let result: Value = serde_json::from_str(&line.unwrap()).unwrap();
        responses.insert(result["request_id"].as_str().unwrap().to_owned(), result);
    }

    let providers = responses[CAPS_ID]["data"]["providers"].as_array().unwrap();
    let browser_provider = providers
        .iter()
        .find(|provider| provider["namespace"] == "browser")
        .unwrap();
    assert_eq!(browser_provider["available"], true);
    assert_eq!(
        browser_provider["operations"],
        json!(["status", "pages", "snapshot"])
    );
    assert_eq!(responses[BROWSER_ID]["status"], "success");
    assert_eq!(responses[BROWSER_ID]["data"]["backend"], "fake");

    assert!(child.wait().unwrap().success());
    bridge.join().unwrap();
}

#[test]
fn browser_only_cli_fails_closed_without_or_with_unsafe_local_principal() {
    let status = Command::new(env!("CARGO_BIN_EXE_tetherd"))
        .args(["--stdio-rpc", "--browser-only"])
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(2));

    let path = std::env::temp_dir().join(format!(
        "tetherplane-browser-only-deny-{}.json",
        uuid::Uuid::new_v4()
    ));
    let unsafe_profile = json!({
        "principal_id": "browser-isolated-test",
        "authentication": "local_process_binding",
        "allowed_devices": ["Leno"],
        "allowed_capabilities": [
            "device.status", "device.capabilities", "browser.pages",
            "process.run"
        ],
        "allowed_directories": []
    });
    std::fs::write(&path, serde_json::to_vec(&unsafe_profile).unwrap()).unwrap();
    let status = Command::new(env!("CARGO_BIN_EXE_tetherd"))
        .args(["--stdio-rpc", "--browser-only", "--principal-profile"])
        .arg(&path)
        .status()
        .unwrap();
    assert_eq!(
        status.code(),
        Some(2),
        "unsafe principal must fail before startup"
    );

    let safe_profile = json!({
        "principal_id": "browser-isolated-test",
        "authentication": "local_process_binding",
        "allowed_devices": ["Leno"],
        "allowed_capabilities": [
            "device.status", "device.capabilities", "browser.pages"
        ],
        "allowed_directories": []
    });
    std::fs::write(&path, serde_json::to_vec(&safe_profile).unwrap()).unwrap();
    let status = Command::new(env!("CARGO_BIN_EXE_tetherd"))
        .args(["--stdio-rpc", "--browser-only", "--principal-profile"])
        .arg(&path)
        .args(["--allow", "."])
        .status()
        .unwrap();
    assert_eq!(
        status.code(),
        Some(2),
        "browser-only must deny broad --allow roots"
    );
    std::fs::remove_file(&path).unwrap();
}

#[test]
fn browser_only_stdio_cannot_read_files_or_launch_processes_even_when_forged() {
    const STATUS_ID: &str = "00000000-0000-4000-8000-0000000000f1";
    const PROC_ID: &str = "00000000-0000-4000-8000-0000000000f2";
    const FS_ID: &str = "00000000-0000-4000-8000-0000000000f3";
    const BATCH_ID: &str = "00000000-0000-4000-8000-0000000000f4";
    const BROWSER_ID: &str = "00000000-0000-4000-8000-0000000000f5";

    let path = std::env::temp_dir().join(format!(
        "tetherplane-browser-only-allowed-{}.json",
        uuid::Uuid::new_v4()
    ));
    let principal = json!({
        "principal_id": "browser-isolated-test",
        "authentication": "local_process_binding",
        "allowed_devices": ["Leno"],
        "allowed_capabilities": [
            "device.status", "device.capabilities", "browser.pages"
        ],
        "allowed_directories": []
    });
    std::fs::write(&path, serde_json::to_vec(&principal).unwrap()).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_tetherd"))
        .args(["--stdio-rpc", "--browser-only", "--principal-profile"])
        .arg(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut status = device_status_invocation(STATUS_ID);
    // Attack: request claims to be a different, privileged local principal.
    status["principal_id"] = json!("forged-owner-principal");

    let mut process = device_status_invocation(PROC_ID);
    process["principal_id"] = json!("forged-owner-principal");
    process["capability"] = json!("process.run");
    process["arguments"] = json!({
        "program": "an-untrusted-executable-that-must-not-start",
        "args": []
    });

    let mut filesystem = device_status_invocation(FS_ID);
    filesystem["capability"] = json!("filesystem.read");
    filesystem["arguments"] = json!({"path": path});

    let mut batch = device_status_invocation(BATCH_ID);
    batch["capability"] = json!("batch.execute");
    batch["arguments"] = json!({
        "invocations": [{"capability":"process.run","arguments":{}}]
    });

    let mut browser = device_status_invocation(BROWSER_ID);
    browser["capability"] = json!("browser.pages");

    let mut stdin = child.stdin.take().unwrap();
    for request in [status, process, filesystem, batch, browser] {
        writeln!(stdin, "{}", serde_json::to_string(&request).unwrap()).unwrap();
    }
    drop(stdin);

    let stdout = child.stdout.take().unwrap();
    let reader = BufReader::new(stdout);
    let mut results = std::collections::BTreeMap::new();
    for line in reader.lines().take(5) {
        let response: Value = serde_json::from_str(&line.unwrap()).unwrap();
        results.insert(
            response["request_id"].as_str().unwrap().to_owned(),
            response,
        );
    }
    assert_eq!(results.len(), 5);
    assert_eq!(results[STATUS_ID]["status"], "success");
    for id in [PROC_ID, FS_ID, BATCH_ID] {
        assert_eq!(
            results[id]["error"]["code"], "permission_denied",
            "browser-only principal must deny alternate provider: {id}"
        );
    }
    assert_eq!(
        results[BROWSER_ID]["error"]["code"], "capability_unavailable",
        "browser transport can be absent while authorized core runs"
    );
    assert!(child.wait().unwrap().success());
    std::fs::remove_file(&path).unwrap();
}


#[test]
fn release_candidate_browser_outage_must_not_disconnect_local_device_core() {
    const CAPS_ID: &str = "00000000-0000-4000-8000-0000000000d1";

    // A configured but unreachable browser host and an absent local browser
    // token must not terminate the device's independently authenticated core.
    // This is a stdio-only disposable tetherd, never the installed relay task.
    for missing_token in [false, true] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_tetherd"));
        command
            .arg("--stdio-rpc")
            .arg("--browser-bridge")
            .arg("127.0.0.1:1");
        if missing_token {
            command
                .arg("--browser-bridge-token-file")
                .arg(std::env::temp_dir().join(format!(
                    "tetherplane-release-missing-browser-token-{}.txt",
                    uuid::Uuid::new_v4()
                )));
        }

        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();

        let mut request = device_status_invocation(CAPS_ID);
        request["capability"] = json!("device.capabilities");
        let mut input = child.stdin.take().unwrap();
        writeln!(input, "{}", serde_json::to_string(&request).unwrap()).unwrap();
        drop(input);

        let stdout = child.stdout.take().unwrap();
        let mut output = String::new();
        assert!(
            BufReader::new(stdout).read_line(&mut output).unwrap() > 0,
            "RELEASE_NO_GO: browser outage terminated the authenticated core"
        );
        let result: Value = serde_json::from_str(output.trim_end()).unwrap();
        assert_eq!(result["status"], "success");
        let browser = result["data"]["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|provider| provider["namespace"] == "browser")
            .unwrap();
        assert_eq!(browser["available"], false);
        assert_eq!(browser["operations"], json!([]));
        assert!(
            child.wait().unwrap().success(),
            "RELEASE_NO_GO: device core exited unsuccessfully"
        );
    }
}
