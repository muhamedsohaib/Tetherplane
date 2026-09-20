use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tether_core::{CapabilityError, ErrorCode};

const MAX_PRIVATE_CLIPBOARD_TEXT_BYTES: usize = 1024 * 1024;
const MAX_PRIVATE_CLIPBOARD_FILES: usize = 64;
const MAX_PRIVATE_CLIPBOARD_FILE_BYTES: usize = 4096;

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct PrivateClipboardState {
    pub revision: u64,
    pub text: Option<String>,
    pub files: Vec<String>,
}

#[derive(Debug, Default)]
pub struct PrivateClipboard {
    state: Mutex<PrivateClipboardState>,
}

impl PrivateClipboard {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn get(&self) -> PrivateClipboardState {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Replaces the private clipboard contents atomically.
    ///
    /// # Errors
    ///
    /// Returns `invalid_arguments` if text or file references exceed the private clipboard bounds.
    pub fn set(
        &self,
        text: Option<String>,
        files: Vec<String>,
    ) -> Result<PrivateClipboardState, CapabilityError> {
        validate_text(text.as_deref())?;
        validate_files(&files)?;

        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.revision = state.revision.saturating_add(1);
        state.text = text;
        state.files = files;
        Ok(state.clone())
    }
}

pub(crate) fn parse_clipboard_set(
    arguments: &Value,
) -> Result<(Option<String>, Vec<String>), CapabilityError> {
    let text = match arguments.get("text") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.clone()),
        Some(_) => return Err(invalid_arguments("text must be a string or null")),
    };

    let files = match arguments.get("files") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| invalid_arguments("files must contain only string references"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err(invalid_arguments("files must be an array of strings")),
    };

    Ok((text, files))
}

fn validate_text(text: Option<&str>) -> Result<(), CapabilityError> {
    if text.is_some_and(|value| value.len() > MAX_PRIVATE_CLIPBOARD_TEXT_BYTES) {
        return Err(invalid_arguments(
            "private clipboard text exceeds 1048576 bytes",
        ));
    }
    Ok(())
}

fn validate_files(files: &[String]) -> Result<(), CapabilityError> {
    if files.len() > MAX_PRIVATE_CLIPBOARD_FILES {
        return Err(invalid_arguments(
            "private clipboard supports at most 64 file references",
        ));
    }

    if files
        .iter()
        .any(|value| value.is_empty() || value.len() > MAX_PRIVATE_CLIPBOARD_FILE_BYTES)
    {
        return Err(invalid_arguments(
            "private clipboard file references must be non-empty and at most 4096 bytes",
        ));
    }
    Ok(())
}

fn invalid_arguments(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
        details: Value::Null,
    }
}
