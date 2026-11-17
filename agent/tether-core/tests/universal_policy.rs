use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use tempfile::TempDir;
use tether_core::{
    Actor, ActorKind, CapabilityError, CapabilityProvider, CapabilityRouter, ErrorCode,
    InvocationEnvelope, LocalPolicyBroker, LocalPolicyConfig, PolicyBroker, PolicyDecision,
    PrincipalPermissionSet, PrincipalRole, ProviderResult, ResponseMode, ResultStatus,
    SynchronizedDevicePolicy, ToolFamily, VerificationStatus, tool_family_for_capability,
};
use uuid::Uuid;

fn invocation(
    principal_id: Option<&str>,
    device_id: Option<&str>,
    capability: &str,
    arguments: Value,
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
            id: "portal-test".into(),
            kind: ActorKind::AiClient,
        },
        session_id: None,
        response_mode: ResponseMode::Compact,
        idempotency_key: None,
        preconditions: vec![],
        expectations: vec![],
    }
}

struct EchoProvider {
    namespace: &'static str,
}

#[async_trait]
impl CapabilityProvider for EchoProvider {
    fn namespace(&self) -> &'static str {
        self.namespace
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        Ok(ProviderResult {
            data: json!({ "capability": invocation.capability }),
            delta: None,
            verification: VerificationStatus::Verified,
        })
    }
}

#[test]
fn canonical_capabilities_map_to_all_six_mcp_tool_families() {
    assert_eq!(
        tool_family_for_capability("device.status"),
        Some(ToolFamily::Device)
    );
    assert_eq!(
        tool_family_for_capability("job.create"),
        Some(ToolFamily::Device)
    );
    assert_eq!(
        tool_family_for_capability("audit.read"),
        Some(ToolFamily::Device)
    );
    assert_eq!(
        tool_family_for_capability("filesystem.read"),
        Some(ToolFamily::Files)
    );
    assert_eq!(
        tool_family_for_capability("search.start"),
        Some(ToolFamily::Files)
    );
    assert_eq!(
        tool_family_for_capability("process.run"),
        Some(ToolFamily::Process)
    );
    assert_eq!(
        tool_family_for_capability("browser.snapshot"),
        Some(ToolFamily::Browser)
    );
    assert_eq!(
        tool_family_for_capability("desktop.snapshot"),
        Some(ToolFamily::Desktop)
    );
    assert_eq!(
        tool_family_for_capability("batch.execute"),
        Some(ToolFamily::Batch)
    );
}

#[test]
fn universal_default_policy_grants_all_six_families_to_paired_owner() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("owner-note.txt");
    fs::write(&file, "hello").unwrap();

    let broker = LocalPolicyBroker::new(LocalPolicyConfig::new(vec![temp.path().to_path_buf()]));
    let policy =
        SynchronizedDevicePolicy::universal_for_owner("Leno", "account-owner", "human:owner");
    broker.set_synchronized_policy(Some(policy));

    for (capability, args) in [
        ("device.status", json!({})),
        ("device.capabilities", json!({})),
        ("job.create", json!({ "objective": "test" })),
        ("audit.read", json!({})),
        ("filesystem.read", json!({ "path": file })),
        (
            "filesystem.write",
            json!({ "path": file, "content": "updated" }),
        ),
        (
            "filesystem.patch",
            json!({ "path": file, "old": "hello", "new": "world" }),
        ),
        (
            "filesystem.move",
            json!({ "source": file, "destination": temp.path().join("moved.txt"), "replace": true }),
        ),
        (
            "search.start",
            json!({ "root": temp.path(), "scope": "filename", "query": "owner" }),
        ),
        ("process.run", json!({ "program": "echo" })),
        ("process.terminate", json!({ "handle": "proc:1" })),
        ("browser.status", json!({})),
        ("browser.snapshot", json!({})),
        ("desktop.snapshot", json!({})),
        (
            "desktop.act",
            json!({ "reference": "win:1", "action": "invoke" }),
        ),
        (
            "batch.execute",
            json!({
                "mode": "parallel",
                "operations": [{ "capability": "device.status", "arguments": {} }]
            }),
        ),
    ] {
        let decision = broker.evaluate(&invocation(
            Some("human:owner"),
            Some("Leno"),
            capability,
            args,
        ));
        assert_eq!(
            decision,
            PolicyDecision::Allow,
            "expected universal owner grant for {capability}"
        );
    }

    // Human-origin process termination remains denied even under universal owner policy
    let human_proc = broker.evaluate(&invocation(
        Some("human:owner"),
        Some("Leno"),
        "process.terminate",
        json!({ "origin": "human" }),
    ));
    assert!(matches!(human_proc, PolicyDecision::Deny { .. }));
}

#[tokio::test]
async fn unpaired_and_unauthenticated_identities_never_inherit_owner_permissions() {
    let temp = TempDir::new().unwrap();
    let broker = Arc::new(LocalPolicyBroker::new(LocalPolicyConfig::new(vec![
        temp.path().to_path_buf(),
    ])));
    broker.set_synchronized_policy(Some(SynchronizedDevicePolicy::universal_for_owner(
        "Leno",
        "account-owner",
        "human:owner",
    )));

    let mut router = CapabilityRouter::with_policy(Arc::clone(&broker) as Arc<dyn PolicyBroker>);
    router
        .register(Arc::new(EchoProvider {
            namespace: "device",
        }))
        .unwrap();

    for unauthorized_principal in [None, Some("human:stranger"), Some("operator:unpaired")] {
        let result = router
            .execute(invocation(
                unauthorized_principal,
                Some("Leno"),
                "device.status",
                json!({}),
            ))
            .await;

        assert_eq!(result.status, ResultStatus::Error);
        let error = result.error.expect("expected permission_denied error");
        assert_eq!(error.code, ErrorCode::PermissionDenied);
        assert_eq!(
            error.details["denial_kind"],
            json!("unpaired_or_unauthorized_identity")
        );
        assert!(error.recovery_hint.is_some());
    }
}

#[tokio::test]
async fn explicit_deny_rules_override_universal_owner_and_family_grants() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("protected.txt");
    fs::write(&file, "keep").unwrap();

    let broker = Arc::new(LocalPolicyBroker::new(LocalPolicyConfig::new(vec![
        temp.path().to_path_buf(),
    ])));
    let mut policy =
        SynchronizedDevicePolicy::universal_for_owner("Leno", "account-owner", "human:owner");
    policy.revision = 2;
    policy
        .owner_policy
        .denied_families
        .insert(ToolFamily::Process);
    policy
        .owner_policy
        .denied_capabilities
        .insert("filesystem.write".into());
    broker.set_synchronized_policy(Some(policy));

    let mut router = CapabilityRouter::with_policy(Arc::clone(&broker) as Arc<dyn PolicyBroker>);
    router
        .register(Arc::new(EchoProvider {
            namespace: "filesystem",
        }))
        .unwrap();
    router
        .register(Arc::new(EchoProvider {
            namespace: "process",
        }))
        .unwrap();

    // filesystem.read is still allowed
    let read_res = router
        .execute(invocation(
            Some("human:owner"),
            Some("Leno"),
            "filesystem.read",
            json!({ "path": file }),
        ))
        .await;
    assert_eq!(read_res.status, ResultStatus::Success);

    // filesystem.write is explicitly denied
    let write_res = router
        .execute(invocation(
            Some("human:owner"),
            Some("Leno"),
            "filesystem.write",
            json!({ "path": file, "content": "blocked" }),
        ))
        .await;
    assert_eq!(write_res.status, ResultStatus::Error);
    let write_err = write_res.error.unwrap();
    assert_eq!(write_err.code, ErrorCode::PermissionDenied);
    assert_eq!(write_err.details["denial_kind"], json!("explicit_deny"));
    assert_eq!(write_err.details["tool_family"], json!("files"));

    // process.run is denied because the process family is in denied_families
    let proc_res = router
        .execute(invocation(
            Some("human:owner"),
            Some("Leno"),
            "process.run",
            json!({ "program": "echo" }),
        ))
        .await;
    assert_eq!(proc_res.status, ResultStatus::Error);
    let proc_err = proc_res.error.unwrap();
    assert_eq!(proc_err.code, ErrorCode::PermissionDenied);
    assert_eq!(proc_err.details["denial_kind"], json!("explicit_deny"));
    assert_eq!(proc_err.details["tool_family"], json!("process"));
}

#[tokio::test]
async fn operator_identity_has_separate_scoped_permissions_from_owner() {
    let temp = TempDir::new().unwrap();
    let broker = Arc::new(LocalPolicyBroker::new(LocalPolicyConfig::new(vec![
        temp.path().to_path_buf(),
    ])));
    let mut policy =
        SynchronizedDevicePolicy::universal_for_owner("Leno", "account-owner", "human:owner");
    policy.revision = 3;
    let mut operator_map = BTreeMap::new();
    operator_map.insert(
        "operator:alice".to_owned(),
        PrincipalPermissionSet {
            principal_id: "operator:alice".to_owned(),
            role: PrincipalRole::Operator,
            profile_id: "custom".to_owned(),
            universal_permissions: false,
            allowed_families: BTreeSet::from([ToolFamily::Device]),
            denied_families: BTreeSet::new(),
            allowed_capabilities: BTreeSet::from(["filesystem.read".to_owned()]),
            denied_capabilities: BTreeSet::from(["filesystem.write".to_owned()]),
            allowed_roots: vec![],
            allow_destructive: false,
        },
    );
    policy.operator_policies = operator_map;
    broker.set_synchronized_policy(Some(policy));

    let mut router = CapabilityRouter::with_policy(Arc::clone(&broker) as Arc<dyn PolicyBroker>);
    router
        .register(Arc::new(EchoProvider {
            namespace: "device",
        }))
        .unwrap();
    router
        .register(Arc::new(EchoProvider {
            namespace: "process",
        }))
        .unwrap();

    // Operator can call device.status (via Device family grant)
    let dev_res = router
        .execute(invocation(
            Some("operator:alice"),
            Some("Leno"),
            "device.status",
            json!({}),
        ))
        .await;
    assert_eq!(dev_res.status, ResultStatus::Success);

    // Operator cannot call process.run (not granted)
    let proc_res = router
        .execute(invocation(
            Some("operator:alice"),
            Some("Leno"),
            "process.run",
            json!({ "program": "echo" }),
        ))
        .await;
    assert_eq!(proc_res.status, ResultStatus::Error);
    let proc_err = proc_res.error.unwrap();
    assert_eq!(
        proc_err.details["denial_kind"],
        json!("operation_not_granted")
    );

    // Owner still has universal access to process.run
    let owner_proc = router
        .execute(invocation(
            Some("human:owner"),
            Some("Leno"),
            "process.run",
            json!({ "program": "echo" }),
        ))
        .await;
    assert_eq!(owner_proc.status, ResultStatus::Success);
}

#[tokio::test]
async fn emergency_lockdown_blocks_all_principals_including_owner() {
    let temp = TempDir::new().unwrap();
    let broker = Arc::new(LocalPolicyBroker::new(LocalPolicyConfig::new(vec![
        temp.path().to_path_buf(),
    ])));
    let mut policy =
        SynchronizedDevicePolicy::universal_for_owner("Leno", "account-owner", "human:owner");
    policy.revision = 4;
    policy.emergency_lockdown = true;
    broker.set_synchronized_policy(Some(policy));

    let mut router = CapabilityRouter::with_policy(Arc::clone(&broker) as Arc<dyn PolicyBroker>);
    router
        .register(Arc::new(EchoProvider {
            namespace: "device",
        }))
        .unwrap();

    let res = router
        .execute(invocation(
            Some("human:owner"),
            Some("Leno"),
            "device.status",
            json!({}),
        ))
        .await;
    assert_eq!(res.status, ResultStatus::Error);
    let err = res.error.unwrap();
    assert_eq!(err.code, ErrorCode::PermissionDenied);
    assert_eq!(err.details["denial_kind"], json!("emergency_lockdown"));
}
