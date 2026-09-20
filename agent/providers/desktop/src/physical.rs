use serde::{Deserialize, Serialize};
use tether_core::{CapabilityError, ErrorCode};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct DesktopPoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct PhysicalMoveOutcome {
    pub position: DesktopPoint,
    pub verified: bool,
}

pub trait PhysicalDesktopExecutor: Send + Sync {
    /// Reads the current physical cursor position for restoration.
    ///
    /// # Errors
    ///
    /// Returns a provider error when cursor state is unavailable.
    fn capture_cursor(&self) -> Result<DesktopPoint, CapabilityError>;

    /// Moves the physical pointer to one screen coordinate.
    ///
    /// # Errors
    ///
    /// Returns a provider error when the move cannot be executed or observed.
    fn pointer_move(&self, target: DesktopPoint) -> Result<PhysicalMoveOutcome, CapabilityError>;

    /// Restores the physical cursor to a previously captured position.
    ///
    /// # Errors
    ///
    /// Returns a provider error when restoration cannot be completed.
    fn restore_cursor(&self, target: DesktopPoint) -> Result<(), CapabilityError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct DisabledPhysicalDesktopExecutor;

impl PhysicalDesktopExecutor for DisabledPhysicalDesktopExecutor {
    fn capture_cursor(&self) -> Result<DesktopPoint, CapabilityError> {
        Err(unavailable())
    }

    fn pointer_move(&self, _target: DesktopPoint) -> Result<PhysicalMoveOutcome, CapabilityError> {
        Err(unavailable())
    }

    fn restore_cursor(&self, _target: DesktopPoint) -> Result<(), CapabilityError> {
        Err(unavailable())
    }
}

fn unavailable() -> CapabilityError {
    CapabilityError {
        code: ErrorCode::CapabilityUnavailable,
        message: "physical desktop fallback is not installed".into(),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}
