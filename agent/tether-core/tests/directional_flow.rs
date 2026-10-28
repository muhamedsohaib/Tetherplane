//! Test-first contract for future *authenticated* device-to-device data flows.
//! Pure policy tests only: these grants are NOT installed or reachable from
//! production relay/device RPC. Real identities must come from trusted auth.
use tether_core::{
    DirectionalFlowPolicy, DirectionalGrant, PolicyDecision, TransferContent, TransferDirection,
    TrustedTransferIntent,
};

const PRINCIPAL: &str = "human:owner";
const SCOPE: &str = "fixture:approved-report";

fn grant(
    id: &str,
    owner: &str,
    peer: &str,
    direction: TransferDirection,
    content: TransferContent,
) -> DirectionalGrant {
    DirectionalGrant {
        grant_id: id.into(),
        owner_device_id: owner.into(),
        peer_device_id: peer.into(),
        principal_id: PRINCIPAL.into(),
        direction,
        content,
        resource_scope: SCOPE.into(),
        max_bytes: 512,
        expires_at_ms: 10_000,
    }
}

fn b_to_a(content: TransferContent) -> TrustedTransferIntent {
    TrustedTransferIntent {
        source_device_id: "B".into(),
        destination_device_id: "A".into(),
        principal_id: PRINCIPAL.into(),
        content,
        resource_scope: SCOPE.into(),
        bytes: 128,
        now_ms: 5_000,
    }
}

fn denied(result: PolicyDecision) {
    assert!(matches!(result, PolicyDecision::Deny { .. }), "{result:?}");
}

#[test]
fn no_grants_denies_even_read_only_file_extraction() {
    // A read-only operation from B still discloses B's data to A.
    let policy = DirectionalFlowPolicy::new(vec![]);
    denied(policy.evaluate(&b_to_a(TransferContent::FileBytes)));
}

#[test]
fn source_consent_without_receiver_consent_is_not_enough() {
    let policy = DirectionalFlowPolicy::new(vec![grant(
        "send-b",
        "B",
        "A",
        TransferDirection::Send,
        TransferContent::FileBytes,
    )]);
    denied(policy.evaluate(&b_to_a(TransferContent::FileBytes)));
}

#[test]
fn explicit_send_and_receive_grants_allow_one_exact_transfer() {
    let policy = DirectionalFlowPolicy::new(vec![
        grant(
            "send-b",
            "B",
            "A",
            TransferDirection::Send,
            TransferContent::FileBytes,
        ),
        grant(
            "receive-a",
            "A",
            "B",
            TransferDirection::Receive,
            TransferContent::FileBytes,
        ),
    ]);
    assert_eq!(
        policy.evaluate(&b_to_a(TransferContent::FileBytes)),
        PolicyDecision::Allow
    );
}

#[test]
fn one_way_a_to_b_does_not_implicitly_authorize_reverse_b_to_a() {
    let policy = DirectionalFlowPolicy::new(vec![
        grant(
            "send-a",
            "A",
            "B",
            TransferDirection::Send,
            TransferContent::ClipboardText,
        ),
        grant(
            "receive-b",
            "B",
            "A",
            TransferDirection::Receive,
            TransferContent::ClipboardText,
        ),
    ]);
    let mut forward = b_to_a(TransferContent::ClipboardText);
    forward.source_device_id = "A".into();
    forward.destination_device_id = "B".into();
    assert_eq!(policy.evaluate(&forward), PolicyDecision::Allow);
    denied(policy.evaluate(&b_to_a(TransferContent::ClipboardText)));
}

#[test]
fn clipboard_permission_does_not_authorize_files_screens_or_browser_content() {
    let policy = DirectionalFlowPolicy::new(vec![
        grant(
            "b-send-clip",
            "B",
            "A",
            TransferDirection::Send,
            TransferContent::ClipboardText,
        ),
        grant(
            "a-receive-clip",
            "A",
            "B",
            TransferDirection::Receive,
            TransferContent::ClipboardText,
        ),
    ]);
    assert_eq!(
        policy.evaluate(&b_to_a(TransferContent::ClipboardText)),
        PolicyDecision::Allow
    );
    for kind in [
        TransferContent::FileBytes,
        TransferContent::BrowserPage,
        TransferContent::ScreenFrame,
        TransferContent::ClipboardFileReference,
    ] {
        denied(policy.evaluate(&b_to_a(kind)));
    }
}

#[test]
fn authorizing_command_delivery_does_not_authorize_output_extraction() {
    let policy = DirectionalFlowPolicy::new(vec![
        grant(
            "a-send-command",
            "A",
            "B",
            TransferDirection::Send,
            TransferContent::CommandRequest,
        ),
        grant(
            "b-receive-command",
            "B",
            "A",
            TransferDirection::Receive,
            TransferContent::CommandRequest,
        ),
    ]);
    let mut command = b_to_a(TransferContent::CommandRequest);
    command.source_device_id = "A".into();
    command.destination_device_id = "B".into();
    assert_eq!(policy.evaluate(&command), PolicyDecision::Allow);
    denied(policy.evaluate(&b_to_a(TransferContent::CommandOutput)));
}

#[test]
fn device_identity_and_principal_must_match_both_endpoint_grants() {
    let policy = DirectionalFlowPolicy::new(vec![
        grant(
            "send-b",
            "B",
            "A",
            TransferDirection::Send,
            TransferContent::LinkUrl,
        ),
        grant(
            "receive-a",
            "A",
            "B",
            TransferDirection::Receive,
            TransferContent::LinkUrl,
        ),
    ]);
    assert_eq!(
        policy.evaluate(&b_to_a(TransferContent::LinkUrl)),
        PolicyDecision::Allow
    );
    let mut wrong_peer = b_to_a(TransferContent::LinkUrl);
    wrong_peer.destination_device_id = "Vaulter".into();
    denied(policy.evaluate(&wrong_peer));
    let mut wrong_principal = b_to_a(TransferContent::LinkUrl);
    wrong_principal.principal_id = "model:unapproved".into();
    denied(policy.evaluate(&wrong_principal));
}

#[test]
fn scope_and_byte_limits_apply_in_both_directions() {
    let mut receiver = grant(
        "receive-a",
        "A",
        "B",
        TransferDirection::Receive,
        TransferContent::FileBytes,
    );
    receiver.max_bytes = 100;
    let policy = DirectionalFlowPolicy::new(vec![
        grant(
            "send-b",
            "B",
            "A",
            TransferDirection::Send,
            TransferContent::FileBytes,
        ),
        receiver,
    ]);
    let mut over_limit = b_to_a(TransferContent::FileBytes);
    over_limit.bytes = 101;
    denied(policy.evaluate(&over_limit));
    let mut wrong_resource = b_to_a(TransferContent::FileBytes);
    wrong_resource.bytes = 10;
    wrong_resource.resource_scope = "fixture:unapproved-secret".into();
    denied(policy.evaluate(&wrong_resource));
    let mut small = b_to_a(TransferContent::FileBytes);
    small.bytes = 100;
    assert_eq!(policy.evaluate(&small), PolicyDecision::Allow);
}

#[test]
fn expired_and_revoked_grants_deny_existing_direction() {
    let mut policy = DirectionalFlowPolicy::new(vec![
        grant(
            "send-b",
            "B",
            "A",
            TransferDirection::Send,
            TransferContent::FileBytes,
        ),
        grant(
            "receive-a",
            "A",
            "B",
            TransferDirection::Receive,
            TransferContent::FileBytes,
        ),
    ]);
    let mut expired = b_to_a(TransferContent::FileBytes);
    expired.now_ms = 10_000;
    denied(policy.evaluate(&expired));
    assert_eq!(
        policy.evaluate(&b_to_a(TransferContent::FileBytes)),
        PolicyDecision::Allow
    );
    policy.revoke("send-b");
    denied(policy.evaluate(&b_to_a(TransferContent::FileBytes)));
}

#[test]
fn invalid_wildcard_scope_and_same_device_request_fail_closed() {
    let policy = DirectionalFlowPolicy::new(vec![
        grant(
            "send-b",
            "B",
            "A",
            TransferDirection::Send,
            TransferContent::FileBytes,
        ),
        grant(
            "receive-a",
            "A",
            "B",
            TransferDirection::Receive,
            TransferContent::FileBytes,
        ),
    ]);
    let mut wildcard = b_to_a(TransferContent::FileBytes);
    wildcard.resource_scope = "*".into();
    denied(policy.evaluate(&wildcard));
    let mut same_device = b_to_a(TransferContent::FileBytes);
    same_device.destination_device_id = "B".into();
    denied(policy.evaluate(&same_device));
    let mut zero = b_to_a(TransferContent::FileBytes);
    zero.bytes = 0;
    denied(policy.evaluate(&zero));
}
