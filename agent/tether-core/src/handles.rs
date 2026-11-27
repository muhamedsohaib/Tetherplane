use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::{CapabilityError, ErrorCode};

/// Default sliding time-to-live for handles. Every successful access
/// refreshes the deadline; handles idle longer than this fail as
/// unknown. A day bounds leak lifetime without disturbing long-lived
/// human-coexistence sessions that touch their handles regularly.
const DEFAULT_HANDLE_TTL: Duration = Duration::from_hours(24);

struct HandleEntry<T> {
    value: T,
    last_access: Instant,
}

pub struct HandleRegistry<T> {
    values: RwLock<HashMap<String, HandleEntry<T>>>,
    ttl: Duration,
}

impl<T> HandleRegistry<T> {
    #[must_use]
    pub fn new() -> Self {
        Self::with_ttl(DEFAULT_HANDLE_TTL)
    }

    #[must_use]
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            values: RwLock::new(HashMap::new()),
            ttl,
        }
    }

    pub fn insert(&self, kind: &'static str, value: T) -> String {
        let handle = format!("{kind}_{}", Uuid::new_v4().simple());
        let mut values = self
            .values
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Self::sweep_locked(&mut values, self.ttl);
        values.insert(
            handle.clone(),
            HandleEntry {
                value,
                last_access: Instant::now(),
            },
        );
        handle
    }

    /// Accesses the value for `handle` through the provided function.
    ///
    /// A successful access slides the expiry deadline forward. Expired
    /// handles are evicted and reported exactly like unknown ones, so
    /// stale handles fail without leaking their entries.
    ///
    /// # Errors
    ///
    /// Returns a capability error when the handle is unknown or has expired.
    pub fn with<R>(&self, handle: &str, f: impl FnOnce(&T) -> R) -> Result<R, CapabilityError> {
        let mut values = self
            .values
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = values.get_mut(handle).ok_or_else(unknown_handle)?;
        if entry.last_access.elapsed() >= self.ttl {
            values.remove(handle);
            return Err(unknown_handle());
        }
        entry.last_access = Instant::now();
        Ok(f(&entry.value))
    }

    pub fn remove(&self, handle: &str) -> Option<T> {
        let mut values = self
            .values
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = values.get(handle)?;
        if entry.last_access.elapsed() >= self.ttl {
            values.remove(handle);
            return None;
        }
        values.remove(handle).map(|entry| entry.value)
    }

    /// Live entry count after sweeping expired handles. Expired entries
    /// are garbage, never members, so the sweep keeps the count honest.
    #[must_use]
    pub fn len(&self) -> usize {
        let mut values = self
            .values
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Self::sweep_locked(&mut values, self.ttl);
        values.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn sweep_locked(values: &mut HashMap<String, HandleEntry<T>>, ttl: Duration) {
        values.retain(|_, entry| entry.last_access.elapsed() < ttl);
    }
}

impl<T> Default for HandleRegistry<T> {
    fn default() -> Self {
        Self::new()
    }
}

fn unknown_handle() -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: "unknown or expired handle".to_owned(),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}
