use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tether_core::{
    Actor, ActorKind, CapabilityError, CapabilityProvider, ErrorCode, InvocationEnvelope,
    ResourceKey, ResourceOrigin, ResponseMode, TrustedOwnershipRegistry, VerificationStatus,
};
use tether_desktop_provider::{
    DesktopAction, DesktopActionKind, DesktopActionOutcome, DesktopBackend, DesktopNode,
    DesktopPattern, DesktopProvider,
};

#[derive(Default)]
struct FakeBackend {
    nodes: Vec<DesktopNode>,
    performed: Mutex<Vec<DesktopAction>>,
}

impl FakeBackend {
    fn with_nodes(nodes: Vec<DesktopNode>) -> Self {
        Self {
            nodes,
            performed: Mutex::new(Vec::new()),
        }
    }

    fn performed(&self) -> Vec<DesktopAction> {
        self.performed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

impl DesktopBackend for FakeBackend {
    fn snapshot(&self) -> Result<Vec<DesktopNode>, CapabilityError> {
        Ok(self.nodes.clone())
    }

    fn target(&self, reference: &str) -> Result<DesktopNode, CapabilityError> {
        self.nodes
            .iter()
            .find(|node| node.reference == reference)
            .cloned()
            .ok_or_else(|| CapabilityError {
                code: ErrorCode::StaleReference,
                message: "desktop reference is stale".into(),
                recovery_hint: Some("take a new desktop snapshot".into()),
                details: json!({ "reference": reference }),
            })
    }

    fn perform(&self, action: DesktopAction) -> Result<DesktopActionOutcome, CapabilityError> {
        let target = self.target(&action.reference)?;
        self.performed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(action);
        Ok(DesktopActionOutcome {
            target,
            verified: true,
            delta: json!({ "changed": true }),
        })
    }
}

fn node(reference: &str, process_id: u32, name: &str) -> DesktopNode {
    DesktopNode {
        reference: reference.into(),
        parent_reference: None,
        role: "button".into(),
        name: name.into(),
        automation_id: Some(reference.into()),
        class_name: Some("FakeButton".into()),
        process_id,
        enabled: true,
        focusable: true,
        focused: false,
        patterns: vec![DesktopPattern::Invoke, DesktopPattern::Value],
    }
}

fn invocation(capability: &str, arguments: Value) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: "00000000-0000-4000-8000-00000000e001".parse().unwrap(),
        device_id: Some("Leno".into()),
        principal_id: Some("model:test".into()),
        job_id: None,
        capability: capability.into(),
        arguments,
        actor: Actor {
            id: "desktop-test".into(),
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
async fn snapshot_is_bounded_and_labels_origin_from_trusted_process_ownership() {
    let ownership = Arc::new(TrustedOwnershipRegistry::new());
    ownership.register(ResourceKey::Process(100), ResourceOrigin::Tetherplane);
    let backend = Arc::new(FakeBackend::with_nodes(vec![
        node("el_owned", 100, "Owned"),
        node("el_human", 200, "Human"),
        node("el_extra", 300, "Extra"),
    ]));
    let provider = DesktopProvider::new(backend, ownership);

    let result = provider
        .execute(&invocation("desktop.snapshot", json!({ "max_nodes": 2 })))
        .await
        .unwrap();

    let nodes = result.data["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 2);
    assert_eq!(result.data["truncated"], true);
    assert_eq!(nodes[0]["origin"], "tetherplane");
    assert_eq!(nodes[1]["origin"], "human_or_external");
    assert_eq!(result.verification, VerificationStatus::NotApplicable);
}

#[tokio::test]
async fn semantic_action_mutates_owned_target_and_returns_verified_delta() {
    let ownership = Arc::new(TrustedOwnershipRegistry::new());
    ownership.register(ResourceKey::Process(100), ResourceOrigin::Tetherplane);
    let backend = Arc::new(FakeBackend::with_nodes(vec![node(
        "el_owned", 100, "Owned",
    )]));
    let provider = DesktopProvider::new(Arc::clone(&backend), ownership);

    let result = provider
        .execute(&invocation(
            "desktop.act",
            json!({
                "reference": "el_owned",
                "action": "invoke"
            }),
        ))
        .await
        .unwrap();

    assert_eq!(result.data["verified"], true);
    assert_eq!(result.data["target"]["reference"], "el_owned");
    assert_eq!(result.data["target"]["origin"], "tetherplane");
    assert_eq!(result.verification, VerificationStatus::Verified);
    assert_eq!(backend.performed().len(), 1);
    assert_eq!(backend.performed()[0].kind, DesktopActionKind::Invoke);
}

#[tokio::test]
async fn caller_supplied_origin_cannot_authorize_unknown_or_human_target() {
    let ownership = Arc::new(TrustedOwnershipRegistry::new());
    let backend = Arc::new(FakeBackend::with_nodes(vec![node(
        "el_human", 200, "Human",
    )]));
    let provider = DesktopProvider::new(Arc::clone(&backend), ownership);

    let error = provider
        .execute(&invocation(
            "desktop.act",
            json!({
                "reference": "el_human",
                "action": "invoke",
                "origin": "tetherplane"
            }),
        ))
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::PermissionDenied);
    assert!(backend.performed().is_empty());
}

#[tokio::test]
async fn stale_reference_is_preserved_as_machine_readable_error() {
    let ownership = Arc::new(TrustedOwnershipRegistry::new());
    let backend = Arc::new(FakeBackend::default());
    let provider = DesktopProvider::new(backend, ownership);

    let error = provider
        .execute(&invocation(
            "desktop.act",
            json!({
                "reference": "missing",
                "action": "invoke"
            }),
        ))
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::StaleReference);
}

#[tokio::test]
async fn value_action_carries_direct_semantic_value_without_clipboard_use() {
    let ownership = Arc::new(TrustedOwnershipRegistry::new());
    ownership.register(ResourceKey::Process(100), ResourceOrigin::Tetherplane);
    let backend = Arc::new(FakeBackend::with_nodes(vec![node(
        "el_owned", 100, "Owned",
    )]));
    let provider = DesktopProvider::new(Arc::clone(&backend), ownership);

    provider
        .execute(&invocation(
            "desktop.act",
            json!({
                "reference": "el_owned",
                "action": "set_value",
                "value": "semantic-direct-value"
            }),
        ))
        .await
        .unwrap();

    let performed = backend.performed();
    assert_eq!(performed.len(), 1);
    assert_eq!(performed[0].kind, DesktopActionKind::SetValue);
    assert_eq!(performed[0].value.as_deref(), Some("semantic-direct-value"));
}
