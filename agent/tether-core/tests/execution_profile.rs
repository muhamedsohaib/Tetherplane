use std::collections::BTreeSet;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use async_trait::async_trait;
use serde_json::json;
use tether_core::{
    Actor, ActorKind, CapabilityError, CapabilityProvider, CapabilityRouter, ErrorCode,
    ExecutionBinding, ExecutionEffect, ExecutionProfile, ExecutionResourceCeiling,
    InvocationEnvelope, LocalPolicyBroker, LocalPolicyConfig, PolicyBroker, PolicyDecision,
    PrincipalAuthentication, PrincipalProfile, ProfileResource, ProviderResult, ResourceAccess,
    ResponseMode, ResultStatus,
};
use uuid::Uuid;

fn profile() -> ExecutionProfile {
    ExecutionProfile {
        profile_id: "restricted-workspace".into(),
        revision: 3,
        organization_id: "org-alpha".into(),
        principal_id: "principal-engineer".into(),
        device_id: "Leno".into(),
        enrollment_generation: 7,
        workspace: ProfileResource {
            resource_id: "workspace-input-v1".into(),
            access: BTreeSet::from([ResourceAccess::Read]),
            private: false,
        },
        scratch: ProfileResource {
            resource_id: "private-scratch-v1".into(),
            access: BTreeSet::from([
                ResourceAccess::Read,
                ResourceAccess::Write,
                ResourceAccess::Create,
            ]),
            private: true,
        },
        allowed_effects: BTreeSet::from([
            ExecutionEffect::ReadWorkspace,
            ExecutionEffect::WriteScratch,
        ]),
    }
}

fn config(grants: Vec<ExecutionProfile>) -> LocalPolicyConfig {
    let granted = profile();
    LocalPolicyConfig::new(vec![])
        .with_principal(PrincipalProfile {
            principal_id: "principal-engineer".into(),
            authentication: PrincipalAuthentication::LocalProcessBinding,
            allowed_devices: BTreeSet::from(["Leno".into()]),
            allowed_capabilities: BTreeSet::from(["process.run".into()]),
            allowed_directories: vec![],
        })
        .with_execution_authority(
            ExecutionBinding {
                organization_id: "org-alpha".into(),
                principal_id: "principal-engineer".into(),
                device_id: "Leno".into(),
                enrollment_generation: 7,
            },
            grants,
            ExecutionResourceCeiling {
                workspace: granted.workspace,
                scratch: granted.scratch,
                allowed_effects: granted.allowed_effects,
            },
        )
}

fn request() -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: Uuid::new_v4(),
        device_id: Some("Leno".into()),
        principal_id: Some("principal-engineer".into()),
        job_id: None,
        capability: "process.run".into(),
        arguments: json!({"command": "a-program"}),
        actor: Actor {
            id: "any-model".into(),
            kind: ActorKind::AiClient,
        },
        session_id: None,
        response_mode: ResponseMode::Compact,
        idempotency_key: None,
        preconditions: vec![],
        expectations: vec![],
    }
}

#[test]
fn complete_profile_matches_org_principal_device_and_revision() {
    let broker = LocalPolicyBroker::new(config(vec![profile()]));
    let invocation = request();
    let authorized = broker.authorize_launch(&invocation, &profile()).unwrap();
    assert_eq!(authorized.profile().profile_id, "restricted-workspace");
    assert_eq!(authorized.profile().revision, 3);
    assert_eq!(authorized.request_id(), invocation.request_id);

    // Each alteration is denied by at least one exact-identity, shape, or
    // complete-grant check; sibling checks may mask an individual removal.
    let alterations: &[fn(&mut ExecutionProfile)] = &[
        |p| p.organization_id = "org-beta".into(),
        |p| p.principal_id = "principal-other".into(),
        |p| p.device_id = "fixture-other-device".into(),
        |p| p.enrollment_generation = 8,
        |p| p.profile_id = "different-profile".into(),
        |p| p.revision = 4,
        |p| p.workspace.resource_id = "other-workspace".into(),
        |p| p.scratch.resource_id = "other-scratch".into(),
        |p| {
            p.allowed_effects.remove(&ExecutionEffect::WriteScratch);
        },
        |p| {
            p.scratch.access.insert(ResourceAccess::Delete);
        },
    ];
    for (index, alter) in alterations.iter().enumerate() {
        let mut changed = profile();
        alter(&mut changed);
        assert!(
            broker.authorize_launch(&invocation, &changed).is_err(),
            "alteration {index}"
        );
    }
}

#[test]
fn missing_or_mismatched_invocation_identity_and_capability_deny() {
    let broker = LocalPolicyBroker::new(config(vec![profile()]));
    let alterations: &[fn(&mut InvocationEnvelope)] = &[
        |r| r.principal_id = None,
        |r| r.principal_id = Some("other-principal".into()),
        |r| r.device_id = None,
        |r| r.device_id = Some("fixture-other-device".into()),
        |r| r.capability = "filesystem.read".into(),
    ];
    for alter in alterations {
        let mut invocation = request();
        alter(&mut invocation);
        assert!(broker.authorize_launch(&invocation, &profile()).is_err());
    }
}

#[test]
fn trusted_binding_is_required_and_must_match_even_a_complete_grant() {
    let mut configurations = vec![LocalPolicyConfig::new(vec![])];
    let mutations: &[fn(&mut LocalPolicyConfig)] = &[
        |c| c.execution_binding = None,
        |c| c.execution_binding.as_mut().unwrap().organization_id = "org-beta".into(),
        |c| c.execution_binding.as_mut().unwrap().principal_id = "other-principal".into(),
        |c| c.execution_binding.as_mut().unwrap().device_id = "fixture-other-device".into(),
        |c| c.execution_binding.as_mut().unwrap().enrollment_generation = 8,
        |c| c.principal = None,
        |c| c.principal.as_mut().unwrap().allowed_capabilities.clear(),
        |c| c.principal.as_mut().unwrap().allowed_devices.clear(),
        |c| {
            c.operation_classes.insert(
                "process.run".into(),
                tether_core::SideEffectClass::PrivilegedSystem,
            );
        },
    ];
    for mutate in mutations {
        let mut trusted = config(vec![profile()]);
        mutate(&mut trusted);
        configurations.push(trusted);
    }
    for trusted in configurations {
        assert!(
            LocalPolicyBroker::new(trusted)
                .authorize_launch(&request(), &profile())
                .is_err()
        );
    }
}

#[test]
fn local_resource_and_effect_ceiling_remains_an_independent_intersection() {
    let mutations: &[fn(&mut LocalPolicyConfig)] = &[
        |c| c.execution_ceiling = None,
        |c| c.execution_ceiling.as_mut().unwrap().workspace.resource_id = "other".into(),
        |c| c.execution_ceiling.as_mut().unwrap().scratch.resource_id = "other".into(),
        |c| {
            c.execution_ceiling
                .as_mut()
                .unwrap()
                .workspace
                .access
                .clear();
        },
        |c| {
            c.execution_ceiling
                .as_mut()
                .unwrap()
                .scratch
                .access
                .remove(&ResourceAccess::Create);
        },
        |c| c.execution_ceiling.as_mut().unwrap().scratch.private = false,
        |c| {
            c.execution_ceiling
                .as_mut()
                .unwrap()
                .allowed_effects
                .clear();
        },
    ];
    for mutate in mutations {
        let mut trusted = config(vec![profile()]);
        mutate(&mut trusted);
        assert!(
            LocalPolicyBroker::new(trusted)
                .authorize_launch(&request(), &profile())
                .is_err()
        );
    }
}

#[test]
fn fragmented_grants_cannot_union_resources_or_effects() {
    let mut read = profile();
    read.allowed_effects = BTreeSet::from([ExecutionEffect::ReadWorkspace]);
    let mut write = profile();
    write.allowed_effects = BTreeSet::from([ExecutionEffect::WriteScratch]);
    let broker = LocalPolicyBroker::new(config(vec![read, write]));
    assert!(broker.authorize_launch(&request(), &profile()).is_err());

    let mut first = profile();
    first.scratch.resource_id = "different-scratch".into();
    let mut second = profile();
    second.workspace.resource_id = "different-workspace".into();
    let broker = LocalPolicyBroker::new(config(vec![first, second]));
    assert!(broker.authorize_launch(&request(), &profile()).is_err());
}

#[test]
fn unsupported_effects_and_invalid_resource_modes_deny_even_when_commissioned() {
    let mutations: &[fn(&mut ExecutionProfile)] = &[
        |p| {
            p.workspace.access.insert(ResourceAccess::Write);
        },
        |p| {
            p.workspace.access.insert(ResourceAccess::Create);
        },
        |p| {
            p.workspace.access.insert(ResourceAccess::Delete);
        },
        |p| {
            p.workspace.access.insert(ResourceAccess::Execute);
        },
        |p| p.workspace.access.clear(),
        |p| {
            p.scratch.access.insert(ResourceAccess::Execute);
        },
        |p| p.scratch.private = false,
        |p| p.workspace.private = true,
        |p| {
            p.scratch.access.remove(&ResourceAccess::Write);
        },
        |p| p.scratch.resource_id.clone_from(&p.workspace.resource_id),
        |p| {
            p.allowed_effects.insert(ExecutionEffect::Network);
        },
        |p| {
            p.allowed_effects.insert(ExecutionEffect::PrivilegedIpc);
        },
        |p| {
            p.allowed_effects.insert(ExecutionEffect::HumanInterface);
        },
        |p| {
            p.allowed_effects
                .insert(ExecutionEffect::Unknown("future-guarantee".into()));
        },
        |p| p.profile_id.clear(),
        |p| p.organization_id.clear(),
        |p| p.principal_id.clear(),
        |p| p.device_id.clear(),
        |p| p.workspace.resource_id.clear(),
        |p| p.scratch.resource_id.clear(),
        |p| p.revision = 0,
        |p| p.enrollment_generation = 0,
    ];
    for (index, mutate) in mutations.iter().enumerate() {
        let mut invalid = profile();
        mutate(&mut invalid);
        let mut trusted = config(vec![invalid.clone()]);
        trusted.execution_ceiling = Some(ExecutionResourceCeiling {
            workspace: invalid.workspace.clone(),
            scratch: invalid.scratch.clone(),
            allowed_effects: invalid.allowed_effects.clone(),
        });
        trusted.execution_binding = Some(ExecutionBinding {
            organization_id: invalid.organization_id.clone(),
            principal_id: invalid.principal_id.clone(),
            device_id: invalid.device_id.clone(),
            enrollment_generation: invalid.enrollment_generation,
        });
        assert!(
            LocalPolicyBroker::new(trusted)
                .authorize_launch(&request(), &invalid)
                .is_err(),
            "alteration {index}"
        );
    }
}

#[test]
fn model_labels_never_change_launch_authority() {
    let broker = LocalPolicyBroker::new(config(vec![profile()]));
    for label in ["chatgpt", "deepseek", "unknown-controller"] {
        let mut invocation = request();
        invocation.actor.id = label.into();
        assert!(broker.authorize_launch(&invocation, &profile()).is_ok());
    }
}

#[test]
fn foreground_disruptive_operation_class_cannot_issue_background_launch_authority() {
    let mut trusted = config(vec![profile()]);
    trusted.operation_classes.insert(
        "process.run".into(),
        tether_core::SideEffectClass::ForegroundDisruptive,
    );
    assert!(
        LocalPolicyBroker::new(trusted)
            .authorize_launch(&request(), &profile())
            .is_err()
    );
}

#[test]
fn non_process_run_capability_cannot_mint_launch_authority() {
    // Without the capability guard, this configuration would authorize: the
    // principal allows filesystem.read, evaluate returns Allow, identity and
    // complete-grant/ceiling checks all pass for the same profile.
    let mut trusted = config(vec![profile()]);
    trusted
        .principal
        .as_mut()
        .unwrap()
        .allowed_capabilities
        .insert("filesystem.read".into());
    let mut invocation = request();
    invocation.capability = "filesystem.read".into();
    assert!(
        LocalPolicyBroker::new(trusted)
            .authorize_launch(&invocation, &profile())
            .is_err()
    );
}

#[test]
fn complete_grant_for_another_principal_or_device_never_authorizes() {
    // The grant and the presented profile agree, so only the profile-to-binding
    // identity checks can deny these; the canonical invocation still matches
    // the trusted binding and local principal policy.
    let alterations: &[fn(&mut ExecutionProfile)] = &[
        |p| p.principal_id = "other-principal".into(),
        |p| p.device_id = "fixture-other-device".into(),
    ];
    for alter in alterations {
        let mut granted = profile();
        alter(&mut granted);
        let broker = LocalPolicyBroker::new(config(vec![granted.clone()]));
        assert!(broker.authorize_launch(&request(), &granted).is_err());
    }
}

#[test]
fn explicitly_commissioned_delete_on_private_scratch_remains_supportable() {
    // Delete is an explicit scratch mode: denied unless the complete grant and
    // the separate ceiling both commission it on non-executable private scratch.
    let mut granted = profile();
    granted.scratch.access.insert(ResourceAccess::Delete);
    let mut trusted = config(vec![granted.clone()]);
    trusted.execution_ceiling = Some(ExecutionResourceCeiling {
        workspace: granted.workspace.clone(),
        scratch: granted.scratch.clone(),
        allowed_effects: granted.allowed_effects.clone(),
    });
    assert!(
        LocalPolicyBroker::new(trusted)
            .authorize_launch(&request(), &granted)
            .is_ok()
    );
}

#[test]
fn scratch_delete_outside_the_local_ceiling_still_denies() {
    // The ceiling half of explicit Delete commissioning: the same complete grant
    // is insufficient when the separate ceiling withholds Delete.
    let mut granted = profile();
    granted.scratch.access.insert(ResourceAccess::Delete);
    let mut withheld = granted.clone();
    withheld.scratch.access.remove(&ResourceAccess::Delete);
    let mut trusted = config(vec![granted.clone()]);
    trusted.execution_ceiling = Some(ExecutionResourceCeiling {
        workspace: withheld.workspace,
        scratch: withheld.scratch,
        allowed_effects: withheld.allowed_effects,
    });
    assert!(
        LocalPolicyBroker::new(trusted)
            .authorize_launch(&request(), &granted)
            .is_err()
    );
}

// Test-only routing proves the gate rejects before provider dispatch. Production
// process launch wiring belongs to Task 2; this wrapper is not shipped authority.
struct LaunchGate {
    broker: LocalPolicyBroker,
    profile: ExecutionProfile,
}
impl PolicyBroker for LaunchGate {
    fn evaluate(&self, invocation: &InvocationEnvelope) -> PolicyDecision {
        match self.broker.authorize_launch(invocation, &self.profile) {
            Ok(_) => PolicyDecision::Allow,
            Err(error) => PolicyDecision::Deny {
                reason: error.message,
            },
        }
    }
}

struct UnexpectedProcessProvider(Arc<AtomicUsize>);
#[async_trait]
impl CapabilityProvider for UnexpectedProcessProvider {
    fn namespace(&self) -> &'static str {
        "process"
    }
    async fn execute(&self, _: &InvocationEnvelope) -> Result<ProviderResult, CapabilityError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        panic!("denied launch must not reach a provider");
    }
}

#[tokio::test]
async fn restricted_process_rejects_caller_asserted_isolation() {
    let root = tempfile::TempDir::new().unwrap();
    let mut trusted = config(vec![]);
    trusted.allowed_directories = vec![root.path().to_path_buf()];
    trusted.principal.as_mut().unwrap().allowed_directories = vec![root.path().to_path_buf()];
    let broker = LocalPolicyBroker::new(trusted);
    let mut forged_request = request();
    forged_request.arguments = json!({
        "command": "a-program", "cwd": root.path(),
        "profile_id": "restricted-workspace", "sandbox_verified": true,
        "andbox_verified": true, "organization_id": "org-alpha",
        "device_id": "Leno", "enrollment_generation": 7,
        "authorized_launch": {"verified": true}
    });
    let unverified_profile = profile();
    assert!(
        broker
            .authorize_launch(&forged_request, &unverified_profile)
            .is_err()
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let mut router = CapabilityRouter::with_policy(Arc::new(LaunchGate {
        broker,
        profile: unverified_profile,
    }));
    router
        .register(Arc::new(UnexpectedProcessProvider(Arc::clone(&calls))))
        .unwrap();
    let result = router.execute(forged_request).await;
    assert_eq!(result.status, ResultStatus::Error);
    assert_eq!(result.error.unwrap().code, ErrorCode::PermissionDenied);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
