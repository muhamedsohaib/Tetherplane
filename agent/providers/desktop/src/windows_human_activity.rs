use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use tether_core::{CapabilityError, ErrorCode};
use winsafe::{GetLastInputInfo, GetTickCount64, HWND};

use crate::{ForegroundWindowIdentity, HumanActivityMonitor, HumanActivitySnapshot};

#[derive(Clone, Copy, Debug, Default)]
pub struct WindowsHumanActivityMonitor;

impl HumanActivityMonitor for WindowsHumanActivityMonitor {
    fn snapshot(&self) -> Result<HumanActivitySnapshot, CapabilityError> {
        let last_input = GetLastInputInfo().map_err(|error| CapabilityError {
            code: ErrorCode::ProviderFailure,
            message: format!("failed to read Windows last-input state: {error}"),
            recovery_hint: None,
            details: serde_json::Value::Null,
        })?;

        let tick_bytes = GetTickCount64().to_le_bytes();
        let now_low =
            u32::from_le_bytes([tick_bytes[0], tick_bytes[1], tick_bytes[2], tick_bytes[3]]);
        let idle_for_ms = u64::from(now_low.wrapping_sub(last_input.dwTime));
        let foreground_window = HWND::GetForegroundWindow().map(|hwnd| foreground_identity(&hwnd));

        Ok(HumanActivitySnapshot {
            idle_for_ms,
            foreground_window,
        })
    }
}

fn foreground_identity(hwnd: &HWND) -> ForegroundWindowIdentity {
    let (thread_id, process_id) = hwnd.GetWindowThreadProcessId();
    let mut hasher = DefaultHasher::new();
    process_id.hash(&mut hasher);
    thread_id.hash(&mut hasher);
    hwnd.to_string().hash(&mut hasher);

    ForegroundWindowIdentity {
        process_id,
        opaque_window_id: format!("fg_{:016x}", hasher.finish()),
    }
}
