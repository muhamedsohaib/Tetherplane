//! An offline policy decision for separately approved, direction-specific
//! device-to-device data transfers. This module is not wired into the live
//! relay, provider dispatch, clipboard or filesystem I/O.
//!
//! Callers must construct `TrustedTransferIntent` from authenticated endpoint
//! identities and provider-resolved resource identifiers. Never use peer IDs,
//! principal IDs, resource scopes, byte counts or timestamps supplied verbatim
//! by an untrusted remote invocation as proof of authorization.

use std::collections::BTreeSet;

use crate::PolicyDecision;

/// Data classes are deliberately distinct: permission to issue a remote
/// command does not imply permission to extract its output.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransferContent {
    ClipboardText,
    ClipboardFileReference,
    FileBytes,
    LinkUrl,
    CommandRequest,
    CommandOutput,
    BrowserPage,
    ScreenFrame,
}

/// A grant issued by its owning device for a single transfer direction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransferDirection {
    Send,
    Receive,
}

/// Intended future owner-signed grant record; not currently persisted,
/// distributed, issued by Tetherplane, or accepted from a remote client.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectionalGrant {
    pub grant_id: String,
    pub owner_device_id: String,
    pub peer_device_id: String,
    pub principal_id: String,
    pub direction: TransferDirection,
    pub content: TransferContent,
    /// An exact, provider-validated *logical* resource identifier, not
    /// an untrusted pathname or wildcard.
    pub resource_scope: String,
    pub max_bytes: u64,
    pub expires_at_ms: u64,
}

/// Transfer metadata originating from a trusted, authenticated boundary.
/// This type intentionally does not deserialize a user-supplied JSON object.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedTransferIntent {
    pub source_device_id: String,
    pub destination_device_id: String,
    pub principal_id: String,
    pub content: TransferContent,
    pub resource_scope: String,
    pub bytes: u64,
    pub now_ms: u64,
}

/// Pure deny-by-default evaluator. No networking, local-device changes,
/// file reads or transfer operations can be performed by this type.
#[derive(Clone, Debug, Default)]
pub struct DirectionalFlowPolicy {
    grants: Vec<DirectionalGrant>,
    revoked: BTreeSet<String>,
}

impl DirectionalFlowPolicy {
    #[must_use]
    pub fn new(grants: Vec<DirectionalGrant>) -> Self {
        Self {
            grants,
            revoked: BTreeSet::new(),
        }
    }

    /// Revokes a grant in this evaluator. Future production use requires
    /// authenticated issuer, durable revocation and in-flight cancellation.
    pub fn revoke(&mut self, grant_id: &str) {
        self.revoked.insert(grant_id.to_owned());
    }

    /// A transfer needs an exact, unexpired source SEND and destination
    /// RECEIVE grant. The default is to deny every transfer.
    #[must_use]
    pub fn evaluate(&self, intent: &TrustedTransferIntent) -> PolicyDecision {
        if intent.source_device_id == intent.destination_device_id
            || !valid_exact(&intent.source_device_id)
            || !valid_exact(&intent.destination_device_id)
            || !valid_exact(&intent.principal_id)
            || !valid_exact(&intent.resource_scope)
            || intent.bytes == 0
        {
            return denied();
        }

        let can_send = self.has_grant(
            intent,
            TransferDirection::Send,
            &intent.source_device_id,
            &intent.destination_device_id,
        );
        let can_receive = self.has_grant(
            intent,
            TransferDirection::Receive,
            &intent.destination_device_id,
            &intent.source_device_id,
        );
        if can_send && can_receive {
            PolicyDecision::Allow
        } else {
            denied()
        }
    }

    fn has_grant(
        &self,
        intent: &TrustedTransferIntent,
        direction: TransferDirection,
        owner: &str,
        peer: &str,
    ) -> bool {
        self.grants.iter().any(|grant| {
            valid_exact(&grant.grant_id)
                && !self.revoked.contains(&grant.grant_id)
                && valid_exact(&grant.owner_device_id)
                && valid_exact(&grant.peer_device_id)
                && valid_exact(&grant.principal_id)
                && valid_exact(&grant.resource_scope)
                && grant.owner_device_id == owner
                && grant.peer_device_id == peer
                && grant.principal_id == intent.principal_id
                && grant.direction == direction
                && grant.content == intent.content
                && grant.resource_scope == intent.resource_scope
                && grant.max_bytes >= intent.bytes
                && intent.now_ms < grant.expires_at_ms
        })
    }
}

fn valid_exact(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains('*')
}

fn denied() -> PolicyDecision {
    PolicyDecision::Deny {
        reason: "directional device transfer requires active sender and receiver grants".into(),
    }
}
