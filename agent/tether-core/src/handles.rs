use std::collections::HashMap;
use std::sync::RwLock;

use serde_json::Value;
use uuid::Uuid;

use crate::{CapabilityError, ErrorCode};

pub struct HandleRegistry<T> {
    values: RwLock<HashMap<String, T>>,
}

impl<T> HandleRegistry<T> {
    #[must_use]
    pub fn new() -> Self {
        Self {
            values: RwLock::new(HashMap::new()),
        }
    }

    pub fn insert(&self, kind: &'static str, value: T) -> String {
        let handle = format!("{kind}_{}", Uuid::new_v4().simple());
        let mut values = self
            .values
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        values.insert(handle.clone(), value);
        handle
    }

    /// Accesses the value for `handle` through the provided function.
    ///
    /// # Errors
    ///
    /// Returns a capability error when the handle is unknown or has expired.
    pub fn with<R>(&self, handle: &str, f: impl FnOnce(&T) -> R) -> Result<R, CapabilityError> {
        let values = self
            .values
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let value = values.get(handle).ok_or_else(|| CapabilityError {
            code: ErrorCode::InvalidArguments,
            message: "unknown or expired handle".to_owned(),
            recovery_hint: None,
            details: Value::Null,
        })?;
        Ok(f(value))
    }

    pub fn remove(&self, handle: &str) -> Option<T> {
        self.values
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(handle)
    }
}

impl<T> Default for HandleRegistry<T> {
    fn default() -> Self {
        Self::new()
    }
}
