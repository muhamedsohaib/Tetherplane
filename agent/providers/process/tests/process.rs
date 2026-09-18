use serde_json::{Value, json};
use tether_core::{Actor, ActorKind, CapabilityProvider, InvocationEnvelope, ResponseMode};
use tether_process_provider::ProcessProvider;

fn invocation(capability: &str, arguments: Value) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: "00000000-0000-4000-8000-000000000008".parse().unwrap(),
        device_id: Some("Leno".into()),
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

#[cfg(unix)]
fn incremental_command() -> (&'static str, Vec<&'static str>) {
    (
        "/bin/sh",
        vec!["-c", "printf 'one\\n'; sleep 1; printf 'two\\n'; sleep 1"],
    )
}

#[cfg(windows)]
fn incremental_command() -> (&'static str, Vec<&'static str>) {
    (
        "cmd.exe",
        vec![
            "/C",
            "echo one & ping -n 2 127.0.0.1 >nul & echo two & ping -n 2 127.0.0.1 >nul",
        ],
    )
}

#[cfg(unix)]
fn completed_output_command() -> (&'static str, Vec<&'static str>) {
    (
        "/bin/sh",
        vec!["-c", "printf 'alpha\\nbeta\\ngamma\\n'"],
    )
}

#[cfg(windows)]
fn completed_output_command() -> (&'static str, Vec<&'static str>) {
    ("cmd.exe", vec!["/C", "echo alpha & echo beta & echo gamma"])
}

#[cfg(unix)]
fn large_output_command() -> (&'static str, Vec<&'static str>) {
    (
        "/bin/sh",
        vec![
            "-c",
            "i=0; while [ $i -lt 2500 ]; do printf '0123456789\\n'; i=$((i+1)); done",
        ],
    )
}

#[cfg(windows)]
fn large_output_command() -> (&'static str, Vec<&'static str>) {
    (
        "cmd.exe",
        vec![
            "/C",
            "for /L %i in (1,1,2500) do @echo 0123456789",
        ],
    )
}

#[tokio::test]
async fn short_command_returns_complete_bounded_output_and_exit_code() {
    let provider = ProcessProvider::new();
    let (program, args) = short_command();

    let result = provider
        .execute(&invocation(
            "process.run",
            json!({
                "program": program,
                "args": args,
                "initial_wait_ms": 2_000,
            }),
        ))
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
        .execute(&invocation(
            "process.run",
            json!({
                "program": program,
                "args": args,
                "initial_wait_ms": 100,
            }),
        ))
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

#[tokio::test]
async fn incremental_reads_return_only_output_newer_than_the_session_cursor() {
    let provider = ProcessProvider::new();
    let (program, args) = incremental_command();

    let started = provider
        .execute(&invocation(
            "process.run",
            json!({
                "program": program,
                "args": args,
                "initial_wait_ms": 0,
            }),
        ))
        .await
        .unwrap();
    let handle = started.data["handle"].as_str().unwrap().to_owned();

    let first = provider
        .execute(&invocation(
            "process.read",
            json!({
                "handle": handle,
                "wait_ms": 500,
            }),
        ))
        .await
        .unwrap();

    assert!(
        first.data["stdout"]
            .as_str()
            .is_some_and(|output| output.contains("one"))
    );
    assert!(
        first.data["stdout"]
            .as_str()
            .is_some_and(|output| !output.contains("two"))
    );

    let second = provider
        .execute(&invocation(
            "process.read",
            json!({
                "handle": handle,
                "wait_ms": 1_500,
            }),
        ))
        .await
        .unwrap();

    assert!(
        second.data["stdout"]
            .as_str()
            .is_some_and(|output| output.contains("two"))
    );
    assert!(
        second.data["stdout"]
            .as_str()
            .is_some_and(|output| !output.contains("one"))
    );
    assert!(
        first.data["stdout_cursor"].as_u64().unwrap()
            < second.data["stdout_cursor"].as_u64().unwrap()
    );
}

#[tokio::test]
async fn absolute_and_tail_reads_do_not_advance_the_default_cursor() {
    let provider = ProcessProvider::new();
    let (program, args) = completed_output_command();

    let started = provider
        .execute(&invocation(
            "process.run",
            json!({
                "program": program,
                "args": args,
                "initial_wait_ms": 2_000,
            }),
        ))
        .await
        .unwrap();
    let handle = started.data["handle"].as_str().unwrap().to_owned();
    let full = started.data["stdout"].as_str().unwrap();
    let beta_offset = i64::try_from(full.find("beta").unwrap()).unwrap();
    let gamma_offset = full.find("gamma").unwrap();
    let tail_bytes = i64::try_from(full.len() - gamma_offset).unwrap();

    let absolute = provider
        .execute(&invocation(
            "process.read",
            json!({
                "handle": handle,
                "offset": beta_offset,
            }),
        ))
        .await
        .unwrap();
    let absolute_stdout = absolute.data["stdout"].as_str().unwrap();
    assert!(!absolute_stdout.contains("alpha"));
    assert!(absolute_stdout.contains("beta"));
    assert!(absolute_stdout.contains("gamma"));

    let tail = provider
        .execute(&invocation(
            "process.read",
            json!({
                "handle": handle,
                "offset": -tail_bytes,
            }),
        ))
        .await
        .unwrap();
    let tail_stdout = tail.data["stdout"].as_str().unwrap();
    assert!(!tail_stdout.contains("alpha"));
    assert!(!tail_stdout.contains("beta"));
    assert!(tail_stdout.contains("gamma"));

    let incremental = provider
        .execute(&invocation(
            "process.read",
            json!({ "handle": handle }),
        ))
        .await
        .unwrap();
    let incremental_stdout = incremental.data["stdout"].as_str().unwrap();
    assert!(incremental_stdout.contains("alpha"));
    assert!(incremental_stdout.contains("beta"));
    assert!(incremental_stdout.contains("gamma"));
}

#[tokio::test]
async fn compact_absolute_read_returns_an_absolute_continuation_cursor() {
    let provider = ProcessProvider::new();
    let (program, args) = large_output_command();

    let started = provider
        .execute(&invocation(
            "process.run",
            json!({
                "program": program,
                "args": args,
                "initial_wait_ms": 5_000,
            }),
        ))
        .await
        .unwrap();
    let handle = started.data["handle"].as_str().unwrap().to_owned();

    let first = provider
        .execute(&invocation(
            "process.read",
            json!({
                "handle": handle,
                "offset": 0,
            }),
        ))
        .await
        .unwrap();
    let first_stdout = first.data["stdout"].as_str().unwrap();
    assert!(first_stdout.len() <= 16 * 1024);
    let continuation = first.data["stdout_continuation"].as_u64().unwrap();
    assert!(continuation > 0);

    let second = provider
        .execute(&invocation(
            "process.read",
            json!({
                "handle": handle,
                "offset": continuation,
            }),
        ))
        .await
        .unwrap();
    assert!(!second.data["stdout"].as_str().unwrap().is_empty());
    assert!(
        second.data["stdout_start_cursor"].as_u64().unwrap() >= continuation
    );
}
