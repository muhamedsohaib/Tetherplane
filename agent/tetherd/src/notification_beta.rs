//! Explicitly opt-in in-process Windows developer-beta notification consumer.
//! No IPC, no new outbound connection, no access to command or approval APIs.
//! This thread is never started by the default agent configuration.
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::time::{SystemTime, UNIX_EPOCH};

use tether_notifications::windows_native;
use tether_notifications::{Event, Notification, NotificationPolicy};

const QUEUE_CAPACITY: usize = 64;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn consume<F: FnMut(&Notification)>(rx: &Receiver<Event>, mut present: F) {
    let mut policy = NotificationPolicy::default();
    while let Ok(event) = rx.recv() {
        if let Ok(Some(notice)) = policy.accept(&event, now_ms()) {
            present(&notice);
        }
    }
}

/// Start a bounded, disposable user-session presenter.
/// Must be invoked only for an explicitly opted-in relay agent.
///
/// # Errors
/// Returns a thread startup error; it does not modify the existing agent.
pub(crate) fn start() -> Result<SyncSender<Event>, String> {
    let (tx, rx) = sync_channel(QUEUE_CAPACITY);
    std::thread::Builder::new()
        .name("tetherplane-toast-beta".into())
        .spawn(move || {
            let mut last_delivery_failed = false;
            consume(&rx, |notice| match windows_native::show_dev_beta(notice) {
                Ok(()) => last_delivery_failed = false,
                Err(_) => {
                    if !last_delivery_failed {
                        eprintln!(
                            "developer-beta notifications unavailable; existing agent connectivity unaffected"
                        );
                        last_delivery_failed = true;
                    }
                }
            });
        })
        .map_err(|error| format!("failed to start developer-beta notification thread: {error}"))?;
    Ok(tx)
}

/// Return a sender only when the human explicitly opted in on a user-session agent.
/// No notification thread is created in default mode.
///
/// # Errors
/// Propagates a thread startup failure without changing the existing agent.
pub(crate) fn optional(enabled: bool) -> Result<Option<SyncSender<Event>>, String> {
    if enabled { start().map(Some) } else { Ok(None) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tether_notifications::{EventKind, Provenance};

    fn event(kind: EventKind, provenance: Provenance, sequence: u64) -> Event {
        Event {
            kind,
            provenance,
            device_id: "Leno".into(),
            source_epoch: "verified-test-epoch".into(),
            sequence,
            observed_at_ms: now_ms(),
            request_id: None,
        }
    }

    #[test]
    fn consumer_filters_untrusted_and_replayed_events_without_actions() {
        let (tx, rx) = sync_channel(8);
        tx.send(event(EventKind::DeviceConnected, Provenance::LocalSetup, 1))
            .unwrap();
        tx.send(event(
            EventKind::DeviceConnected,
            Provenance::AuthenticatedRelay,
            1,
        ))
        .unwrap();
        tx.send(event(
            EventKind::DeviceConnected,
            Provenance::AuthenticatedRelay,
            1,
        ))
        .unwrap();
        tx.send(event(
            EventKind::LocalStatusUnknown,
            Provenance::LocalAgentTransport,
            2,
        ))
        .unwrap();
        drop(tx);
        let mut titles = Vec::new();
        consume(&rx, |notice| titles.push(notice.title.clone()));
        assert_eq!(titles, vec!["Leno connected", "Leno status unknown"]);
    }

    #[test]
    fn closed_consumer_channel_exits() {
        let (tx, rx) = sync_channel(1);
        drop(tx);
        let mut times_called = 0;
        consume(&rx, |_| times_called += 1);
        assert_eq!(times_called, 0);
    }
}
