use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tempfile::NamedTempFile;
use tether_core::{CapabilityError, ErrorCode};

use crate::{invalid_arguments, io_error};

pub(crate) fn patch(arguments: &Value) -> Result<Value, CapabilityError> {
    let path = path_argument(arguments, "path")?;
    let old = string_argument(arguments, "old")?;
    let new = string_argument(arguments, "new")?;
    let expected = expected_replacements(arguments)?;

    if old.is_empty() {
        return Err(invalid_arguments("old must not be empty"));
    }

    let current = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
    let matches: Vec<usize> = current
        .match_indices(old)
        .map(|(offset, _)| offset)
        .collect();

    if matches.len() != expected {
        return Err(CapabilityError {
            code: ErrorCode::PreconditionFailed,
            message: format!(
                "expected {expected} exact replacements but found {}",
                matches.len()
            ),
            recovery_hint: Some("re-read the file before retrying the patch".into()),
            details: json!({
                "path": path.to_string_lossy(),
                "expected_replacements": expected,
                "actual_replacements": matches.len(),
                "reason": "replacement_count_mismatch",
            }),
        });
    }

    let changes: Vec<Value> = matches
        .iter()
        .map(|start| {
            let end = start.saturating_add(old.len());
            json!({
                "start_byte": start,
                "end_byte": end,
                "start_line": line_at(&current, *start),
                "end_line": line_at(&current, end),
            })
        })
        .collect();

    let replaced = current.replace(old, new);
    atomic_replace(&path, &replaced)?;

    Ok(json!({
        "path": path.to_string_lossy(),
        "replacements": expected,
        "changes": changes,
    }))
}

fn atomic_replace(path: &Path, content: &str) -> Result<(), CapabilityError> {
    let parent = path
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| CapabilityError {
            code: ErrorCode::InvalidArguments,
            message: "parent directory does not exist".into(),
            recovery_hint: None,
            details: json!({
                "path": path.to_string_lossy(),
                "reason": "parent_missing",
            }),
        })?;

    let mut temp = NamedTempFile::new_in(parent).map_err(|error| io_error(path, error))?;
    temp.write_all(content.as_bytes())
        .map_err(|error| io_error(path, error))?;
    temp.flush().map_err(|error| io_error(path, error))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| io_error(path, error))?;
    temp.persist(path)
        .map_err(|error| io_error(path, error.error))?;
    Ok(())
}

fn line_at(content: &str, byte_offset: usize) -> usize {
    content.as_bytes()[..byte_offset.min(content.len())]
        .iter()
        .filter(|byte| **byte == b'\n')
        .count()
}

fn path_argument(arguments: &Value, key: &str) -> Result<PathBuf, CapabilityError> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a path string")))
}

fn string_argument<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, CapabilityError> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a string")))
}

fn expected_replacements(arguments: &Value) -> Result<usize, CapabilityError> {
    let raw = arguments
        .get("expected_replacements")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid_arguments("expected_replacements must be a non-negative integer"))?;
    usize::try_from(raw).map_err(|_| invalid_arguments("expected_replacements is too large"))
}
