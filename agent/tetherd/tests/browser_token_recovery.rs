use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use uuid::Uuid;

// Kill the disposable stdio agent even when an assertion fails.
struct TestAgent(Child);

// Keep test-only credentials removable even when a failing assertion unwinds.
struct TokenCleanup(PathBuf);

impl Drop for TokenCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

impl Drop for TestAgent {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn invoke(stdin: &mut impl Write, stdout: &mut impl BufRead, capability: &str) -> Value {
    let request_id = Uuid::new_v4().to_string();
    let request = json!({
        "protocol_version": "1.0",
        "request_id": request_id,
        "device_id": "disposable-test",
        "capability": capability,
        "arguments": {},
        "actor": {"id": "late-token-test", "kind": "ai_client"},
        "session_id": null,
        "response_mode": "compact",
        "idempotency_key": null,
        "preconditions": [],
        "expectations": []
    });
    writeln!(stdin, "{request}").unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    assert!(
        stdout.read_line(&mut line).unwrap() > 0,
        "RELEASE_NO_GO: browser token lifecycle disconnected the device core"
    );
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["request_id"], request_id);
    response
}

fn browser_available(result: &Value) -> bool {
    assert_eq!(result["status"], "success");
    result["data"]["providers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|provider| provider["namespace"] == "browser" && provider["available"] == true)
}

fn serve_synthetic_browser(listener: &TcpListener, stop: &AtomicBool) {
    let deadline = Instant::now() + Duration::from_secs(12);
    listener.set_nonblocking(true).unwrap();
    let mut invoked = false;
    while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
        let (mut socket, _) = match listener.accept() {
            Ok(connection) => connection,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20));
                continue;
            }
            Err(error) => panic!("test bridge accept failed: {error}"),
        };
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut line = String::new();
        BufReader::new(socket.try_clone().unwrap())
            .read_line(&mut line)
            .unwrap();
        let request: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["token"], "synthetic-late-owner-token");
        let response = match request["type"].as_str() {
            Some("handshake") => json!({
                "request_id": "handshake",
                "status": "success",
                "data": {"protocol_version": "1.0", "operations": ["status"]}
            }),
            Some("invoke") => {
                assert_eq!(request["capability"], "browser.status");
                json!({
                    "request_id": request["request_id"],
                    "status": "success",
                    "data": {"available": true, "backend": "synthetic-test-bridge"}
                })
            }
            other => panic!("unexpected browser bridge request: {other:?}"),
        };
        writeln!(socket, "{response}").unwrap();
        if request["type"] == "invoke" {
            invoked = true;
        }
    }
    assert!(stop.load(Ordering::SeqCst), "synthetic browser was not shut down by test");
    assert!(invoked, "no authenticated browser action after late token provisioning");
}

#[test]
fn late_browser_token_file_recovers_without_agent_restart_or_anonymous_browser_access() {
    let token_path = std::env::temp_dir().join(format!(
        "tetherplane-late-browser-token-{}.txt",
        Uuid::new_v4()
    ));
    assert!(!token_path.exists());
    let _cleanup = TokenCleanup(token_path.clone());

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || serve_synthetic_browser(&listener, &server_stop));

    let mut child = TestAgent(
        Command::new(env!("CARGO_BIN_EXE_tetherd"))
            .arg("--stdio-rpc")
            .arg("--browser-bridge")
            .arg(&address)
            .arg("--browser-bridge-token-file")
            .arg(&token_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut stdin = child.0.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.0.stdout.take().unwrap());

    let before = invoke(&mut stdin, &mut stdout, "device.capabilities");
    assert!(!browser_available(&before));
    let denied = invoke(&mut stdin, &mut stdout, "browser.status");
    assert_eq!(denied["status"], "error");
    assert_eq!(denied["error"]["code"], "capability_unavailable");
    assert!(child.0.try_wait().unwrap().is_none());

    // The owner creates a disposable token after the already-running agent starts.
    std::fs::write(&token_path, "synthetic-late-owner-token\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(9);
    let mut recovered = false;
    while Instant::now() < deadline {
        let caps = invoke(&mut stdin, &mut stdout, "device.capabilities");
        if browser_available(&caps) {
            recovered = true;
            break;
        }
        thread::sleep(Duration::from_millis(70));
    }

    assert!(
        recovered,
        "RELEASE_NO_GO: core stayed online but never loaded the late owner browser token"
    );
    assert!(child.0.try_wait().unwrap().is_none());
    let browser = invoke(&mut stdin, &mut stdout, "browser.status");
    assert_eq!(browser["status"], "success");
    assert_eq!(browser["data"]["available"], true);

    // The test bridge remains alive; loss of browser availability must result
    // from removing the local credential, not a coincidental host shutdown.
    std::fs::remove_file(&token_path).unwrap();
    let revoke_deadline = Instant::now() + Duration::from_secs(7);
    let mut revoked = false;
    while Instant::now() < revoke_deadline {
        let caps = invoke(&mut stdin, &mut stdout, "device.capabilities");
        if !browser_available(&caps) {
            revoked = true;
            break;
        }
        thread::sleep(Duration::from_millis(70));
    }
    assert!(revoked, "RELEASE_NO_GO: removed browser token remained authorized");
    assert!(!server.is_finished(), "synthetic browser exited before revocation check");
    let denied_after_removal = invoke(&mut stdin, &mut stdout, "browser.status");
    assert_eq!(denied_after_removal["status"], "error");
    assert_eq!(denied_after_removal["error"]["code"], "capability_unavailable");
    let core_after_revocation = invoke(&mut stdin, &mut stdout, "device.status");
    assert_eq!(core_after_revocation["status"], "success");

    stop.store(true, Ordering::SeqCst);
    drop(stdin);
    assert!(child.0.wait().unwrap().success());
    server.join().unwrap();
}
