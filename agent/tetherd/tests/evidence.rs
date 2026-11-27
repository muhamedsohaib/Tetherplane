use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use uuid::Uuid;

fn unique_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "tetherplane-evidence-test-{}-{}",
        std::process::id(),
        Uuid::new_v4().as_simple()
    ))
}

fn write_profile(control_root: &Path, sandbox: &Path) -> PathBuf {
    std::fs::create_dir_all(control_root).unwrap();
    let path = control_root.join("principal.json");
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&json!({
            "principal_id": "model:evidence-prover",
            "authentication": "local_process_binding",
            "allowed_devices": ["Leno"],
            "allowed_capabilities": [
                "filesystem.append",
                "filesystem.read",
                "device.status"
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
        "actor": { "id": "evidence-test", "kind": "ai_client" },
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

fn evidence_records(state_dir: &Path) -> Vec<Value> {
    let raw = std::fs::read_to_string(state_dir.join("evidence").join("evidence.jsonl")).unwrap();
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect()
}

#[test]
fn evidence_file_contains_hashes_only_and_links_audit() {
    let root = unique_root();
    let sandbox = root.join("sandbox");
    let control = root.join("control");
    let state_dir = control.join("state");
    std::fs::create_dir_all(&sandbox).unwrap();
    let profile = write_profile(&control, &sandbox);
    let target = sandbox.join("evidence.txt");

    let secret_content = "SECRET-EVIDENCE-CONTENT-4d2a";
    let secret_key = "SECRET-EVIDENCE-KEY-8f1c";
    let response = rpc(
        &profile,
        &sandbox,
        &state_dir,
        &invocation(
            "00000000-0000-4000-8000-000000000601",
            "filesystem.append",
            json!({ "path": target, "content": secret_content }),
            Some(secret_key),
        ),
    );
    assert_eq!(response["status"], "success");

    let raw = std::fs::read_to_string(state_dir.join("evidence").join("evidence.jsonl")).unwrap();
    assert!(
        !raw.contains(secret_content),
        "evidence must never persist raw arguments"
    );
    assert!(
        !raw.contains(secret_key),
        "evidence must never persist raw idempotency keys"
    );

    let records = evidence_records(&state_dir);
    let record = records
        .iter()
        .find(|record| record["execution"]["capability"] == "filesystem.append")
        .expect("mutation must emit evidence");
    assert_eq!(record["execution"]["principal_id"], "model:evidence-prover");
    assert_eq!(record["outcome"]["status"], "success");
    assert_eq!(record["correlation"]["key_scope"], "explicit");
    assert!(
        record["correlation"]["idempotency_key_hash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert!(
        record["target"]["arguments_hash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert_eq!(
        record["correlation"]["fingerprint"].as_str().unwrap().len(),
        64
    );
    assert_eq!(record["attestation"]["proves_user_intent"], false);
    assert_eq!(
        record["attestation"]["attests"],
        "observed-provider-response-only"
    );
    assert_eq!(record["durability"]["idempotency_tracking"], "durable");
    assert_eq!(record["durability"]["audit_persisted"], true);

    // The evidence links the audit event emitted for the same execution.
    let audit_raw = std::fs::read_to_string(state_dir.join("audit").join("events.jsonl")).unwrap();
    let linked = record["integrity"]["prev_audit_event_id"].as_str().unwrap();
    assert!(
        audit_raw.contains(linked),
        "prev_audit_event_id must name a persisted audit event"
    );

    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn evidence_marks_unkeyed_auto_scope_without_raw_key() {
    let root = unique_root();
    let sandbox = root.join("sandbox");
    let control = root.join("control");
    let state_dir = control.join("state");
    std::fs::create_dir_all(&sandbox).unwrap();
    let profile = write_profile(&control, &sandbox);
    let target = sandbox.join("auto.txt");

    let response = rpc(
        &profile,
        &sandbox,
        &state_dir,
        &invocation(
            "00000000-0000-4000-8000-000000000611",
            "filesystem.append",
            json!({ "path": target, "content": "auto-scoped\n" }),
            None,
        ),
    );
    assert_eq!(response["status"], "success");

    let records = evidence_records(&state_dir);
    let record = records
        .iter()
        .find(|record| record["execution"]["request_id"] == "00000000-0000-4000-8000-000000000611")
        .expect("unkeyed mutation must emit evidence");
    assert_eq!(record["correlation"]["key_scope"], "auto");
    assert!(
        record["correlation"]["idempotency_key_hash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"),
        "auto keys are evidenced by hash, never raw"
    );

    std::fs::remove_dir_all(&root).unwrap();
}
