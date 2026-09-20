#![forbid(unsafe_code)]

#[cfg(test)]
mod filesystem_tests;

mod list;
mod patch;
mod read;
mod write;

use std::io;
use std::path::Path;

use async_trait::async_trait;
use serde_json::json;
use tether_core::{
    CapabilityError, CapabilityProvider, ErrorCode, InvocationEnvelope, ProviderResult,
    VerificationStatus,
};

#[derive(Debug, Default)]
pub struct FilesystemProvider;

impl FilesystemProvider {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

#[async_trait]
impl CapabilityProvider for FilesystemProvider {
    fn namespace(&self) -> &'static str {
        "filesystem"
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let operation = invocation
            .capability
            .strip_prefix("filesystem.")
            .ok_or_else(|| invalid_arguments("capability must use the filesystem namespace"))?;

        let data = match operation {
            "read" => read::read(&invocation.arguments, invocation.response_mode.clone())?,
            "read_many" => read::read_many(&invocation.arguments, &invocation.response_mode)?,
            "list" => list::list(&invocation.arguments)?,
            "info" => list::info(&invocation.arguments)?,
            "write" => write::write(&invocation.arguments)?,
            "append" => write::append(&invocation.arguments)?,
            "mkdir" => write::mkdir(&invocation.arguments)?,
            "move" => write::move_path(&invocation.arguments)?,
            "patch" => patch::patch(&invocation.arguments)?,
            _ => {
                return Err(CapabilityError {
                    code: ErrorCode::CapabilityUnavailable,
                    message: format!("filesystem operation is unavailable: {operation}"),
                    recovery_hint: None,
                    details: json!({ "operation": operation }),
                });
            }
        };

        Ok(ProviderResult {
            data,
            delta: None,
            verification: VerificationStatus::NotApplicable,
        })
    }
}

pub(crate) fn invalid_arguments(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}

pub(crate) fn io_error(path: &Path, error: &io::Error) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ProviderFailure,
        message: error.to_string(),
        recovery_hint: None,
        details: json!({
            "path": path.to_string_lossy(),
            "io_kind": io_kind(error.kind()),
        }),
    }
}

fn io_kind(kind: io::ErrorKind) -> &'static str {
    match kind {
        io::ErrorKind::NotFound => "not_found",
        io::ErrorKind::PermissionDenied => "permission_denied",
        io::ErrorKind::AlreadyExists => "already_exists",
        io::ErrorKind::InvalidInput => "invalid_input",
        io::ErrorKind::InvalidData => "invalid_data",
        io::ErrorKind::TimedOut => "timed_out",
        io::ErrorKind::UnexpectedEof => "unexpected_eof",
        _ => "other",
    }
}

pub const CRATE_NAME: &str = "tether-filesystem-provider";
