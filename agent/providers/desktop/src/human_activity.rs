use serde::{Deserialize, Serialize};
use serde_json::json;
use tether_core::{CapabilityError, ErrorCode};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ForegroundWindowIdentity {
    pub process_id: u32,
    pub opaque_window_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HumanActivitySnapshot {
    pub idle_for_ms: u64,
    pub foreground_window: Option<ForegroundWindowIdentity>,
}

pub trait HumanActivityMonitor: Send + Sync {
    /// Returns bounded local collision-avoidance state without raw input events.
    ///
    /// # Errors
    ///
    /// Returns a provider error if the operating-system activity state cannot be read.
    fn snapshot(&self) -> Result<HumanActivitySnapshot, CapabilityError>;
}

/// Requires that the local human has been idle for at least the required interval.
///
/// # Errors
///
/// Returns `human_activity_conflict` when recent human activity is detected, or propagates the
/// monitor's machine-readable provider error.
pub fn require_human_idle(
    monitor: &dyn HumanActivityMonitor,
    required_idle_ms: u64,
) -> Result<HumanActivitySnapshot, CapabilityError> {
    let snapshot = monitor.snapshot()?;
    if snapshot.idle_for_ms >= required_idle_ms {
        return Ok(snapshot);
    }

    Err(CapabilityError {
        code: ErrorCode::HumanActivityConflict,
        message: "recent human activity conflicts with foreground desktop automation".into(),
        recovery_hint: Some(
            "retry after the human has been idle or use a background semantic operation".into(),
        ),
        details: json!({
            "idle_for_ms": snapshot.idle_for_ms,
            "required_idle_ms": required_idle_ms,
            "foreground_process_id": snapshot
                .foreground_window
                .as_ref()
                .map(|window| window.process_id),
        }),
    })
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct UnavailableHumanActivityMonitor;

impl HumanActivityMonitor for UnavailableHumanActivityMonitor {
    fn snapshot(&self) -> Result<HumanActivitySnapshot, CapabilityError> {
        Err(CapabilityError {
            code: ErrorCode::CapabilityUnavailable,
            message: "human activity monitor is not installed".into(),
            recovery_hint: None,
            details: serde_json::json!({}),
        })
    }
}
