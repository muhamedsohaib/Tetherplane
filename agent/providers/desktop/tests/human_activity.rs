use std::sync::Mutex;

use tether_core::ErrorCode;
use tether_desktop_provider::{
    ForegroundWindowIdentity, HumanActivityMonitor, HumanActivitySnapshot, require_human_idle,
};

struct FakeMonitor {
    snapshot: Mutex<HumanActivitySnapshot>,
}

impl FakeMonitor {
    fn new(snapshot: HumanActivitySnapshot) -> Self {
        Self {
            snapshot: Mutex::new(snapshot),
        }
    }
}

impl HumanActivityMonitor for FakeMonitor {
    fn snapshot(&self) -> Result<HumanActivitySnapshot, tether_core::CapabilityError> {
        Ok(self
            .snapshot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }
}

#[test]
fn quiet_gate_rejects_recent_human_input_without_exposing_raw_events() {
    let monitor = FakeMonitor::new(HumanActivitySnapshot {
        idle_for_ms: 250,
        foreground_window: Some(ForegroundWindowIdentity {
            process_id: 1234,
            opaque_window_id: "foreground_a".into(),
        }),
    });

    let error = require_human_idle(&monitor, 1_500).unwrap_err();

    assert_eq!(error.code, ErrorCode::HumanActivityConflict);
    assert_eq!(error.details["idle_for_ms"], 250);
    assert_eq!(error.details["required_idle_ms"], 1_500);
    assert_eq!(error.details["foreground_process_id"], 1234);
    assert!(error.details.get("key").is_none());
    assert!(error.details.get("mouse").is_none());
    assert!(error.details.get("coordinates").is_none());
}

#[test]
fn quiet_gate_allows_foreground_work_after_required_idle_interval() {
    let monitor = FakeMonitor::new(HumanActivitySnapshot {
        idle_for_ms: 5_000,
        foreground_window: Some(ForegroundWindowIdentity {
            process_id: 1234,
            opaque_window_id: "foreground_a".into(),
        }),
    });

    let snapshot = require_human_idle(&monitor, 1_500).unwrap();

    assert_eq!(snapshot.idle_for_ms, 5_000);
    assert_eq!(
        snapshot
            .foreground_window
            .as_ref()
            .map(|window| window.opaque_window_id.as_str()),
        Some("foreground_a")
    );
}

#[test]
fn foreground_identity_can_detect_window_change_without_window_title_or_geometry() {
    let first = HumanActivitySnapshot {
        idle_for_ms: 3_000,
        foreground_window: Some(ForegroundWindowIdentity {
            process_id: 100,
            opaque_window_id: "foreground_1".into(),
        }),
    };
    let changed = HumanActivitySnapshot {
        idle_for_ms: 3_000,
        foreground_window: Some(ForegroundWindowIdentity {
            process_id: 100,
            opaque_window_id: "foreground_2".into(),
        }),
    };

    assert_ne!(first.foreground_window, changed.foreground_window);
}

#[cfg(windows)]
#[test]
fn windows_monitor_returns_only_bounded_last_input_and_foreground_identity() {
    use tether_desktop_provider::WindowsHumanActivityMonitor;

    let snapshot = WindowsHumanActivityMonitor
        .snapshot()
        .expect("Windows activity snapshot should succeed");

    if let Some(window) = snapshot.foreground_window {
        assert!(window.process_id > 0);
        assert!(window.opaque_window_id.starts_with("fg_"));
        assert_eq!(window.opaque_window_id.len(), 19);
    }
}

#[cfg(windows)]
#[test]
fn windows_monitor_source_does_not_capture_keys_mouse_coordinates_or_event_hooks() {
    let source = include_str!("../src/windows_human_activity.rs");

    for forbidden in [
        "GetAsyncKeyState",
        "GetKeyState",
        "GetCursorPos",
        "GetPhysicalCursorPos",
        "SetWindowsHookEx",
        "RawInput",
        "GetWindowText",
    ] {
        assert!(
            !source.contains(forbidden),
            "human-activity monitor must not capture detailed human input: {forbidden}"
        );
    }
}
