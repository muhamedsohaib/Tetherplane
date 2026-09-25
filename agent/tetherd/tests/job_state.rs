use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use uuid::Uuid;

fn unique_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "tetherplane-job-test-{}-{}",
        std::process::id(),
        Uuid::new_v4().as_simple()
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

fn invocation(request_id: &str, capability: &str, arguments: Value) -> Value {
    let mut invocation = json!({
        "protocol_version": "1.0",
        "request_id": request_id,
        "device_id": "Leno",
        "principal_id": "model:spoofed",
        "job_id": null,
        "capability": capability,
        "arguments": {},
        "actor": { "id": "job-test-client", "kind": "ai_client" },
        "session_id": null,
        "response_mode": "compact",
        "idempotency_key": null,
        "preconditions": [],
        "expectations": []
    });
    invocation["arguments"] = arguments;
    invocation
}

fn rpc(profile: &Path, state_dir: &Path, requests: &[Value]) -> Vec<Value> {
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
fn job_record_survives_agent_restart() {
    const CREATE_ID: &str = "00000000-0000-4000-8000-0000000000c1";
    const GET_ID: &str = "00000000-0000-4000-8000-0000000000c2";

    let root = unique_root();
    let state_dir = root.join("state");
    let profile = write_profile(&root, "model:deepseek-engineer", &["job.create", "job.get"]);

    let created = rpc(
        &profile,
        &state_dir,
        &[invocation(
            CREATE_ID,
            "job.create",
            json!({
                "objective": "prove durable controller handoff",
                "permitted_principals": ["model:qwen-general"]
            }),
        )],
    );
    assert_eq!(created[0]["status"], "success");
    let job_id = created[0]["data"]["job_id"].as_str().unwrap().to_owned();

    let read_back = rpc(
        &profile,
        &state_dir,
        &[invocation(GET_ID, "job.get", json!({ "job_id": job_id }))],
    );

    assert_eq!(read_back[0]["status"], "success");
    assert_eq!(
        read_back[0]["data"]["objective"],
        "prove durable controller handoff"
    );
    assert_eq!(
        read_back[0]["data"]["creator_principal"],
        "model:deepseek-engineer"
    );

    std::fs::remove_dir_all(&root).unwrap();
}

fn create_job(
    profile: &Path,
    state_dir: &Path,
    request_id: &str,
    permitted_principals: &[&str],
) -> String {
    let created = rpc(
        profile,
        state_dir,
        &[invocation(
            request_id,
            "job.create",
            json!({
                "objective": "handoff proof",
                "permitted_principals": permitted_principals
            }),
        )],
    );
    assert_eq!(created[0]["status"], "success");
    created[0]["data"]["job_id"].as_str().unwrap().to_owned()
}

#[test]
fn permitted_second_principal_reads_checkpoint_after_release() {
    let root = unique_root();
    let state_dir = root.join("state");
    let creator = write_profile(
        &root,
        "model:deepseek-engineer",
        &[
            "job.create",
            "job.get",
            "job.acquire_lease",
            "job.checkpoint",
            "job.release_lease",
        ],
    );
    let second = write_profile(
        &root,
        "model:qwen-general",
        &["job.get", "job.acquire_lease", "job.release_lease"],
    );
    let job_id = create_job(
        &creator,
        &state_dir,
        "00000000-0000-4000-8000-0000000000d1",
        &["model:qwen-general"],
    );

    let acquired = rpc(
        &creator,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-0000000000d2",
            "job.acquire_lease",
            json!({ "job_id": job_id, "ttl_ms": 5_000 }),
        )],
    );
    assert_eq!(acquired[0]["status"], "success");
    let lease_id = acquired[0]["data"]["active_lease"]["lease_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let checkpointed = rpc(
        &creator,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-0000000000d3",
            "job.checkpoint",
            json!({
                "job_id": job_id,
                "status": "checkpointed",
                "state": {
                    "step": "sandbox_artifact_created",
                    "artifacts": ["artifact.txt"]
                }
            }),
        )],
    );
    assert_eq!(checkpointed[0]["status"], "success");

    let released = rpc(
        &creator,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-0000000000d4",
            "job.release_lease",
            json!({ "job_id": job_id, "lease_id": lease_id }),
        )],
    );
    assert_eq!(released[0]["status"], "success");
    assert!(released[0]["data"]["active_lease"].is_null());

    let read_by_second = rpc(
        &second,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-0000000000d5",
            "job.get",
            json!({ "job_id": job_id }),
        )],
    );
    assert_eq!(read_by_second[0]["status"], "success");
    assert_eq!(
        read_by_second[0]["data"]["latest_checkpoint"]["state"]["step"],
        "sandbox_artifact_created"
    );
    assert_eq!(
        read_by_second[0]["data"]["latest_checkpoint"]["principal_id"],
        "model:deepseek-engineer"
    );

    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn unauthorized_principal_cannot_read_job() {
    let root = unique_root();
    let state_dir = root.join("state");
    let creator = write_profile(&root, "model:deepseek-engineer", &["job.create", "job.get"]);
    let outsider = write_profile(&root, "model:arcus-contrarian", &["job.get"]);
    let job_id = create_job(
        &creator,
        &state_dir,
        "00000000-0000-4000-8000-0000000000e1",
        &[],
    );

    let denied = rpc(
        &outsider,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-0000000000e2",
            "job.get",
            json!({ "job_id": job_id }),
        )],
    );

    assert_eq!(denied[0]["status"], "error");
    assert_eq!(denied[0]["error"]["code"], "permission_denied");
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn live_lease_conflicts_then_expiry_allows_reacquire() {
    let root = unique_root();
    let state_dir = root.join("state");
    let creator = write_profile(
        &root,
        "model:deepseek-engineer",
        &["job.create", "job.acquire_lease"],
    );
    let second = write_profile(&root, "model:qwen-general", &["job.acquire_lease"]);
    let job_id = create_job(
        &creator,
        &state_dir,
        "00000000-0000-4000-8000-0000000000f1",
        &["model:qwen-general"],
    );

    let first = rpc(
        &creator,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-0000000000f2",
            "job.acquire_lease",
            json!({ "job_id": job_id, "ttl_ms": 60_000 }),
        )],
    );
    assert_eq!(first[0]["status"], "success");

    let conflict = rpc(
        &second,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-0000000000f3",
            "job.acquire_lease",
            json!({ "job_id": job_id, "ttl_ms": 1_000 }),
        )],
    );
    assert_eq!(conflict[0]["status"], "error");
    assert_eq!(conflict[0]["error"]["code"], "resource_conflict");

    let job_path = state_dir.join("jobs").join(format!("{job_id}.json"));
    let mut persisted =
        serde_json::from_slice::<Value>(&std::fs::read(&job_path).unwrap()).unwrap();
    persisted["active_lease"]["expires_at_unix_ms"] = json!(0);
    std::fs::write(&job_path, serde_json::to_vec_pretty(&persisted).unwrap()).unwrap();

    let reacquired = rpc(
        &second,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-0000000000f4",
            "job.acquire_lease",
            json!({ "job_id": job_id, "ttl_ms": 1_000 }),
        )],
    );
    assert_eq!(reacquired[0]["status"], "success");
    assert_eq!(
        reacquired[0]["data"]["active_lease"]["principal_id"],
        "model:qwen-general"
    );

    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn execution_lease_does_not_expand_principal_capabilities() {
    let root = unique_root();
    let state_dir = root.join("state");
    let creator = write_profile(&root, "model:deepseek-engineer", &["job.create"]);
    let second = write_profile(&root, "model:qwen-general", &["job.acquire_lease"]);
    let job_id = create_job(
        &creator,
        &state_dir,
        "00000000-0000-4000-8000-000000000101",
        &["model:qwen-general"],
    );

    let acquired = rpc(
        &second,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-000000000102",
            "job.acquire_lease",
            json!({ "job_id": job_id, "ttl_ms": 5_000 }),
        )],
    );
    assert_eq!(acquired[0]["status"], "success");

    let denied = rpc(
        &second,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-000000000103",
            "process.run",
            json!({
                "program": "cmd.exe",
                "args": ["/C", "echo should-not-run"],
                "wait_ms": 100
            }),
        )],
    );
    assert_eq!(denied[0]["status"], "error");
    assert_eq!(denied[0]["error"]["code"], "permission_denied");

    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn checkpoint_rejects_private_reasoning_fields() {
    let root = unique_root();
    let state_dir = root.join("state");
    let creator = write_profile(
        &root,
        "model:deepseek-engineer",
        &[
            "job.create",
            "job.acquire_lease",
            "job.checkpoint",
            "job.get",
        ],
    );
    let job_id = create_job(
        &creator,
        &state_dir,
        "00000000-0000-4000-8000-000000000111",
        &[],
    );

    let acquired = rpc(
        &creator,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-000000000112",
            "job.acquire_lease",
            json!({ "job_id": job_id, "ttl_ms": 5_000 }),
        )],
    );
    assert_eq!(acquired[0]["status"], "success");

    let rejected = rpc(
        &creator,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-000000000113",
            "job.checkpoint",
            json!({
                "job_id": job_id,
                "state": {
                    "step": "safe",
                    "nested": {
                        "chain_of_thought": "must never be persisted"
                    }
                }
            }),
        )],
    );
    assert_eq!(rejected[0]["status"], "error");
    assert_eq!(rejected[0]["error"]["code"], "invalid_arguments");

    let read_back = rpc(
        &creator,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-000000000114",
            "job.get",
            json!({ "job_id": job_id }),
        )],
    );
    assert!(read_back[0]["data"]["latest_checkpoint"].is_null());

    std::fs::remove_dir_all(&root).unwrap();
}


#[test]
fn job_list_returns_only_jobs_permitted_to_bound_principal() {
    let root = unique_root();
    let state_dir = root.join("state");
    let creator = write_profile(&root, "human:owner", &["job.create"]);
    let worker = write_profile(&root, "model:engineer", &["job.list"]);

    let shared_job = create_job(
        &creator,
        &state_dir,
        "00000000-0000-4000-8000-000000000121",
        &["model:engineer"],
    );
    let private_job = create_job(
        &creator,
        &state_dir,
        "00000000-0000-4000-8000-000000000122",
        &[],
    );

    let listed = rpc(
        &worker,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-000000000123",
            "job.list",
            json!({}),
        )],
    );

    assert_eq!(listed[0]["status"], "success");
    let jobs = listed[0]["data"]["jobs"].as_array().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["job_id"], shared_job);
    assert!(jobs.iter().all(|job| job["job_id"] != private_job));

    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn job_list_filters_terminal_and_leased_work_for_workers() {
    let root = unique_root();
    let state_dir = root.join("state");
    let creator = write_profile(
        &root,
        "human:owner",
        &["job.create", "job.acquire_lease", "job.checkpoint"],
    );
    let worker = write_profile(&root, "model:engineer", &["job.list"]);
    let completed = create_job(
        &creator,
        &state_dir,
        "00000000-0000-4000-8000-000000000131",
        &["model:engineer"],
    );
    let available = create_job(
        &creator,
        &state_dir,
        "00000000-0000-4000-8000-000000000132",
        &["model:engineer"],
    );

    let acquired = rpc(
        &creator,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-000000000133",
            "job.acquire_lease",
            json!({ "job_id": completed, "ttl_ms": 5_000 }),
        )],
    );
    assert_eq!(acquired[0]["status"], "success");
    let checkpointed = rpc(
        &creator,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-000000000134",
            "job.checkpoint",
            json!({
                "job_id": completed,
                "status": "completed",
                "state": { "step": "done" }
            }),
        )],
    );
    assert_eq!(checkpointed[0]["status"], "success");

    let listed = rpc(
        &worker,
        &state_dir,
        &[invocation(
            "00000000-0000-4000-8000-000000000135",
            "job.list",
            json!({ "status": "active", "unleased": true, "limit": 10 }),
        )],
    );
    assert_eq!(listed[0]["status"], "success");
    let jobs = listed[0]["data"]["jobs"].as_array().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["job_id"], available);

    std::fs::remove_dir_all(&root).unwrap();
}
