use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use async_trait::async_trait;
use serde_json::json;
use tether_core::{
    Actor, ActorKind, CapabilityError, CapabilityProvider, CapabilityRouter, InvocationEnvelope,
    LocalPolicyBroker, LocalPolicyConfig, PolicyBroker, PolicyDecision, PrincipalAuthentication,
    PrincipalProfile, ProviderResult, ResponseMode, ResultStatus, VerificationStatus,
};
use uuid::Uuid;

fn invocation(
    principal_id: Option<&str>,
    actor_id: &str,
    device_id: Option<&str>,
    capability: &str,
    arguments: serde_json::Value,
) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: Uuid::new_v4(),
        device_id: device_id.map(str::to_owned),
        principal_id: principal_id.map(str::to_owned),
        job_id: None,
        capability: capability.into(),
        arguments,
        actor: Actor {
            id: actor_id.into(),
            kind: ActorKind::AiClient,
        },
        session_id: None,
        response_mode: ResponseMode::Compact,
        idempotency_key: None,
        preconditions: vec![],
        expectations: vec![],
    }
}

fn profile(principal_id: &str, capabilities: &[&str], roots: Vec<PathBuf>) -> PrincipalProfile {
    PrincipalProfile {
        principal_id: principal_id.into(),
        authentication: PrincipalAuthentication::LocalProcessBinding,
        allowed_devices: BTreeSet::from(["Leno".to_owned()]),
        allowed_capabilities: capabilities
            .iter()
            .map(|capability| (*capability).to_owned())
            .collect(),
        allowed_directories: roots,
    }
}

#[test]
fn principal_capability_authority_is_independent_of_controller_label() {
    let config = LocalPolicyConfig::new(vec![]).with_principal(profile(
        "model:deepseek-engineer",
        &["device.status"],
        vec![],
    ));
    let broker = LocalPolicyBroker::new(config);

    for actor_id in ["deepseek-client", "chatgpt-client"] {
        let request = invocation(
            Some("model:deepseek-engineer"),
            actor_id,
            Some("Leno"),
            "device.status",
            json!({}),
        );
        assert_eq!(broker.evaluate(&request), PolicyDecision::Allow);
    }
}

#[test]
fn same_controller_label_gets_different_authority_under_different_principals() {
    let allowed = LocalPolicyBroker::new(LocalPolicyConfig::new(vec![]).with_principal(profile(
        "model:operator",
        &["process.run"],
        vec![],
    )));
    let denied = LocalPolicyBroker::new(LocalPolicyConfig::new(vec![]).with_principal(profile(
        "model:observer",
        &["device.status"],
        vec![],
    )));
    let allowed_request = invocation(
        Some("model:operator"),
        "qwen-client",
        Some("Leno"),
        "process.run",
        json!({}),
    );
    let denied_request = invocation(
        Some("model:observer"),
        "qwen-client",
        Some("Leno"),
        "process.run",
        json!({}),
    );

    assert_eq!(allowed.evaluate(&allowed_request), PolicyDecision::Allow);
    assert!(matches!(
        denied.evaluate(&denied_request),
        PolicyDecision::Deny { .. }
    ));
}

#[test]
fn principal_device_scope_is_enforced() {
    let broker = LocalPolicyBroker::new(LocalPolicyConfig::new(vec![]).with_principal(profile(
        "model:deepseek-engineer",
        &["device.status"],
        vec![],
    )));
    let request = invocation(
        Some("model:deepseek-engineer"),
        "deepseek-client",
        Some("Vaulter"),
        "device.status",
        json!({}),
    );

    assert!(matches!(
        broker.evaluate(&request),
        PolicyDecision::Deny { .. }
    ));
}

#[test]
fn principal_filesystem_roots_narrow_global_allowed_directories() {
    let temp = tempfile::TempDir::new().unwrap();
    let principal_root = temp.path().join("principal");
    let sibling = temp.path().join("sibling");
    std::fs::create_dir_all(&principal_root).unwrap();
    std::fs::create_dir_all(&sibling).unwrap();
    let allowed_file = principal_root.join("allowed.txt");
    let denied_file = sibling.join("denied.txt");
    std::fs::write(&allowed_file, "ok").unwrap();
    std::fs::write(&denied_file, "no").unwrap();

    let broker = LocalPolicyBroker::new(
        LocalPolicyConfig::new(vec![temp.path().to_path_buf()]).with_principal(profile(
            "model:deepseek-engineer",
            &["filesystem.read"],
            vec![principal_root],
        )),
    );

    let allowed = invocation(
        Some("model:deepseek-engineer"),
        "deepseek-client",
        Some("Leno"),
        "filesystem.read",
        json!({ "path": allowed_file }),
    );
    let denied = invocation(
        Some("model:deepseek-engineer"),
        "deepseek-client",
        Some("Leno"),
        "filesystem.read",
        json!({ "path": denied_file }),
    );

    assert_eq!(broker.evaluate(&allowed), PolicyDecision::Allow);
    assert!(matches!(
        broker.evaluate(&denied),
        PolicyDecision::Deny { .. }
    ));
}

struct CountingProcessProvider {
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl CapabilityProvider for CountingProcessProvider {
    fn namespace(&self) -> &'static str {
        "process"
    }

    async fn execute(
        &self,
        _invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ProviderResult {
            data: json!({ "executed": true }),
            delta: None,
            verification: VerificationStatus::Verified,
        })
    }
}

#[tokio::test]
async fn denied_principal_capability_never_reaches_provider() {
    let calls = Arc::new(AtomicUsize::new(0));
    let policy = Arc::new(LocalPolicyBroker::new(
        LocalPolicyConfig::new(vec![]).with_principal(profile(
            "model:observer",
            &["device.status"],
            vec![],
        )),
    ));
    let mut router = CapabilityRouter::with_policy(policy);
    router
        .register(Arc::new(CountingProcessProvider {
            calls: Arc::clone(&calls),
        }))
        .unwrap();

    let result = router
        .execute(invocation(
            Some("model:observer"),
            "contrarian-client",
            Some("Leno"),
            "process.run",
            json!({}),
        ))
        .await;

    assert_eq!(result.status, ResultStatus::Error);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

fn synced(ceiling: &[&str]) -> tether_core::EffectivePolicy {
    tether_core::EffectivePolicy::new(profile("model:owner-managed", ceiling, vec![]))
}

fn desired(version: u64, capabilities: &[&str]) -> tether_core::DesiredPolicy {
    tether_core::DesiredPolicy {
        version,
        allowed_capabilities: capabilities.iter().map(ToString::to_string).collect(),
    }
}

#[test]
fn desired_narrows_within_ceiling_and_applies_monotonically() {
    let policy = synced(&["device.status", "browser.pages", "process.run"]);
    let ack = policy.apply_desired(&desired(1, &["device.status", "browser.pages"]));
    let ack = ack.expect("fresh version must produce an acknowledgment");
    assert!(matches!(ack.status, tether_core::AckStatus::Applied));
    assert_eq!(ack.version, 1);
    assert!(policy.check("browser.pages").is_none());
    assert!(policy.check("process.run").is_some());
    let (version, effective) = policy.snapshot();
    assert_eq!(version, 1);
    assert_eq!(
        effective,
        BTreeSet::from(["device.status".to_owned(), "browser.pages".to_owned()])
    );
}

#[test]
fn restore_within_ceiling_reapplies_previously_removed_grants() {
    let policy = synced(&["device.status", "browser.pages"]);
    policy
        .apply_desired(&desired(1, &["device.status"]))
        .expect("v1 applies");
    assert!(policy.check("browser.pages").is_some());
    let ack = policy
        .apply_desired(&desired(2, &["device.status", "browser.pages"]))
        .expect("v2 applies");
    assert!(matches!(ack.status, tether_core::AckStatus::Applied));
    assert!(policy.check("browser.pages").is_none());
}

#[test]
fn exceeding_desired_is_rejected_without_state_change() {
    let policy = synced(&["device.status"]);
    let ack = policy
        .apply_desired(&desired(1, &["device.status", "browser.pages"]))
        .expect("rejection must still acknowledge");
    assert!(matches!(ack.status, tether_core::AckStatus::Rejected));
    assert_eq!(ack.version, 1);
    assert!(ack.reason.as_deref().unwrap_or("").contains("ceiling"));
    // Effective still stands at the ceiling; version did not advance.
    let (version, effective) = policy.snapshot();
    assert_eq!(version, 0);
    assert_eq!(effective, BTreeSet::from(["device.status".to_owned()]));
    assert!(policy.check("device.status").is_none());
    assert!(policy.check("browser.pages").is_some());
}

#[test]
fn stale_version_is_ignored_without_acknowledgment() {
    let policy = synced(&["device.status", "browser.pages"]);
    policy
        .apply_desired(&desired(2, &["device.status"]))
        .expect("v2 applies");
    assert!(
        policy
            .apply_desired(&desired(1, &["device.status"]))
            .is_none()
    );
    assert!(
        policy
            .apply_desired(&desired(2, &["device.status"]))
            .is_none()
    );
    let (version, _) = policy.snapshot();
    assert_eq!(version, 2);
}

#[test]
fn sync_requires_a_launch_bound_ceiling() {
    let policy = tether_core::EffectivePolicy::without_ceiling();
    // Open agents stay open locally; the sync channel cannot author policy.
    assert!(policy.check("browser.pages").is_none());
    let ack = policy
        .apply_desired(&desired(1, &["browser.pages"]))
        .expect("refusal must still acknowledge");
    assert!(matches!(ack.status, tether_core::AckStatus::Rejected));
    assert!(
        ack.reason
            .as_deref()
            .unwrap_or("")
            .contains("principal profile")
    );
}

#[test]
fn acknowledgment_carries_version_and_standing_set() {
    let policy = synced(&["device.status", "browser.pages"]);
    let applied = policy
        .apply_desired(&desired(1, &["device.status"]))
        .expect("v1 applies");
    assert_eq!(applied.version, 1);
    assert_eq!(
        applied.applied_capabilities,
        BTreeSet::from(["device.status".to_owned()])
    );
    let rejected = policy
        .apply_desired(&desired(
            2,
            &["device.status", "process.run", "browser.pages"],
        ))
        .expect("rejection acknowledges");
    assert_eq!(rejected.version, 2);
    assert_eq!(
        rejected.applied_capabilities,
        BTreeSet::from(["device.status".to_owned()]),
        "rejection reports the standing set, not the refused one"
    );
}
