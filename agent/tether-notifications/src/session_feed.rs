//! Bounded, in-process relay session event adapter.
//!
//! Must only be constructed *after* the existing authenticated relay accepted
//! the device WebSocket upgrade. Calling this constructor does not prove auth.
//! It does not expose credentials, create IPC, contact the network, or grant access.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{Event, EventKind, Provenance};

static EPOCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionFeedError {
    InvalidDeviceId,
    FeedUnavailable,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

/// RAII guard for one accepted device-authenticated WebSocket session.
/// Drop marks local session presence *unknown* rather than falsely claiming
/// an authoritative relay-declared offline state.
pub struct AcceptedRelaySession {
    tx: SyncSender<Event>,
    device_id: String,
    epoch: String,
    connected_at: u64,
}

impl AcceptedRelaySession {
    /// Create only following a successful, credential-checked /device upgrade.
    /// The caller remains responsible for authenticating the relay.
    ///
    /// # Errors
    /// Fails closed on invalid device ID or if the bounded observer queue is
    /// full/dropped; the enclosing authenticated transport must continue.
    pub fn after_authenticated_upgrade(
        tx: SyncSender<Event>,
        device_id: &str,
    ) -> Result<Self, SessionFeedError> {
        if device_id.is_empty()
            || device_id.len() > 128
            || !device_id.as_bytes()[0].is_ascii_alphanumeric()
            || !device_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        {
            return Err(SessionFeedError::InvalidDeviceId);
        }
        let stamp = now_ms();
        let epoch = format!(
            "ws-{}-{}",
            stamp,
            EPOCH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let event = Event {
            kind: EventKind::DeviceConnected,
            provenance: Provenance::AuthenticatedRelay,
            device_id: device_id.to_owned(),
            source_epoch: epoch.clone(),
            sequence: 1,
            observed_at_ms: stamp,
            request_id: None,
        };
        tx.try_send(event)
            .map_err(|_| SessionFeedError::FeedUnavailable)?;
        Ok(Self {
            tx,
            device_id: device_id.to_owned(),
            epoch,
            connected_at: stamp,
        })
    }
}

impl Drop for AcceptedRelaySession {
    fn drop(&mut self) {
        let event = Event {
            kind: EventKind::LocalStatusUnknown,
            provenance: Provenance::LocalAgentTransport,
            device_id: self.device_id.clone(),
            source_epoch: self.epoch.clone(),
            sequence: 2,
            observed_at_ms: now_ms().max(self.connected_at),
            request_id: None,
        };
        // Never block the device relay loop during transport teardown.
        // A saturated observer must independently expire its presence data.
        match self.tx.try_send(event) {
            Ok(()) | Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NotificationPolicy, Reject};
    use std::sync::mpsc::sync_channel;

    #[test]
    fn only_post_upgrade_guard_emits_connected_then_unknown() {
        let (tx, rx) = sync_channel(8);
        let connected;
        {
            let _guard = AcceptedRelaySession::after_authenticated_upgrade(tx, "Leno").unwrap();
            connected = rx.try_recv().unwrap();
            assert_eq!(connected.kind, EventKind::DeviceConnected);
            assert_eq!(connected.provenance, Provenance::AuthenticatedRelay);
            assert_eq!(connected.sequence, 1);
            assert_eq!(connected.device_id, "Leno");
            assert!(connected.request_id.is_none());
        }
        let unknown = rx.try_recv().unwrap();
        assert_eq!(unknown.kind, EventKind::LocalStatusUnknown);
        assert_eq!(unknown.provenance, Provenance::LocalAgentTransport);
        assert_eq!(unknown.sequence, 2);
        assert_eq!(unknown.source_epoch, connected.source_epoch);
        assert!(rx.try_recv().is_err());

        let mut policy = NotificationPolicy::default();
        let online = policy
            .accept(&connected, connected.observed_at_ms)
            .unwrap()
            .unwrap();
        assert!(online.title.contains("connected"));
        let lost = policy
            .accept(&unknown, unknown.observed_at_ms)
            .unwrap()
            .unwrap();
        assert!(lost.title.contains("status unknown"));
        assert!(!lost.title.contains("disconnected"));
        assert!(!lost.body.contains("confirmed offline"));
    }

    #[test]
    fn bounded_feed_full_does_not_claim_success_or_block() {
        let (tx, rx) = sync_channel(1);
        tx.send(Event {
            kind: EventKind::SetupNeedsAttention,
            provenance: Provenance::LocalSetup,
            device_id: "RTX".into(),
            source_epoch: "boot".into(),
            sequence: 1,
            observed_at_ms: now_ms(),
            request_id: None,
        })
        .unwrap();
        assert!(matches!(
            AcceptedRelaySession::after_authenticated_upgrade(tx, "RTX"),
            Err(SessionFeedError::FeedUnavailable)
        ));
        let untouched = rx.try_recv().unwrap();
        assert_eq!(untouched.kind, EventKind::SetupNeedsAttention);
    }

    #[test]
    fn invalid_identifiers_fail_before_event() {
        for id in ["", "../bad", "RTX\nFake", "RTX with spaces"] {
            let (tx, rx) = sync_channel(1);
            assert!(matches!(
                AcceptedRelaySession::after_authenticated_upgrade(tx, id),
                Err(SessionFeedError::InvalidDeviceId)
            ));
            assert!(rx.try_recv().is_err());
        }
    }

    #[test]
    fn replay_guard_is_not_authorization_and_stale_events_are_denied() {
        let (tx, rx) = sync_channel(1);
        let guard = AcceptedRelaySession::after_authenticated_upgrade(tx, "RTX").unwrap();
        let connected = rx.try_recv().unwrap();
        let mut policy = NotificationPolicy::default();
        policy.accept(&connected, connected.observed_at_ms).unwrap();
        assert_eq!(
            policy.accept(&connected, connected.observed_at_ms),
            Err(Reject::Replay)
        );
        drop(guard);
        let unknown = rx.try_recv().unwrap();
        assert_eq!(unknown.kind, EventKind::LocalStatusUnknown);
    }
}
