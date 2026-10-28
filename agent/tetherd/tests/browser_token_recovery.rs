use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use uuid::Uuid;

// Kill the disposable stdio agent even when an assertion fails.
struct TestAgent(Child);

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

fn serve_synthetic_browser(listener: TcpListener) {
    let deadline = Instant::now() + Duration::from_secs(12);
    listener.set_nonblocking(true).unwrap();
    while Instant::now() < deadline {
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
            return;
        }
    }
    panic!("no authenticated browser action received after late token provisioning");
}

#[test]
fn late_browser_token_file_recovers_without_agent_restart_or_anonymous_browser_access() {
    let token_path = std::env::temp_dir().join(format!(
        "tetherplane-late-browser-token-{}.txt",
        Uuid::new_v4()
    ));
    assert!(!token_path.exists());

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let server = thread::spawn(move || serve_synthetic_browser(listener));

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

    // Cleanup happens before the assertion so a deliberate RED run leaves no files.
    let _ = std::fs::remove_file(&token_path);
    assert!(
        recovered,
        "RELEASE_NO_GO: core stayed online but never loaded the late owner browser token"
    );
    assert!(child.0.try_wait().unwrap().is_none());
    let browser = invoke(&mut stdin, &mut stdout, "browser.status");
    assert_eq!(browser["status"], "success");
    assert_eq!(browser["data"]["available"], true);
    drop(stdin);
    assert!(child.0.wait().unwrap().success());
    server.join().unwrap();
}
