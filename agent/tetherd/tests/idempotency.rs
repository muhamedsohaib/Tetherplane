use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

fn unique_root() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "tetherplane-idempotency-test-{}-{nonce}",
        std::process::id()
    ))
}

fn write_profile(control_root: &Path, sandbox: &Path) -> PathBuf {
    std::fs::create_dir_all(control_root).unwrap();
    let path = control_root.join("principal.json");
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&json!({
            "principal_id": "model:deepseek-engineer",
            "authentication": "local_process_binding",
            "allowed_devices": ["Leno"],
            "allowed_capabilities": [
                "filesystem.append",
                "filesystem.read"
            ],
            "allowed_roots": [sandbox]
        }))
        .unwrap(),
    )
    .unwrap();
    path
}

fn invocation(
    request_id: &str,
    capability: &str,
    arguments: Value,
    idempotency_key: Option<&str>,
) -> Value {
    let mut value = json!({
        "protocol_version": "1.0",
        "request_id": request_id,
        "device_id": "Leno",
        "principal_id": "model:spoofed",
        "job_id": null,
        "capability": capability,
        "arguments": {},
        "actor": { "id": "idempotency-test", "kind": "ai_client" },
        "session_id": null,
        "response_mode": "compact",
        "idempotency_key": idempotency_key,
        "preconditions": [],
        "expectations": []
    });
    value["arguments"] = arguments;
    value
}

fn rpc(profile: &Path, sandbox: &Path, state_dir: &Path, request: &Value) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tetherd"))
        .arg("--stdio-rpc")
        .arg("--principal-profile")
        .arg(profile)
        .arg("--allow")
        .arg(sandbox)
        .arg("--state-dir")
        .arg(state_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{}", serde_json::to_string(request).unwrap()).unwrap();
    drop(stdin);

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    assert!(reader.read_line(&mut line).unwrap() > 0);
    let response = serde_json::from_str::<Value>(&line).unwrap();

    let status = child.wait().unwrap();
    assert!(status.success());
    response
}

#[test]
fn idempotent_retry_survives_restart_without_reexecuting_append() {
    let root = unique_root();
    let sandbox = root.join("sandbox");
    let control = root.join("control");
    let state_dir = control.join("state");
    std::fs::create_dir_all(&sandbox).unwrap();
    let profile = write_profile(&control, &sandbox);
    let target = sandbox.join("events.txt");

    let first = rpc(
        &profile,
        &sandbox,
        &state_dir,
        &invocation(
            "00000000-0000-4000-8000-000000000401",
            "filesystem.append",
            json!({ "path": target, "content": "SECRET-IDEMPOTENCY-CONTENT\n" }),
            Some("append-once"),
        ),
    );
    assert_eq!(first["status"], "success");

    let retry = rpc(
        &profile,
        &sandbox,
        &state_dir,
        &invocation(
            "00000000-0000-4000-8000-000000000402",
            "filesystem.append",
            json!({ "path": target, "content": "SECRET-IDEMPOTENCY-CONTENT\n" }),
            Some("append-once"),
        ),
    );
    assert_eq!(retry["status"], "success");
    assert_eq!(retry["request_id"], "00000000-0000-4000-8000-000000000402");

    let read = rpc(
        &profile,
        &sandbox,
        &state_dir,
        &invocation(
            "00000000-0000-4000-8000-000000000403",
            "filesystem.read",
            json!({ "path": target }),
            None,
        ),
    );
    assert_eq!(read["status"], "success");
    assert_eq!(read["data"]["content"], "SECRET-IDEMPOTENCY-CONTENT\n");

    for entry in std::fs::read_dir(state_dir.join("idempotency")).unwrap() {
        let path = entry.unwrap().path();
        let raw = std::fs::read_to_string(path).unwrap();
        assert!(!raw.contains("SECRET-IDEMPOTENCY-CONTENT"));
    }

    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn reusing_idempotency_key_for_different_mutation_fails() {
    let root = unique_root();
    let sandbox = root.join("sandbox");
    let control = root.join("control");
    let state_dir = control.join("state");
    std::fs::create_dir_all(&sandbox).unwrap();
    let profile = write_profile(&control, &sandbox);
    let target = sandbox.join("events.txt");

    let first = rpc(
        &profile,
        &sandbox,
        &state_dir,
        &invocation(
            "00000000-0000-4000-8000-000000000411",
            "filesystem.append",
            json!({ "path": target, "content": "first\n" }),
            Some("same-key"),
        ),
    );
    assert_eq!(first["status"], "success");

    let conflict = rpc(
        &profile,
        &sandbox,
        &state_dir,
        &invocation(
            "00000000-0000-4000-8000-000000000412",
            "filesystem.append",
            json!({ "path": target, "content": "different\n" }),
            Some("same-key"),
        ),
    );
    assert_eq!(conflict["status"], "error");
    assert_eq!(conflict["error"]["code"], "resource_conflict");

    let content = std::fs::read_to_string(&target).unwrap();
    assert_eq!(content, "first\n");

    std::fs::remove_dir_all(&root).unwrap();
}

fn rpc_many(profile: &Path, sandbox: &Path, state_dir: &Path, requests: &[Value]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tetherd"))
        .arg("--stdio-rpc")
        .arg("--principal-profile")
        .arg(profile)
        .arg("--allow")
        .arg(sandbox)
        .arg("--state-dir")
        .arg(state_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    for request in requests {
        writeln!(stdin, "{}", serde_json::to_string(request).unwrap()).unwrap();
    }
    drop(stdin);

    let stdout = child.stdout.take().unwrap();
    let reader = BufReader::new(stdout);
    let responses = reader
        .lines()
        .take(requests.len())
        .map(|line| serde_json::from_str::<Value>(&line.unwrap()).unwrap())
        .collect::<Vec<_>>();

    let status = child.wait().unwrap();
    assert!(status.success());
    responses
}

#[test]
fn concurrent_identical_idempotent_mutations_execute_once() {
    let root = unique_root();
    let sandbox = root.join("sandbox");
    let control = root.join("control");
    let state_dir = control.join("state");
    std::fs::create_dir_all(&sandbox).unwrap();
    let profile = write_profile(&control, &sandbox);
    let target = sandbox.join("concurrent.txt");

    let requests = vec![
        invocation(
            "00000000-0000-4000-8000-000000000421",
            "filesystem.append",
            json!({ "path": target, "content": "once\n" }),
            Some("concurrent-once"),
        ),
        invocation(
            "00000000-0000-4000-8000-000000000422",
            "filesystem.append",
            json!({ "path": target, "content": "once\n" }),
            Some("concurrent-once"),
        ),
    ];
    let responses = rpc_many(&profile, &sandbox, &state_dir, &requests);

    assert_eq!(responses.len(), 2);
    assert!(
        responses
            .iter()
            .all(|response| response["status"] == "success")
    );
    let request_ids = responses
        .iter()
        .map(|response| response["request_id"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        request_ids,
        std::collections::BTreeSet::from([
            "00000000-0000-4000-8000-000000000421",
            "00000000-0000-4000-8000-000000000422",
        ])
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "once\n");

    std::fs::remove_dir_all(&root).unwrap();
}
