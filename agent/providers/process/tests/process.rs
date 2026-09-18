use serde_json::{Value, json};
use tether_core::{
    Actor, ActorKind, CapabilityProvider, InvocationEnvelope, ResponseMode,
};
use tether_process_provider::ProcessProvider;

fn invocation(arguments: Value) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: "00000000-0000-4000-8000-000000000008"
            .parse()
            .unwrap(),
        device_id: Some("Leno".into()),
        capability: "process.run".into(),
        arguments,
        actor: Actor {
            id: "process-test".into(),
            kind: ActorKind::AiClient,
        },
        session_id: None,
        response_mode: ResponseMode::Compact,
        idempotency_key: None,
        preconditions: vec![],
        expectations: vec![],
    }
}

#[cfg(unix)]
fn short_command() -> (&'static str, Vec<&'static str>) {
    ("/bin/sh", vec!["-c", "printf 'short-output\\n'"])
}

#[cfg(windows)]
fn short_command() -> (&'static str, Vec<&'static str>) {
    ("cmd.exe", vec!["/C", "echo short-output"])
}

#[cfg(unix)]
fn long_command() -> (&'static str, Vec<&'static str>) {
    (
        "/bin/sh",
        vec!["-c", "printf 'started\\n'; sleep 1; printf 'finished\\n'"],
    )
}

#[cfg(windows)]
fn long_command() -> (&'static str, Vec<&'static str>) {
    (
        "cmd.exe",
        vec![
            "/C",
            "echo started & ping -n 3 127.0.0.1 >nul & echo finished",
        ],
    )
}

#[tokio::test]
async fn short_command_returns_complete_bounded_output_and_exit_code() {
    let provider = ProcessProvider::new();
    let (program, args) = short_command();

    let result = provider
        .execute(&invocation(json!({
            "program": program,
            "args": args,
            "initial_wait_ms": 2_000,
        })))
        .await
        .unwrap();

    assert_eq!(result.data["running"].as_bool(), Some(false));
    assert_eq!(result.data["exit_code"].as_i64(), Some(0));
    assert!(
        result.data["stdout"]
            .as_str()
            .is_some_and(|output| output.contains("short-output"))
    );
    assert!(result.data["stderr"].as_str().is_some());
}

#[tokio::test]
async fn long_command_returns_handle_and_initial_output_while_running() {
    let provider = ProcessProvider::new();
    let (program, args) = long_command();

    let result = provider
        .execute(&invocation(json!({
            "program": program,
            "args": args,
            "initial_wait_ms": 100,
        })))
        .await
        .unwrap();

    let handle = result.data["handle"].as_str().unwrap();
    assert!(handle.starts_with("proc_"));
    assert_eq!(result.data["running"].as_bool(), Some(true));
    assert!(result.data["exit_code"].is_null());
    assert!(
        result.data["stdout"]
            .as_str()
            .is_some_and(|output| output.contains("started"))
    );
}
