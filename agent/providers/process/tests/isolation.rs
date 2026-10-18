//! Isolation-boundary acceptance tests for `process.run`.
//!
//! Every case is observed through a real `CapabilityRouter` so the assertion
//! sees the actual result envelope the daemon would return. A restricted run
//! must either be denied before any launch attempt or pass through a trusted
//! broker-issued authority into the injected isolated launcher. A denial,
//! a failed isolation setup, or an unverified PTY request must never create
//! the marker file, proving no ambient host spawn occurred.

use std::path::Path;
use std::sync::Arc;

use serde_json::{Value, json};
use tether_core::{
    Actor, ActorKind, CapabilityRouter, ErrorCode, InvocationEnvelope, LocalPolicyBroker,
    LocalPolicyConfig, ResponseMode, TrustedOwnershipRegistry,
};
use tether_process_provider::test_support::{
    TEST_DEVICE_ID, TEST_PRINCIPAL_ID, TestIsolatedLauncher, fixture_authorizer,
};
use tether_process_provider::{DenyUnsupportedLauncher, ProcessProvider};

/// The privileged router used by the daemon: plain policy with no ambient
/// execution authority of its own. Denials below must come from the provider.
fn fixture_router(provider: ProcessProvider) -> CapabilityRouter {
    let mut router = CapabilityRouter::with_policy(Arc::new(LocalPolicyBroker::new(
        LocalPolicyConfig::new(vec![]),
    )));
    router
        .register(Arc::new(provider))
        .expect("process provider registers");
    router
}

/// Reads the fixture backend's host-execution attempt counter.
fn fake_host_spawn_count(launcher: &TestIsolatedLauncher) -> usize {
    launcher.host_spawn_count()
}

#[cfg(windows)]
fn marker_arguments(marker: &Path, pty: bool) -> Value {
    // Separate arguments keep the redirect target unquoted on the command
    // line: Rust's Windows argument quoting would escape inner quotes inside a
    // single `/C` script string and `cmd.exe` would then reject the redirect.
    json!({
        "program": "cmd.exe",
        "args": ["/C", "echo", "spawned", ">", marker.to_string_lossy()],
        "wait_ms": 2_000,
        "pty": pty,
    })
}

#[cfg(unix)]
fn marker_arguments(marker: &Path, pty: bool) -> Value {
    json!({
        "program": "/bin/sh",
        "args": ["-c", format!("printf spawned > '{}'", marker.display())],
        "wait_ms": 2_000,
        "pty": pty,
    })
}

fn invocation(arguments: Value) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: "00000000-0000-4000-8000-000000000021".parse().unwrap(),
        device_id: Some(TEST_DEVICE_ID.into()),
        principal_id: Some(TEST_PRINCIPAL_ID.into()),
        job_id: None,
        capability: "process.run".into(),
        arguments,
        actor: Actor {
            id: "isolation-test".into(),
            kind: ActorKind::AiClient,
        },
        session_id: None,
        response_mode: ResponseMode::Compact,
        idempotency_key: None,
        preconditions: vec![],
        expectations: vec![],
    }
}

#[tokio::test]
async fn restricted_process_requires_injected_authorized_launch() {
    let marker_dir = tempfile::tempdir().unwrap();
    let marker = marker_dir.path().join("marker.txt");

    // (a) Default provider: no trusted authorizer, no launcher. Must deny
    // before any launch attempt.
    let result = fixture_router(ProcessProvider::new())
        .execute(invocation(marker_arguments(&marker, false)))
        .await;
    assert_eq!(
        result.error.expect("default provider must deny").code,
        ErrorCode::CapabilityUnavailable
    );
    assert!(!marker.exists(), "denial must not create the marker");

    // (b) An isolated launcher alone cannot launch: without a trusted
    // authorizer the request must still deny and never reach the host.
    let launcher = Arc::new(TestIsolatedLauncher::new());
    let result = fixture_router(ProcessProvider::with_isolated_launcher(launcher.clone()))
        .execute(invocation(marker_arguments(&marker, false)))
        .await;
    assert_eq!(
        result
            .error
            .expect("launcher without authorizer must deny")
            .code,
        ErrorCode::CapabilityUnavailable
    );
    assert_eq!(fake_host_spawn_count(&launcher), 0);
    assert!(
        !marker.exists(),
        "unconstrained launch attempt must not reach the host"
    );

    // (c) Positive control: broker-issued authority through the same fixture
    // launcher launches exactly once, proving (a)/(b) are not vacuous and the
    // broker-to-provider-to-launcher authority flow works.
    let launcher = Arc::new(TestIsolatedLauncher::new());
    let result = fixture_router(ProcessProvider::with_authorizer(
        Arc::new(TrustedOwnershipRegistry::new()),
        fixture_authorizer(),
        launcher.clone(),
    ))
    .execute(invocation(marker_arguments(&marker, false)))
    .await;
    assert!(
        result.error.is_none(),
        "authorized run must succeed: {:?}",
        result.error
    );
    let data = result
        .data
        .as_ref()
        .expect("authorized run must return data");
    assert_eq!(data["exit_code"].as_i64(), Some(0));
    assert_eq!(fake_host_spawn_count(&launcher), 1);
    assert!(
        marker.exists(),
        "authorized launch must execute the marker script"
    );
}

#[tokio::test]
async fn unsupported_pty_returns_capability_unavailable_without_spawn() {
    let marker_dir = tempfile::tempdir().unwrap();
    let marker = marker_dir.path().join("marker.txt");
    let launcher = Arc::new(TestIsolatedLauncher::new().with_pty_unsupported());

    let result = fixture_router(ProcessProvider::with_authorizer(
        Arc::new(TrustedOwnershipRegistry::new()),
        fixture_authorizer(),
        launcher.clone(),
    ))
    .execute(invocation(marker_arguments(&marker, true)))
    .await;

    assert_eq!(
        result
            .error
            .expect("unverified PTY must be unavailable")
            .code,
        ErrorCode::CapabilityUnavailable
    );
    assert_eq!(fake_host_spawn_count(&launcher), 0);
    assert!(
        !marker.exists(),
        "unverified PTY must never fall back to a host spawn"
    );
}

#[tokio::test]
async fn bad_isolation_setup_never_calls_host_command() {
    let marker_dir = tempfile::tempdir().unwrap();
    let marker = marker_dir.path().join("marker.txt");

    // (a) The fixture backend fails its own isolation setup after
    // authorization but before any spawn.
    let launcher = Arc::new(TestIsolatedLauncher::new().with_setup_failure());
    let result = fixture_router(ProcessProvider::with_authorizer(
        Arc::new(TrustedOwnershipRegistry::new()),
        fixture_authorizer(),
        launcher.clone(),
    ))
    .execute(invocation(marker_arguments(&marker, false)))
    .await;
    assert_eq!(
        result.error.expect("failed isolation setup must deny").code,
        ErrorCode::CapabilityUnavailable
    );
    assert_eq!(fake_host_spawn_count(&launcher), 0);
    assert!(
        !marker.exists(),
        "failed isolation setup must never fall back to ambient launch"
    );

    // (b) The shipped production backend has no verified isolation
    // implementation: authorized requests still fail closed without executing.
    let result = fixture_router(ProcessProvider::with_authorizer(
        Arc::new(TrustedOwnershipRegistry::new()),
        fixture_authorizer(),
        Arc::new(DenyUnsupportedLauncher),
    ))
    .execute(invocation(marker_arguments(&marker, false)))
    .await;
    assert_eq!(
        result.error.expect("unsupported backend must deny").code,
        ErrorCode::CapabilityUnavailable
    );
    assert!(
        !marker.exists(),
        "deny-unsupported backend must never execute the command"
    );
}
