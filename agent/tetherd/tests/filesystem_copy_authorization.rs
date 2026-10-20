use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{Value, json};
use uuid::Uuid;

const CAPS_ID: &str = "00000000-0000-4000-8000-0000000000d1";
const COPY_ID: &str = "00000000-0000-4000-8000-0000000000d2";
const REPLACE_ID: &str = "00000000-0000-4000-8000-0000000000d3";
const OUTSIDE_SOURCE_ID: &str = "00000000-0000-4000-8000-0000000000d4";
const OUTSIDE_DEST_ID: &str = "00000000-0000-4000-8000-0000000000d5";

fn unique_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "tetherplane-copy-auth-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ))
}

fn invoke(id: &str, capability: &str, arguments: Value) -> Value {
    json!({
        "protocol_version": "1.0",
        "request_id": id,
        "device_id": "Leno",
        "capability": capability,
        "arguments": arguments,
        "actor": { "id": "copy-auth-test", "kind": "ai_client" },
        "session_id": null,
        "response_mode": "compact",
        "idempotency_key": null,
        "preconditions": [],
        "expectations": []
    })
}

fn profile(path: &Path, workspace: &Path, grant_copy: bool) {
    let mut capabilities = vec!["device.capabilities", "filesystem.read"];
    if grant_copy {
        capabilities.push("filesystem.copy");
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(&json!({
            "principal_id": "operator:copy-test",
            "authentication": "local_process_binding",
            "allowed_devices": ["Leno"],
            "allowed_capabilities": capabilities,
            "allowed_directories": [workspace]
        }))
        .unwrap(),
    )
    .unwrap();
}

fn run_agent(
    workspace: &Path,
    principal: Option<&Path>,
    requests: &[Value],
) -> BTreeMap<String, Value> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tetherd"));
    command.arg("--stdio-rpc").arg("--allow").arg(workspace);
    if let Some(principal) = principal {
        command.arg("--principal-profile").arg(principal);
    }
    let mut child = command
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
    let mut responses = BTreeMap::new();
    for line in BufReader::new(stdout).lines().take(requests.len()) {
        let response: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let id = response["request_id"].as_str().unwrap().to_owned();
        assert!(
            responses.insert(id, response).is_none(),
            "duplicate response ID"
        );
    }
    assert_eq!(responses.len(), requests.len());
    assert!(child.wait().unwrap().success());
    responses
}

fn advertises_copy(capabilities_result: &Value) -> bool {
    capabilities_result["data"]["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["namespace"] == "filesystem")
        .unwrap()["operations"]
        .as_array()
        .unwrap()
        .contains(&json!("copy"))
}

#[test]
fn filesystem_copy_is_denied_without_launch_bound_principal_or_grant() {
    let root = unique_root();
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let source = workspace.join("source.bin");
    let destination = workspace.join("destination.bin");
    fs::write(&source, [0_u8, 255_u8]).unwrap();

    let requests = [
        invoke(CAPS_ID, "device.capabilities", json!({})),
        invoke(
            COPY_ID,
            "filesystem.copy",
            json!({"source": source, "destination": destination}),
        ),
    ];

    // A historically unbound stdio-RPC context must not implicitly gain this
    // new mutating operation merely because --allow specifies a directory.
    let unbound = run_agent(&workspace, None, &requests);
    assert!(!advertises_copy(&unbound[CAPS_ID]));
    assert_eq!(unbound[COPY_ID]["status"], "error");
    assert_eq!(unbound[COPY_ID]["error"]["code"], "permission_denied");
    assert!(!destination.exists());

    let principal = root.join("principal.json");
    profile(&principal, &workspace, false);
    let restricted = run_agent(&workspace, Some(&principal), &requests);
    assert!(!advertises_copy(&restricted[CAPS_ID]));
    assert_eq!(restricted[COPY_ID]["error"]["code"], "permission_denied");
    assert!(!destination.exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn filesystem_copy_requires_grant_and_enforces_both_paths_in_real_agent() {
    let root = unique_root();
    let workspace = root.join("workspace");
    let outside = root.join("outside");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&outside).unwrap();

    let source = workspace.join("source.bin");
    let destination = workspace.join("destination.bin");
    let outside_source = outside.join("outside.bin");
    let outside_destination = outside.join("forbidden.bin");
    let bytes = [0_u8, 1, 127, 128, 255];
    fs::write(&source, bytes).unwrap();
    fs::write(&outside_source, bytes).unwrap();
    let principal = root.join("principal.json");
    profile(&principal, &workspace, true);

    let initial = run_agent(
        &workspace,
        Some(&principal),
        &[
            invoke(CAPS_ID, "device.capabilities", json!({})),
            invoke(
                COPY_ID,
                "filesystem.copy",
                json!({"source": source, "destination": destination}),
            ),
        ],
    );
    assert!(advertises_copy(&initial[CAPS_ID]));
    assert_eq!(initial[COPY_ID]["status"], "success");
    assert_eq!(initial[COPY_ID]["data"]["bytes"], 5);
    assert_eq!(fs::read(&source).unwrap(), bytes);
    assert_eq!(fs::read(&destination).unwrap(), bytes);

    // The following checks execute only after the initial copy completed.
    // This avoids nondeterministic races between independent RPC requests.
    let denied = run_agent(
        &workspace,
        Some(&principal),
        &[
            invoke(
                REPLACE_ID,
                "filesystem.copy",
                json!({"source": source, "destination": destination}),
            ),
            invoke(
                OUTSIDE_SOURCE_ID,
                "filesystem.copy",
                json!({"source": outside_source, "destination": workspace.join("leak.bin")}),
            ),
            invoke(
                OUTSIDE_DEST_ID,
                "filesystem.copy",
                json!({"source": source, "destination": outside_destination}),
            ),
        ],
    );
    assert_eq!(denied[REPLACE_ID]["status"], "error");
    assert_eq!(denied[REPLACE_ID]["error"]["code"], "precondition_failed");
    assert_eq!(
        denied[OUTSIDE_SOURCE_ID]["error"]["code"],
        "permission_denied"
    );
    assert_eq!(
        denied[OUTSIDE_DEST_ID]["error"]["code"],
        "permission_denied"
    );
    assert!(!workspace.join("leak.bin").exists());
    assert!(!outside_destination.exists());

    fs::remove_dir_all(root).unwrap();
}
