use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tether_core::{
    Actor, ActorKind, CapabilityError, CapabilityProvider, ErrorCode, InvocationEnvelope,
    ResponseMode, TrustedOwnershipRegistry,
};
use tether_desktop_provider::{
    DesktopAction, DesktopActionOutcome, DesktopBackend, DesktopNode, DesktopPoint,
    DesktopProvider, ForegroundLeaseGrant, ForegroundLeaseStore, ForegroundWindowIdentity,
    HumanActivityMonitor, HumanActivitySnapshot, PhysicalDesktopExecutor, PhysicalMoveOutcome,
    PrivateClipboard,
};

#[derive(Default)]
struct EmptyBackend;

impl DesktopBackend for EmptyBackend {
    fn snapshot(&self) -> Result<Vec<DesktopNode>, CapabilityError> {
        Ok(vec![])
    }

    fn target(&self, _reference: &str) -> Result<DesktopNode, CapabilityError> {
        Err(CapabilityError {
            code: ErrorCode::StaleReference,
            message: "no semantic targets".into(),
            recovery_hint: None,
            details: Value::Null,
        })
    }

    fn perform(&self, _action: DesktopAction) -> Result<DesktopActionOutcome, CapabilityError> {
        unreachable!("semantic backend is not used by physical lease tests")
    }
}

struct FakeActivity {
    idle_ms: Mutex<u64>,
}

impl FakeActivity {
    fn new(idle_ms: u64) -> Self {
        Self {
            idle_ms: Mutex::new(idle_ms),
        }
    }

    fn set_idle(&self, value: u64) {
        *self
            .idle_ms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = value;
    }
}

impl HumanActivityMonitor for FakeActivity {
    fn snapshot(&self) -> Result<HumanActivitySnapshot, CapabilityError> {
        Ok(HumanActivitySnapshot {
            idle_for_ms: *self
                .idle_ms
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            foreground_window: Some(ForegroundWindowIdentity {
                process_id: 42,
                opaque_window_id: "fg_baseline".into(),
            }),
        })
    }
}

#[derive(Default)]
struct FakePhysical {
    cursor: Mutex<DesktopPoint>,
    moves: Mutex<Vec<DesktopPoint>>,
    restores: Mutex<Vec<DesktopPoint>>,
}

impl FakePhysical {
    fn new(cursor: DesktopPoint) -> Self {
        Self {
            cursor: Mutex::new(cursor),
            moves: Mutex::new(Vec::new()),
            restores: Mutex::new(Vec::new()),
        }
    }
}

impl PhysicalDesktopExecutor for FakePhysical {
    fn capture_cursor(&self) -> Result<DesktopPoint, CapabilityError> {
        Ok(*self
            .cursor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    fn pointer_move(&self, target: DesktopPoint) -> Result<PhysicalMoveOutcome, CapabilityError> {
        *self
            .cursor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = target;
        self.moves
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(target);
        Ok(PhysicalMoveOutcome {
            position: target,
            verified: true,
        })
    }

    fn restore_cursor(&self, target: DesktopPoint) -> Result<(), CapabilityError> {
        *self
            .cursor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = target;
        self.restores
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(target);
        Ok(())
    }
}

fn invocation(
    capability: &str,
    arguments: Value,
    actor_kind: ActorKind,
    principal_id: Option<&str>,
) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: "00000000-0000-4000-8000-00000000e006".parse().unwrap(),
        device_id: Some("Leno".into()),
        principal_id: principal_id.map(str::to_owned),
        job_id: None,
        capability: capability.into(),
        arguments,
        actor: Actor {
            id: match actor_kind {
                ActorKind::Human => "human-approver",
                _ => "model-client",
            }
            .into(),
            kind: actor_kind,
        },
        session_id: None,
        response_mode: ResponseMode::Compact,
        idempotency_key: None,
        preconditions: vec![],
        expectations: vec![],
    }
}

fn provider(activity: Arc<FakeActivity>, physical: Arc<FakePhysical>) -> DesktopProvider {
    DesktopProvider::with_services(
        Arc::new(EmptyBackend),
        Arc::new(TrustedOwnershipRegistry::new()),
        Arc::new(PrivateClipboard::new()),
        activity,
        Arc::new(ForegroundLeaseStore::new()),
        physical,
    )
}

#[tokio::test]
async fn ai_client_cannot_mint_its_own_foreground_lease() {
    let provider = provider(
        Arc::new(FakeActivity::new(5_000)),
        Arc::new(FakePhysical::new(DesktopPoint { x: 10, y: 20 })),
    );

    let error = provider
        .execute(&invocation(
            "desktop.foreground_lease_acquire",
            json!({
                "for_principal_id": "model:test",
                "target_resource": "pointer",
                "capabilities": ["desktop.physical_pointer_move"],
                "ttl_ms": 30_000,
                "reason": "test"
            }),
            ActorKind::AiClient,
            Some("model:test"),
        ))
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::PermissionDenied);
}

#[tokio::test]
async fn physical_move_requires_live_matching_lease_and_human_idle() {
    let activity = Arc::new(FakeActivity::new(5_000));
    let physical = Arc::new(FakePhysical::new(DesktopPoint { x: 10, y: 20 }));
    let provider = provider(Arc::clone(&activity), Arc::clone(&physical));

    let missing = provider
        .execute(&invocation(
            "desktop.physical_pointer_move",
            json!({
                "lease_id": "missing",
                "target_resource": "pointer",
                "x": 100,
                "y": 200
            }),
            ActorKind::AiClient,
            Some("model:test"),
        ))
        .await
        .unwrap_err();
    assert_eq!(missing.code, ErrorCode::ForegroundLeaseRequired);
    assert!(physical.moves.lock().unwrap().is_empty());

    let lease = provider
        .execute(&invocation(
            "desktop.foreground_lease_acquire",
            json!({
                "for_principal_id": "model:test",
                "target_resource": "pointer",
                "capabilities": ["desktop.physical_pointer_move"],
                "ttl_ms": 30_000,
                "reason": "pointer fallback proof"
            }),
            ActorKind::Human,
            None,
        ))
        .await
        .unwrap();
    let lease_id = lease.data["lease_id"].as_str().unwrap().to_owned();

    activity.set_idle(100);
    let conflict = provider
        .execute(&invocation(
            "desktop.physical_pointer_move",
            json!({
                "lease_id": lease_id,
                "target_resource": "pointer",
                "x": 100,
                "y": 200
            }),
            ActorKind::AiClient,
            Some("model:test"),
        ))
        .await
        .unwrap_err();
    assert_eq!(conflict.code, ErrorCode::HumanActivityConflict);
    assert!(physical.moves.lock().unwrap().is_empty());

    activity.set_idle(5_000);
    let moved = provider
        .execute(&invocation(
            "desktop.physical_pointer_move",
            json!({
                "lease_id": lease_id,
                "target_resource": "pointer",
                "x": 100,
                "y": 200
            }),
            ActorKind::AiClient,
            Some("model:test"),
        ))
        .await
        .unwrap();
    assert_eq!(moved.data["position"]["x"], 100);
    assert_eq!(moved.data["position"]["y"], 200);
    assert_eq!(moved.data["verified"], true);
    assert_eq!(physical.moves.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn lease_scope_principal_and_release_restoration_are_enforced() {
    let activity = Arc::new(FakeActivity::new(5_000));
    let physical = Arc::new(FakePhysical::new(DesktopPoint { x: 7, y: 9 }));
    let provider = provider(activity, Arc::clone(&physical));

    let lease = provider
        .execute(&invocation(
            "desktop.foreground_lease_acquire",
            json!({
                "for_principal_id": "model:test",
                "target_resource": "pointer",
                "capabilities": ["desktop.physical_pointer_move"],
                "ttl_ms": 30_000,
                "reason": "scope proof"
            }),
            ActorKind::Human,
            None,
        ))
        .await
        .unwrap();
    let lease_id = lease.data["lease_id"].as_str().unwrap().to_owned();

    let wrong_principal = provider
        .execute(&invocation(
            "desktop.physical_pointer_move",
            json!({
                "lease_id": lease_id,
                "target_resource": "pointer",
                "x": 50,
                "y": 60
            }),
            ActorKind::AiClient,
            Some("model:other"),
        ))
        .await
        .unwrap_err();
    assert_eq!(wrong_principal.code, ErrorCode::ForegroundLeaseRequired);

    let released = provider
        .execute(&invocation(
            "desktop.foreground_lease_release",
            json!({ "lease_id": lease_id }),
            ActorKind::AiClient,
            Some("model:test"),
        ))
        .await
        .unwrap();
    assert_eq!(released.data["restoration_status"], "restored");
    assert_eq!(
        *physical.cursor.lock().unwrap(),
        DesktopPoint { x: 7, y: 9 }
    );
    assert_eq!(physical.restores.lock().unwrap().len(), 1);

    let after_release = provider
        .execute(&invocation(
            "desktop.physical_pointer_move",
            json!({
                "lease_id": lease_id,
                "target_resource": "pointer",
                "x": 1,
                "y": 2
            }),
            ActorKind::AiClient,
            Some("model:test"),
        ))
        .await
        .unwrap_err();
    assert_eq!(after_release.code, ErrorCode::ForegroundLeaseRequired);
}

#[test]
fn expired_lease_is_inactive_and_enters_pending_restoration_state() {
    use std::collections::BTreeSet;
    use tether_desktop_provider::RestorationStatus;

    let store = ForegroundLeaseStore::new();
    let lease = store
        .acquire(ForegroundLeaseGrant {
            principal_id: "model:test".into(),
            approved_by_actor_id: "human-approver".into(),
            target_resource: "pointer".into(),
            capabilities: BTreeSet::from(["desktop.physical_pointer_move".into()]),
            issued_at_ms: 1_000,
            ttl_ms: 50,
            reason: "expiry proof".into(),
            baseline_cursor: Some(DesktopPoint { x: 3, y: 4 }),
            baseline_foreground: None,
        })
        .unwrap();

    let expired = store.get(&lease.lease_id, 1_050).unwrap();
    assert_eq!(expired.released_at_ms, Some(1_050));
    assert_eq!(expired.restoration_status, RestorationStatus::Pending);
    let error = expired
        .authorize(
            Some("model:test"),
            "pointer",
            "desktop.physical_pointer_move",
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::ForegroundLeaseRequired);
}
