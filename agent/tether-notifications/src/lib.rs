//! Passive Windows notification policy. No device/network access or approval operations.
//! Events MUST originate from an authenticated local owner/relay/policy source before
//! entering this library. A provenance enum alone is not authentication.
use std::collections::{HashMap, VecDeque};

const FRESHNESS_MS: u64 = 90_000;
const FUTURE_SKEW_MS: u64 = 5_000;
const DEDUPE_MS: u64 = 300_000;
const FLAP_WINDOW_MS: u64 = 600_000;
const MAX_STREAMS: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    DeviceConnected,
    DeviceDisconnected,
    /// A local authenticated WebSocket was lost; remote device status is unverified.
    LocalStatusUnknown,
    PairingRequested,
    ApprovalRequired,
    PermissionRevoked,
    SetupNeedsAttention,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provenance {
    AuthenticatedRelay,
    ConfirmedRelayOffline,
    /// Local agent transport loss; never proves a remote device is offline.
    LocalAgentTransport,
    OwnerInteraction,
    LocalPolicyBroker,
    LocalSetup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Normal,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub kind: EventKind,
    pub provenance: Provenance,
    pub device_id: String,
    pub source_epoch: String,
    pub sequence: u64,
    pub observed_at_ms: u64,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    pub title: String,
    pub body: String,
    pub severity: Severity,
    pub key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    InvalidIdentity,
    UntrustedSource,
    StaleOrFuture,
    Replay,
    RosterLimit,
}

#[derive(Debug, Clone)]
struct Cursor {
    epoch: String,
    sequence: u64,
    observed_at_ms: u64,
}

#[derive(Debug, Default)]
pub struct NotificationPolicy {
    // Independent event streams must not share a sequence cursor.
    cursor: HashMap<(String, Provenance), Cursor>,
    connection: HashMap<String, ConnectionState>,
    notified: HashMap<String, u64>,
    transitions: HashMap<String, VecDeque<u64>>,
    unstable_until: HashMap<String, u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionState {
    Online,
    Offline,
    Unknown,
}

fn valid_identifier(value: &str, max: usize) -> bool {
    value.len() <= max
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn required_provenance(kind: EventKind) -> Provenance {
    match kind {
        EventKind::DeviceConnected => Provenance::AuthenticatedRelay,
        EventKind::DeviceDisconnected => Provenance::ConfirmedRelayOffline,
        EventKind::LocalStatusUnknown => Provenance::LocalAgentTransport,
        EventKind::PairingRequested => Provenance::OwnerInteraction,
        EventKind::ApprovalRequired | EventKind::PermissionRevoked => Provenance::LocalPolicyBroker,
        EventKind::SetupNeedsAttention => Provenance::LocalSetup,
    }
}

fn make_notice(event: &Event) -> Notification {
    let id = &event.device_id;
    let (title, body, severity) = match event.kind {
        EventKind::DeviceConnected => (
            format!("{id} connected"),
            "Authenticated relay session confirmed. Remote operations still require authorization.",
            Severity::Normal,
        ),
        EventKind::DeviceDisconnected => (
            format!("{id} disconnected"),
            "The relay no longer confirms an authenticated device session.",
            Severity::Normal,
        ),
        EventKind::LocalStatusUnknown => (
            format!("{id} status unknown"),
            "The local relay connection was interrupted. Device availability is unverified.",
            Severity::Normal,
        ),
        EventKind::PairingRequested => (
            format!("{id} requests pairing"),
            "Review this request in your existing authenticated Tetherplane owner interface.",
            Severity::High,
        ),
        EventKind::ApprovalRequired => (
            format!("{id} needs approval"),
            "Open Tetherplane to review the requested operation and its exact scope.",
            Severity::High,
        ),
        EventKind::PermissionRevoked => (
            format!("{id} access revoked"),
            "The local policy must deny further unauthorized operations.",
            Severity::High,
        ),
        EventKind::SetupNeedsAttention => (
            format!("{id} needs setup attention"),
            "Inspect the connection in Tetherplane. Existing identity and permissions are unchanged.",
            Severity::Normal,
        ),
    };
    Notification {
        title,
        body: body.to_owned(),
        severity,
        key: format!(
            "{:?}:{id}:{}",
            event.kind,
            event.request_id.as_deref().unwrap_or("")
        ),
    }
}

impl NotificationPolicy {
    /// Return at most one display-only notification. No side effects.
    /// The caller must authenticate the source before constructing an Event.
    ///
    /// # Errors
    /// Rejects invalid identifiers, missing evidence, stale/replayed events, or oversized rosters.
    pub fn accept(&mut self, event: &Event, now_ms: u64) -> Result<Option<Notification>, Reject> {
        if !valid_identifier(&event.device_id, 128)
            || !valid_identifier(&event.source_epoch, 64)
            || event
                .request_id
                .as_deref()
                .is_some_and(|v| !valid_identifier(v, 80))
        {
            return Err(Reject::InvalidIdentity);
        }
        if event.provenance != required_provenance(event.kind) {
            return Err(Reject::UntrustedSource);
        }
        if event.observed_at_ms > now_ms.saturating_add(FUTURE_SKEW_MS)
            || now_ms.saturating_sub(event.observed_at_ms) > FRESHNESS_MS
        {
            return Err(Reject::StaleOrFuture);
        }
        let cursor_key = (event.device_id.clone(), event.provenance);
        if let Some(last) = self.cursor.get(&cursor_key) {
            let replay = if last.epoch == event.source_epoch {
                event.sequence <= last.sequence || event.observed_at_ms < last.observed_at_ms
            } else {
                event.observed_at_ms <= last.observed_at_ms
            };
            if replay {
                return Err(Reject::Replay);
            }
        } else if self.cursor.len() >= MAX_STREAMS {
            return Err(Reject::RosterLimit);
        }
        self.cursor.insert(
            cursor_key,
            Cursor {
                epoch: event.source_epoch.clone(),
                sequence: event.sequence,
                observed_at_ms: event.observed_at_ms,
            },
        );

        if matches!(
            event.kind,
            EventKind::DeviceConnected
                | EventKind::DeviceDisconnected
                | EventKind::LocalStatusUnknown
        ) {
            let state = match event.kind {
                EventKind::DeviceConnected => ConnectionState::Online,
                EventKind::DeviceDisconnected => ConnectionState::Offline,
                EventKind::LocalStatusUnknown => ConnectionState::Unknown,
                _ => unreachable!(),
            };
            if self.connection.insert(event.device_id.clone(), state) == Some(state) {
                return Ok(None);
            }
            let changes = self.transitions.entry(event.device_id.clone()).or_default();
            while changes
                .front()
                .is_some_and(|t| now_ms.saturating_sub(*t) > FLAP_WINDOW_MS)
            {
                changes.pop_front();
            }
            changes.push_back(now_ms);
            let paused_until = *self.unstable_until.get(&event.device_id).unwrap_or(&0);
            if paused_until > now_ms {
                return Ok(None);
            }
            if changes.len() >= 3 {
                self.unstable_until
                    .insert(event.device_id.clone(), now_ms + FLAP_WINDOW_MS);
                return Ok(Some(Notification {
                    title: format!("{} connection unstable", event.device_id),
                    body: "Repeated authenticated connection changes were detected. Open Tetherplane to inspect status.".into(),
                    severity: Severity::Normal,
                    key: format!("Unstable:{}", event.device_id),
                }));
            }
        }

        let notice = make_notice(event);
        if self
            .notified
            .get(&notice.key)
            .is_some_and(|last| now_ms.saturating_sub(*last) < DEDUPE_MS)
        {
            return Ok(None);
        }
        self.notified.insert(notice.key.clone(), now_ms);
        // Bounded cleanup: long-running sessions cannot retain an unbounded alert-key history.
        if self.notified.len() > 1_024 {
            self.notified
                .retain(|_, when| now_ms.saturating_sub(*when) < DEDUPE_MS);
        }
        Ok(Some(notice))
    }
}

fn escape_xml(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            c if c.is_control() => {}
            c => escaped.push(c),
        }
    }
    escaped
}

impl Notification {
    /// Text-only toast. No activation arguments, approval buttons or external URLs.
    #[must_use]
    pub fn to_toast_xml(&self) -> String {
        format!(
            "<toast><visual><binding template=\"ToastGeneric\"><text>Tetherplane</text><text>{}</text><text>{}</text></binding></visual></toast>",
            escape_xml(&self.title),
            escape_xml(&self.body)
        )
    }

    #[must_use]
    pub fn diagnostic_smoke() -> Self {
        Self {
            title: "Tetherplane notification test".into(),
            body: "This is a local UI test. No device connection or authorization is implied."
                .into(),
            severity: Severity::Normal,
            key: "LocalSmoke".into(),
        }
    }
}

pub mod session_feed;

#[cfg(windows)]
pub mod windows_native;

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(kind: EventKind, provenance: Provenance, seq: u64, now: u64) -> Event {
        Event {
            kind,
            provenance,
            sequence: seq,
            observed_at_ms: now,
            device_id: "RTX".into(),
            source_epoch: "session-1".into(),
            request_id: None,
        }
    }

    #[test]
    fn positive_presence_requires_authenticated_relay_evidence() {
        let mut p = NotificationPolicy::default();
        let now = 1_000_000;
        let event = sample(
            EventKind::DeviceConnected,
            Provenance::AuthenticatedRelay,
            1,
            now,
        );
        let n = p.accept(&event, now).unwrap().unwrap();
        assert!(n.title.contains("RTX connected"));
        assert!(n.body.contains("Authenticated relay"));
        assert!(!n.body.contains("fully authorized"));
        let wrong = sample(
            EventKind::DeviceDisconnected,
            Provenance::AuthenticatedRelay,
            2,
            now + 1,
        );
        assert_eq!(p.accept(&wrong, now + 1), Err(Reject::UntrustedSource));
    }

    #[test]
    fn reject_wrong_evidence_for_all_security_events() {
        for kind in [
            EventKind::PairingRequested,
            EventKind::ApprovalRequired,
            EventKind::PermissionRevoked,
            EventKind::SetupNeedsAttention,
        ] {
            let mut p = NotificationPolicy::default();
            let event = sample(kind, Provenance::AuthenticatedRelay, 1, 100_000);
            assert_eq!(p.accept(&event, 100_000), Err(Reject::UntrustedSource));
        }
    }

    #[test]
    fn stale_future_and_replayed_events_fail_closed() {
        let mut p = NotificationPolicy::default();
        let mut e = sample(
            EventKind::DeviceConnected,
            Provenance::AuthenticatedRelay,
            1,
            100_000,
        );
        assert_eq!(p.accept(&e, 190_001), Err(Reject::StaleOrFuture));
        assert_eq!(p.accept(&e, 94_999), Err(Reject::StaleOrFuture));
        assert!(p.accept(&e, 100_000).unwrap().is_some());
        assert_eq!(p.accept(&e, 100_001), Err(Reject::Replay));
        e.source_epoch = "session-2".into();
        assert_eq!(p.accept(&e, 100_001), Err(Reject::Replay));
        e.observed_at_ms = 100_002;
        assert_eq!(p.accept(&e, 100_002), Ok(None));
    }

    #[test]
    fn duplicates_and_repeated_status_do_not_spam() {
        let mut p = NotificationPolicy::default();
        let e = sample(
            EventKind::DeviceConnected,
            Provenance::AuthenticatedRelay,
            1,
            1_000_000,
        );
        assert!(p.accept(&e, 1_000_000).unwrap().is_some());
        let mut later = e;
        later.sequence = 2;
        later.observed_at_ms += 2;
        assert_eq!(p.accept(&later, 1_000_002), Ok(None));
    }

    #[test]
    fn flapping_collapses_to_one_instability_notice() {
        let mut p = NotificationPolicy::default();
        for (seq, kind, evidence) in [
            (
                1,
                EventKind::DeviceConnected,
                Provenance::AuthenticatedRelay,
            ),
            (
                2,
                EventKind::DeviceDisconnected,
                Provenance::ConfirmedRelayOffline,
            ),
            (
                3,
                EventKind::DeviceConnected,
                Provenance::AuthenticatedRelay,
            ),
            (
                4,
                EventKind::DeviceDisconnected,
                Provenance::ConfirmedRelayOffline,
            ),
        ] {
            let now = 1_000_000 + seq * 1_000;
            let e = sample(kind, evidence, seq, now);
            let r = p.accept(&e, now).unwrap();
            if seq == 3 {
                assert_eq!(
                    r.as_ref().unwrap().title.as_str(),
                    "RTX connection unstable"
                );
            }
            if seq == 4 {
                assert!(r.is_none());
            }
        }
    }

    #[test]
    fn approval_is_info_only_and_distinct_requests_remain_visible() {
        let mut p = NotificationPolicy::default();
        let mut e = sample(
            EventKind::ApprovalRequired,
            Provenance::LocalPolicyBroker,
            1,
            100_000,
        );
        e.request_id = Some("approval-A".into());
        let n = p.accept(&e, 100_000).unwrap().unwrap();
        assert_eq!(n.severity, Severity::High);
        let xml = n.to_toast_xml();
        assert!(!xml.contains("<actions>"));
        assert!(!xml.contains("approve-A"));
        e.sequence = 2;
        e.observed_at_ms = 101_000;
        e.request_id = Some("approval-B".into());
        assert!(p.accept(&e, 101_000).unwrap().is_some());
    }

    #[test]
    fn invalid_device_and_request_identifiers_are_rejected() {
        let mut p = NotificationPolicy::default();
        let mut e = sample(
            EventKind::PairingRequested,
            Provenance::OwnerInteraction,
            1,
            100_000,
        );
        for bad in ["", "../secrets", "X\nNew Alert", "RTX\u{202E}yes"] {
            e.device_id = bad.into();
            assert_eq!(p.accept(&e, 100_000), Err(Reject::InvalidIdentity));
        }
        e.device_id = "RTX".into();
        e.request_id = Some("x?token=private".into());
        assert_eq!(p.accept(&e, 100_000), Err(Reject::InvalidIdentity));
    }

    #[test]
    fn xml_escaping_prevents_markup_and_activation_injection() {
        let n = Notification {
            title: "A<&\"B".into(),
            body: "value > 'test'".into(),
            severity: Severity::Normal,
            key: "x".into(),
        };
        let xml = n.to_toast_xml();
        assert!(xml.contains("A&lt;&amp;&quot;B"));
        assert!(xml.contains("value &gt; &apos;test&apos;"));
        assert!(!xml.contains("<actions>"));
        assert!(!xml.contains("<script"));
    }

    #[test]
    fn pairing_and_revocation_do_not_grant_permission() {
        let mut p = NotificationPolicy::default();
        let pairing = sample(
            EventKind::PairingRequested,
            Provenance::OwnerInteraction,
            1,
            100_000,
        );
        assert!(p.accept(&pairing, 100_000).unwrap().is_some());
        let revoke = sample(
            EventKind::PermissionRevoked,
            Provenance::LocalPolicyBroker,
            2,
            100_005,
        );
        let n = p.accept(&revoke, 100_005).unwrap().unwrap();
        assert_eq!(n.severity, Severity::High);
        assert!(n.to_toast_xml().contains("access revoked"));
    }
}

#[cfg(test)]
mod multi_source_regressions {
    use super::*;

    fn event(kind: EventKind, provenance: Provenance, sequence: u64, at: u64) -> Event {
        Event {
            kind,
            provenance,
            device_id: "RTX".into(),
            source_epoch: "source-123".into(),
            sequence,
            observed_at_ms: at,
            request_id: None,
        }
    }

    #[test]
    fn independent_relay_and_policy_counters_do_not_cause_false_replay() {
        let mut policy = NotificationPolicy::default();
        let connected = event(
            EventKind::DeviceConnected,
            Provenance::AuthenticatedRelay,
            99,
            100_000,
        );
        let approval = event(
            EventKind::ApprovalRequired,
            Provenance::LocalPolicyBroker,
            1,
            100_001,
        );
        let unknown = event(
            EventKind::LocalStatusUnknown,
            Provenance::LocalAgentTransport,
            2,
            100_002,
        );
        assert!(policy.accept(&connected, 100_000).unwrap().is_some());
        assert!(policy.accept(&approval, 100_001).unwrap().is_some());
        let message = policy.accept(&unknown, 100_002).unwrap().unwrap();
        assert!(message.title.contains("status unknown"));
        assert!(!message.title.contains("disconnected"));
        assert_eq!(policy.accept(&approval, 100_003), Err(Reject::Replay));
    }

    #[test]
    fn unknown_does_not_require_a_relay_confirmed_offline_event() {
        let mut policy = NotificationPolicy::default();
        let incorrect = event(
            EventKind::LocalStatusUnknown,
            Provenance::ConfirmedRelayOffline,
            1,
            100_000,
        );
        assert_eq!(
            policy.accept(&incorrect, 100_000),
            Err(Reject::UntrustedSource)
        );
        let valid = event(
            EventKind::LocalStatusUnknown,
            Provenance::LocalAgentTransport,
            1,
            100_001,
        );
        let msg = policy.accept(&valid, 100_001).unwrap().unwrap();
        assert!(msg.body.contains("unverified"));
        let repeated = event(
            EventKind::LocalStatusUnknown,
            Provenance::LocalAgentTransport,
            2,
            100_002,
        );
        assert_eq!(policy.accept(&repeated, 100_002), Ok(None));
    }
}
