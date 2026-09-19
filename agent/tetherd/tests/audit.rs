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
        "tetherplane-audit-test-{}-{nonce}",
        std::process::id()
    ))
}

fn write_profile(root: &Path, principal_id: &str, capabilities: &[&str]) -> PathBuf {
    std::fs::create_dir_all(root).unwrap();
    let path = root.join(format!("{}.json", principal_id.replace(':', "-")));
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&json!({
            "principal_id": principal_id,
            "authentication": "local_process_binding",
            "allowed_devices": ["Leno"],
            "allowed_capabilities": capabilities,
            "allowed_roots": []
        }))
        .unwrap(),
    )
    .unwrap();
    path
}

fn invocation(request_id: &str, capability: &str, arguments: Value, job_id: Option<&str>) -> Value {
    let mut value = json!({
        "protocol_version": "1.0",
        "request_id": request_id,
        "device_id": "Leno",
        "principal_id": "model:spoofed",
        "job_id": job_id,
        "capability": capability,
        "arguments": {},
        "actor": { "id": "audit-test-controller", "kind": "ai_client" },
        "session_id": null,
        "response_mode": "compact",
        "idempotency_key": null,
        "preconditions": [],
        "expectations": []
    });
    value["arguments"] = arguments;
    value
}

fn rpc(profile: &Path, state_dir: &Path, request: &Value) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tetherd"))
        .arg("--stdio-rpc")
        .arg("--principal-profile")
        .arg(profile)
        .arg("--state-dir")
        .arg(state_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{}", serde_json::to_string(&request).unwrap()).unwrap();
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
fn audit_uses_bound_principal_and_never_persists_arguments() {
    let root = unique_root();
    let state_dir = root.join("state");
    let profile = write_profile(
        &root,
        "model:deepseek-engineer",
        &["device.status", "audit.read"],
    );

    let status = rpc(
        &profile,
        &state_dir,
        &invocation(
            "00000000-0000-4000-8000-000000000201",
            "device.status",
            json!({ "secret": "DO-NOT-PERSIST-THIS" }),
            None,
        ),
    );
    assert_eq!(status["status"], "success");

    let audit = rpc(
        &profile,
        &state_dir,
        &invocation(
            "00000000-0000-4000-8000-000000000202",
            "audit.read",
            json!({ "limit": 20 }),
            None,
        ),
    );
    assert_eq!(audit["status"], "success");
    let events = audit["data"]["events"].as_array().unwrap();
    let event = events
        .iter()
        .find(|event| event["capability"] == "device.status")
        .expect("device.status must be audited");

    assert_eq!(event["principal_id"], "model:deepseek-engineer");
    assert_eq!(event["actor"]["id"], "audit-test-controller");
    assert!(event.get("arguments").is_none());

    let raw = std::fs::read_to_string(state_dir.join("audit").join("events.jsonl")).unwrap();
    assert!(!raw.contains("DO-NOT-PERSIST-THIS"));

    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn audit_job_lineage_is_filterable_and_principal_scoped() {
    let root = unique_root();
    let state_dir = root.join("state");
    let deepseek = write_profile(
        &root,
        "model:deepseek-engineer",
        &["job.create", "device.status", "audit.read"],
    );
    let qwen = write_profile(&root, "model:qwen-general", &["audit.read"]);

    let created = rpc(
        &deepseek,
        &state_dir,
        &invocation(
            "00000000-0000-4000-8000-000000000211",
            "job.create",
            json!({
                "objective": "audit lineage proof",
                "permitted_principals": ["model:qwen-general"]
            }),
            None,
        ),
    );
    assert_eq!(created["status"], "success");
    let job_id = created["data"]["job_id"].as_str().unwrap().to_owned();

    let status = rpc(
        &deepseek,
        &state_dir,
        &invocation(
            "00000000-0000-4000-8000-000000000212",
            "device.status",
            json!({}),
            Some(&job_id),
        ),
    );
    assert_eq!(status["status"], "success");

    let deepseek_audit = rpc(
        &deepseek,
        &state_dir,
        &invocation(
            "00000000-0000-4000-8000-000000000213",
            "audit.read",
            json!({ "job_id": job_id, "limit": 20 }),
            None,
        ),
    );
    assert_eq!(deepseek_audit["status"], "success");
    let events = deepseek_audit["data"]["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["request_id"],
        "00000000-0000-4000-8000-000000000212"
    );
    assert_eq!(events[0]["job_id"], job_id);
    assert_eq!(events[0]["capability"], "device.status");

    let qwen_audit = rpc(
        &qwen,
        &state_dir,
        &invocation(
            "00000000-0000-4000-8000-000000000214",
            "audit.read",
            json!({ "job_id": job_id, "limit": 20 }),
            None,
        ),
    );
    assert_eq!(qwen_audit["status"], "success");
    assert_eq!(qwen_audit["data"]["events"].as_array().unwrap().len(), 0);

    std::fs::remove_dir_all(&root).unwrap();
}
