use serde_json::{Value, json};
use tether_core::{
    Actor, ActorKind, CapabilityProvider, ErrorCode, InvocationEnvelope, ResponseMode,
};
use tether_process_provider::ProcessProvider;

fn invocation_for(capability: &str, arguments: Value) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: "00000000-0000-4000-8000-000000000008".parse().unwrap(),
        device_id: Some("Leno".into()),
        principal_id: None,
        job_id: None,
        capability: capability.into(),
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

fn invocation(arguments: Value) -> InvocationEnvelope {
    invocation_for("process.run", arguments)
}

#[cfg(windows)]
fn shell_arguments(script: &str, wait_ms: u64) -> Value {
    json!({
        "program": "cmd.exe",
        "args": ["/C", script],
        "wait_ms": wait_ms,
        "pty": false,
    })
}

#[cfg(unix)]
fn shell_arguments(script: &str, wait_ms: u64) -> Value {
    json!({
        "program": "/bin/sh",
        "args": ["-c", script],
        "wait_ms": wait_ms,
        "pty": false,
    })
}

#[cfg(windows)]
const SHORT_SCRIPT: &str = "echo short";
#[cfg(unix)]
const SHORT_SCRIPT: &str = "printf 'short\\n'";

#[cfg(windows)]
const LONG_SCRIPT: &str = "echo one & ping -n 2 127.0.0.1 >NUL & echo two";
#[cfg(unix)]
const LONG_SCRIPT: &str = "printf 'one\\n'; sleep 1; printf 'two\\n'";

#[tokio::test]
async fn short_command_returns_complete_bounded_output_and_exit_code() {
    let provider = ProcessProvider::new();

    let result = provider
        .execute(&invocation(shell_arguments(SHORT_SCRIPT, 2_000)))
        .await
        .unwrap();

    assert_eq!(result.data["running"].as_bool(), Some(false));
    assert_eq!(result.data["exit_code"].as_i64(), Some(0));
    assert!(result.data["handle"].as_str().unwrap().starts_with("proc_"));
    assert!(result.data["stdout"].as_str().unwrap().contains("short"));
    assert!(result.data["stderr"].as_str().is_some());
}

#[tokio::test]
async fn long_command_returns_persistent_handle_after_initial_wait_budget() {
    let provider = ProcessProvider::new();

    let result = provider
        .execute(&invocation(shell_arguments(LONG_SCRIPT, 100)))
        .await
        .unwrap();

    assert_eq!(result.data["running"].as_bool(), Some(true));
    assert!(result.data["handle"].as_str().unwrap().starts_with("proc_"));
    let stdout = result.data["stdout"].as_str().unwrap();
    assert!(stdout.contains("one"));
    assert!(!stdout.contains("two"));
    assert!(result.data["exit_code"].is_null());
}

#[cfg(windows)]
const INCREMENTAL_SCRIPT: &str =
    "ping -n 2 127.0.0.1 >NUL & echo one & ping -n 2 127.0.0.1 >NUL & echo two";
#[cfg(unix)]
const INCREMENTAL_SCRIPT: &str = "sleep 1; printf 'one\\n'; sleep 1; printf 'two\\n'";

#[tokio::test]
async fn default_reads_return_only_output_not_previously_delivered() {
    let provider = ProcessProvider::new();
    let started = provider
        .execute(&invocation(shell_arguments(INCREMENTAL_SCRIPT, 0)))
        .await
        .unwrap();
    let handle = started.data["handle"].as_str().unwrap().to_owned();

    let first = provider
        .execute(&invocation_for(
            "process.read",
            json!({ "handle": handle, "timeout_ms": 1_500 }),
        ))
        .await
        .unwrap();
    assert!(first.data["stdout"].as_str().unwrap().contains("one"));
    assert!(!first.data["stdout"].as_str().unwrap().contains("two"));

    let second = provider
        .execute(&invocation_for(
            "process.read",
            json!({ "handle": handle, "timeout_ms": 2_000 }),
        ))
        .await
        .unwrap();
    assert!(!second.data["stdout"].as_str().unwrap().contains("one"));
    assert!(second.data["stdout"].as_str().unwrap().contains("two"));
}

#[cfg(windows)]
const READBACK_SCRIPT: &str = "echo alpha & echo beta";
#[cfg(unix)]
const READBACK_SCRIPT: &str = "printf 'alpha\\nbeta\\n'";

#[tokio::test]
async fn absolute_read_can_replay_buffered_output_without_changing_unseen_cursor() {
    let provider = ProcessProvider::new();
    let started = provider
        .execute(&invocation(shell_arguments(READBACK_SCRIPT, 2_000)))
        .await
        .unwrap();
    let handle = started.data["handle"].as_str().unwrap().to_owned();

    let replay = provider
        .execute(&invocation_for(
            "process.read",
            json!({ "handle": handle, "mode": "absolute", "offset": 0 }),
        ))
        .await
        .unwrap();

    let stdout = replay.data["stdout"].as_str().unwrap();
    assert!(stdout.contains("alpha"));
    assert!(stdout.contains("beta"));

    let unseen = provider
        .execute(&invocation_for("process.read", json!({ "handle": handle })))
        .await
        .unwrap();
    assert_eq!(unseen.data["stdout"].as_str(), Some(""));
}

#[tokio::test]
async fn tail_read_returns_only_requested_end_of_buffer() {
    let provider = ProcessProvider::new();
    let started = provider
        .execute(&invocation(shell_arguments(READBACK_SCRIPT, 2_000)))
        .await
        .unwrap();
    let handle = started.data["handle"].as_str().unwrap().to_owned();

    let tail = provider
        .execute(&invocation_for(
            "process.read",
            json!({ "handle": handle, "mode": "tail", "tail_bytes": 8 }),
        ))
        .await
        .unwrap();

    let stdout = tail.data["stdout"].as_str().unwrap();
    assert!(!stdout.contains("alpha"));
    assert!(stdout.contains("beta"));
}

#[cfg(windows)]
fn interactive_arguments(wait_ms: u64) -> Value {
    json!({
        "program": "cmd.exe",
        "args": ["/V:ON", "/C", "set /p line= & echo got:!line!"],
        "wait_ms": wait_ms,
        "pty": false,
    })
}

#[cfg(unix)]
fn interactive_arguments(wait_ms: u64) -> Value {
    json!({
        "program": "/bin/sh",
        "args": ["-c", "read line; printf 'got:%s\\n' \"$line\""],
        "wait_ms": wait_ms,
        "pty": false,
    })
}

#[tokio::test]
async fn process_input_writes_to_persistent_session_stdin() {
    let provider = ProcessProvider::new();
    let started = provider
        .execute(&invocation(interactive_arguments(0)))
        .await
        .unwrap();
    let handle = started.data["handle"].as_str().unwrap().to_owned();

    let input = provider
        .execute(&invocation_for(
            "process.input",
            json!({ "handle": handle, "data": "hello\n" }),
        ))
        .await
        .unwrap();
    assert_eq!(input.data["bytes_written"].as_u64(), Some(6));

    let read = provider
        .execute(&invocation_for(
            "process.read",
            json!({ "handle": handle, "timeout_ms": 2_000 }),
        ))
        .await
        .unwrap();
    let stdout = read.data["stdout"].as_str().unwrap();
    let stderr = read.data["stderr"].as_str().unwrap();
    assert!(
        stdout.contains("got:hello"),
        "stdout={stdout:?} stderr={stderr:?} running={:?}",
        read.data["running"]
    );
}

#[cfg(windows)]
fn pty_interactive_arguments() -> Value {
    json!({
        "program": "cmd.exe",
        "args": ["/Q", "/D"],
        "wait_ms": 100,
        "pty": true,
    })
}

#[cfg(windows)]
const PTY_INPUT: &str = "echo pty:hello\r\nexit\r\n";

#[cfg(unix)]
fn pty_interactive_arguments() -> Value {
    json!({
        "program": "/bin/sh",
        "args": [],
        "wait_ms": 100,
        "pty": true,
    })
}

#[cfg(unix)]
const PTY_INPUT: &str = "printf 'pty:hello\\n'\nexit\n";

#[tokio::test]
async fn requested_pty_session_supports_interactive_input() {
    let provider = ProcessProvider::new();
    let started = provider
        .execute(&invocation(pty_interactive_arguments()))
        .await
        .unwrap();
    assert_eq!(started.data["pty"].as_bool(), Some(true));
    let handle = started.data["handle"].as_str().unwrap().to_owned();

    provider
        .execute(&invocation_for(
            "process.input",
            json!({ "handle": handle, "data": PTY_INPUT }),
        ))
        .await
        .unwrap();

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut running = true;
    for _ in 0..8 {
        let read = provider
            .execute(&invocation_for(
                "process.read",
                json!({ "handle": handle, "timeout_ms": 500 }),
            ))
            .await
            .unwrap();
        stdout.push_str(read.data["stdout"].as_str().unwrap());
        stderr.push_str(read.data["stderr"].as_str().unwrap());
        running = read.data["running"].as_bool().unwrap();
        if stdout.contains("pty:hello") || !running {
            break;
        }
    }

    assert!(
        stdout.contains("pty:hello"),
        "stdout={stdout:?} stderr={stderr:?} running={running:?}"
    );
}

#[cfg(windows)]
fn pty_short_arguments() -> Value {
    json!({
        "program": "cmd.exe",
        "args": ["/C", "echo pty-ok"],
        "wait_ms": 2_000,
        "pty": true,
    })
}

#[cfg(unix)]
fn pty_short_arguments() -> Value {
    json!({
        "program": "/bin/sh",
        "args": ["-c", "printf 'pty-ok\\n'"],
        "wait_ms": 2_000,
        "pty": true,
    })
}

#[tokio::test]
async fn pty_short_command_completes_without_exposing_cursor_query() {
    let provider = ProcessProvider::new();
    let result = provider
        .execute(&invocation(pty_short_arguments()))
        .await
        .unwrap();

    assert_eq!(result.data["pty"].as_bool(), Some(true));
    assert_eq!(result.data["running"].as_bool(), Some(false));
    let stdout = result.data["stdout"].as_str().unwrap();
    assert!(stdout.contains("pty-ok"), "stdout was {stdout:?}");
    assert!(!stdout.contains("\u{1b}[6n"), "stdout was {stdout:?}");
}

#[cfg(windows)]
const TERMINATION_SCRIPT: &str = "ping -n 6 127.0.0.1 >NUL";
#[cfg(unix)]
const TERMINATION_SCRIPT: &str = "sleep 5";

#[tokio::test]
async fn list_sessions_marks_registered_processes_as_tetherplane_origin() {
    let provider = ProcessProvider::new();
    let started = provider
        .execute(&invocation(shell_arguments(TERMINATION_SCRIPT, 0)))
        .await
        .unwrap();
    let handle = started.data["handle"].as_str().unwrap().to_owned();

    let listed = provider
        .execute(&invocation_for("process.list_sessions", json!({})))
        .await
        .unwrap();
    let sessions = listed.data["sessions"].as_array().unwrap();
    let session = sessions
        .iter()
        .find(|session| session["handle"].as_str() == Some(handle.as_str()))
        .unwrap();

    assert_eq!(session["origin"].as_str(), Some("tetherplane"));
    assert_eq!(session["running"].as_bool(), Some(true));
}

#[tokio::test]
async fn list_system_marks_discovered_processes_as_human_or_external() {
    let provider = ProcessProvider::new();

    let listed = provider
        .execute(&invocation_for("process.list_system", json!({})))
        .await
        .unwrap();
    let processes = listed.data["processes"].as_array().unwrap();

    assert!(!processes.is_empty());
    assert!(
        processes
            .iter()
            .all(|process| { process["origin"].as_str() == Some("human_or_external") })
    );
}

#[tokio::test]
async fn terminate_rejects_unregistered_system_pid() {
    let provider = ProcessProvider::new();

    let error = provider
        .execute(&invocation_for(
            "process.terminate",
            json!({ "pid": std::process::id(), "force": true }),
        ))
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::PermissionDenied);
}

#[tokio::test]
async fn terminate_registered_session_force_fallback_records_terminal_reason() {
    let provider = ProcessProvider::new();
    let started = provider
        .execute(&invocation(shell_arguments(TERMINATION_SCRIPT, 0)))
        .await
        .unwrap();
    let handle = started.data["handle"].as_str().unwrap().to_owned();

    let terminated = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        provider.execute(&invocation_for(
            "process.terminate",
            json!({
                "handle": handle,
                "grace_ms": 50,
                "force": true,
            }),
        )),
    )
    .await
    .expect("force fallback must terminate the owned process tree promptly")
    .unwrap();

    assert_eq!(terminated.data["running"].as_bool(), Some(false));
    assert_eq!(
        terminated.data["terminal_reason"].as_str(),
        Some("forced_termination")
    );

    let read = provider
        .execute(&invocation_for("process.read", json!({ "handle": handle })))
        .await
        .unwrap();
    assert_eq!(
        read.data["terminal_reason"].as_str(),
        Some("forced_termination")
    );
}

#[tokio::test]
async fn terminate_pty_session_gracefully_without_force() {
    let provider = ProcessProvider::new();
    let started = provider
        .execute(&invocation(pty_interactive_arguments()))
        .await
        .unwrap();
    let handle = started.data["handle"].as_str().unwrap().to_owned();

    let terminated = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        provider.execute(&invocation_for(
            "process.terminate",
            json!({
                "handle": handle,
                "grace_ms": 2_000,
                "force": false,
            }),
        )),
    )
    .await
    .expect("graceful PTY termination must be bounded")
    .unwrap();

    assert_eq!(terminated.data["running"].as_bool(), Some(false));
    assert_eq!(
        terminated.data["terminal_reason"].as_str(),
        Some("graceful_termination")
    );
}
