use tether_core::{CapabilityError, ErrorCode};
use uiautomation::inputs::Mouse;
use uiautomation::types::Point;

use crate::{DesktopPoint, PhysicalDesktopExecutor, PhysicalMoveOutcome};

#[derive(Clone, Copy, Debug, Default)]
pub struct WindowsPhysicalDesktopExecutor;

impl PhysicalDesktopExecutor for WindowsPhysicalDesktopExecutor {
    fn capture_cursor(&self) -> Result<DesktopPoint, CapabilityError> {
        let point = Mouse::get_cursor_pos().map_err(|error| physical_error(&error))?;
        Ok(DesktopPoint {
            x: point.get_x(),
            y: point.get_y(),
        })
    }

    fn pointer_move(&self, target: DesktopPoint) -> Result<PhysicalMoveOutcome, CapabilityError> {
        Mouse::set_cursor_pos(&Point::new(target.x, target.y))
            .map_err(|error| physical_error(&error))?;
        let observed = self.capture_cursor()?;
        Ok(PhysicalMoveOutcome {
            position: observed,
            verified: observed == target,
        })
    }

    fn restore_cursor(&self, target: DesktopPoint) -> Result<(), CapabilityError> {
        Mouse::set_cursor_pos(&Point::new(target.x, target.y))
            .map_err(|error| physical_error(&error))
    }
}

fn physical_error(error: &uiautomation::Error) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ProviderFailure,
        message: format!("Windows physical desktop fallback failed: {error}"),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}
