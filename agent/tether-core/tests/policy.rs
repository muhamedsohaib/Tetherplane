use std::fs;
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use async_trait::async_trait;
use serde_json::{Value, json};
use tempfile::TempDir;
use tether_core::{
    Actor, ActorKind, CapabilityError, CapabilityProvider, CapabilityRouter, ErrorCode,
    InvocationEnvelope, LocalPolicyBroker, LocalPolicyConfig, PolicyBroker, PolicyDecision,
    ProviderResult, ResponseMode, ResultStatus, SideEffectClass, VerificationStatus,
    authorize_path,
};
use uuid::Uuid;

fn invocation(capability: &str, arguments: Value) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: Uuid::new_v4(),
        device_id: None,
        capability: capability.into(),
        arguments,
        actor: Actor {
            id: "policy-test".into(),
            kind: ActorKind::AiClient,
        },
        session_id: None,
        response_mode: ResponseMode::Compact,
        idempotency_key: None,
        preconditions: vec![],
        expectations: vec![],
    }
}
fn broker_for(root: &Path) -> LocalPolicyBroker {
    LocalPolicyBroker::new(LocalPolicyConfig::new(vec![root.to_path_buf()]))
}

#[test]
fn filesystem_read_inside_allowed_directory_is_allowed() {
    let temp = TempDir::new().unwrap();
    let allowed = temp.path().join("allowed");
    fs::create_dir(&allowed).unwrap();
    let file = allowed.join("inside.txt");
    fs::write(&file, "inside").unwrap();
    let broker = broker_for(&allowed);

    let decision = broker.evaluate(&invocation("filesystem.read", json!({ "path": file })));

    assert!(matches!(decision, PolicyDecision::Allow));
}

#[test]
fn filesystem_read_outside_allowed_directory_is_denied() {
    let temp = TempDir::new().unwrap();
    let allowed = temp.path().join("allowed");
    fs::create_dir(&allowed).unwrap();
    let outside = temp.path().join("outside.txt");
    fs::write(&outside, "outside").unwrap();
    let broker = broker_for(&allowed);

    let decision = broker.evaluate(&invocation("filesystem.read", json!({ "path": outside })));

    assert!(matches!(decision, PolicyDecision::Deny { .. }));
}
#[test]
fn filesystem_delete_requires_approval() {
    let temp = TempDir::new().unwrap();
    let allowed = temp.path().join("allowed");
    fs::create_dir(&allowed).unwrap();
    let file = allowed.join("delete-me.txt");
    fs::write(&file, "data").unwrap();
    let broker = broker_for(&allowed);

    let decision = broker.evaluate(&invocation("filesystem.delete", json!({ "path": file })));

    assert!(matches!(decision, PolicyDecision::RequireApproval { .. }));
}

#[test]
fn process_terminate_human_origin_is_denied() {
    let temp = TempDir::new().unwrap();
    let broker = broker_for(temp.path());

    let decision = broker.evaluate(&invocation(
        "process.terminate",
        json!({ "origin": "human" }),
    ));

    assert!(matches!(decision, PolicyDecision::Deny { .. }));
}

#[test]
fn foreground_disruptive_is_deferred_to_foreground_lease_stage() {
    let temp = TempDir::new().unwrap();
    let broker = broker_for(temp.path());

    assert_eq!(
        broker.side_effect_class("desktop.physical_click"),
        SideEffectClass::ForegroundDisruptive
    );
    assert!(matches!(
        broker.evaluate(&invocation("desktop.physical_click", json!({}))),
        PolicyDecision::Allow
    ));
}
struct CountingProvider {
    calls: AtomicUsize,
}

#[async_trait]
impl CapabilityProvider for CountingProvider {
    fn namespace(&self) -> &'static str {
        "filesystem"
    }

    async fn execute(
        &self,
        _invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ProviderResult {
            data: json!({}),
            delta: None,
            verification: VerificationStatus::Verified,
        })
    }
}

#[tokio::test]
async fn denied_invocation_never_reaches_provider() {
    let temp = TempDir::new().unwrap();
    let allowed = temp.path().join("allowed");
    fs::create_dir(&allowed).unwrap();
    let outside = temp.path().join("outside.txt");
    fs::write(&outside, "outside").unwrap();
    let provider = Arc::new(CountingProvider {
        calls: AtomicUsize::new(0),
    });
    let mut router = CapabilityRouter::with_policy(Arc::new(broker_for(&allowed)));
    router.register(provider.clone()).unwrap();

    let result = router
        .execute(invocation("filesystem.read", json!({ "path": outside })))
        .await;

    assert_eq!(result.status, ResultStatus::Error);
    assert_eq!(result.error.unwrap().code, ErrorCode::PermissionDenied);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn policy_does_not_fabricate_browser_availability() {
    let temp = TempDir::new().unwrap();
    let router = CapabilityRouter::with_policy(Arc::new(broker_for(temp.path())));

    let result = router
        .execute(invocation("browser.observe", json!({})))
        .await;

    assert_eq!(result.status, ResultStatus::Error);
    assert_eq!(result.error.unwrap().code, ErrorCode::CapabilityUnavailable);
}

#[test]
fn parent_traversal_cannot_escape_allowed_root() {
    let temp = TempDir::new().unwrap();
    let allowed = temp.path().join("allowed");
    fs::create_dir(&allowed).unwrap();
    let secret = temp.path().join("secret.txt");
    fs::write(&secret, "secret").unwrap();
    let escaped = allowed.join("..").join("secret.txt");

    let error = authorize_path(&escaped, &[allowed]).unwrap_err();

    assert_eq!(error.code, ErrorCode::PermissionDenied);
}

#[test]
fn nonexistent_child_under_allowed_parent_is_authorized() {
    let temp = TempDir::new().unwrap();
    let allowed = temp.path().join("allowed");
    fs::create_dir(&allowed).unwrap();
    let candidate = allowed.join("new-dir").join("new-file.txt");

    let resolved = authorize_path(&candidate, std::slice::from_ref(&allowed)).unwrap();

    assert!(resolved.starts_with(fs::canonicalize(allowed).unwrap()));
}
#[cfg(unix)]
fn create_dir_link(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[cfg(windows)]
fn create_dir_link(target: &Path, link: &Path) {
    if std::os::windows::fs::symlink_dir(target, link).is_ok() {
        return;
    }
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn link_to_outside_cannot_escape_allowed_root() {
    let temp = TempDir::new().unwrap();
    let allowed = temp.path().join("allowed");
    let outside = temp.path().join("outside");
    fs::create_dir(&allowed).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "secret").unwrap();
    let link = allowed.join("escape");
    create_dir_link(&outside, &link);

    let error = authorize_path(&link.join("secret.txt"), &[allowed]).unwrap_err();

    assert_eq!(error.code, ErrorCode::PermissionDenied);
}
#[cfg(windows)]
#[test]
fn mixed_windows_path_separators_remain_in_scope() {
    let temp = TempDir::new().unwrap();
    let allowed = temp.path().join("allowed");
    let nested = allowed.join("nested");
    fs::create_dir_all(&nested).unwrap();
    let file = nested.join("inside.txt");
    fs::write(&file, "inside").unwrap();
    let mixed = format!(
        "{}\\nested/inside.txt",
        allowed.to_string_lossy().trim_end_matches(['\\', '/'])
    );

    let resolved = authorize_path(Path::new(&mixed), std::slice::from_ref(&allowed)).unwrap();

    assert_eq!(resolved, fs::canonicalize(file).unwrap());
}

#[test]
fn filesystem_read_many_denies_when_any_path_is_outside_allowed_root() {
    let temp = TempDir::new().unwrap();
    let allowed = temp.path().join("allowed");
    fs::create_dir(&allowed).unwrap();
    let inside = allowed.join("inside.txt");
    fs::write(&inside, "inside").unwrap();
    let outside = temp.path().join("outside.txt");
    fs::write(&outside, "outside").unwrap();
    let broker = broker_for(&allowed);

    let decision = broker.evaluate(&invocation(
        "filesystem.read_many",
        json!({ "paths": [inside, outside] }),
    ));

    assert!(matches!(decision, PolicyDecision::Deny { .. }));
}

#[test]
fn filesystem_move_denies_source_or_destination_outside_allowed_root() {
    let temp = TempDir::new().unwrap();
    let allowed = temp.path().join("allowed");
    fs::create_dir(&allowed).unwrap();
    let inside = allowed.join("inside.txt");
    fs::write(&inside, "inside").unwrap();
    let outside = temp.path().join("outside.txt");
    fs::write(&outside, "outside").unwrap();
    let broker = broker_for(&allowed);

    let outside_source = broker.evaluate(&invocation(
        "filesystem.move",
        json!({ "source": outside, "destination": allowed.join("moved.txt") }),
    ));
    assert!(matches!(outside_source, PolicyDecision::Deny { .. }));

    let outside = temp.path().join("outside-destination.txt");
    let outside_destination = broker.evaluate(&invocation(
        "filesystem.move",
        json!({ "source": inside, "destination": outside }),
    ));
    assert!(matches!(outside_destination, PolicyDecision::Deny { .. }));
}

#[test]
fn filesystem_move_replace_requires_approval() {
    let temp = TempDir::new().unwrap();
    let allowed = temp.path().join("allowed");
    fs::create_dir(&allowed).unwrap();
    let source = allowed.join("source.txt");
    let destination = allowed.join("destination.txt");
    fs::write(&source, "source").unwrap();
    fs::write(&destination, "destination").unwrap();
    let broker = broker_for(&allowed);

    let decision = broker.evaluate(&invocation(
        "filesystem.move",
        json!({ "source": source, "destination": destination, "replace": true }),
    ));

    assert!(matches!(decision, PolicyDecision::RequireApproval { .. }));
}
