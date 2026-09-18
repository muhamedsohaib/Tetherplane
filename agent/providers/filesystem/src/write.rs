use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tempfile::NamedTempFile;
use tether_core::{CapabilityError, ErrorCode};

use crate::{invalid_arguments, io_error};

pub(crate) fn write(arguments: &Value) -> Result<Value, CapabilityError> {
    let path = path_argument(arguments, "path")?;
    let content = content_argument(arguments)?;
    let parent = existing_parent(&path)?;

    let mut temp = NamedTempFile::new_in(parent).map_err(|error| io_error(&path, error))?;
    temp.write_all(content.as_bytes())
        .map_err(|error| io_error(&path, error))?;
    temp.flush().map_err(|error| io_error(&path, error))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| io_error(&path, error))?;
    temp.persist(&path)
        .map_err(|error| io_error(&path, error.error))?;

    Ok(json!({
        "path": path.to_string_lossy(),
        "bytes": content.len(),
        "mode": "write",
    }))
}

pub(crate) fn append(arguments: &Value) -> Result<Value, CapabilityError> {
    let path = path_argument(arguments, "path")?;
    let content = content_argument(arguments)?;
    existing_parent(&path)?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| io_error(&path, error))?;
    file.write_all(content.as_bytes())
        .map_err(|error| io_error(&path, error))?;
    file.flush().map_err(|error| io_error(&path, error))?;

    Ok(json!({
        "path": path.to_string_lossy(),
        "bytes": content.len(),
        "mode": "append",
    }))
}

pub(crate) fn mkdir(arguments: &Value) -> Result<Value, CapabilityError> {
    let path = path_argument(arguments, "path")?;
    existing_parent(&path)?;
    fs::create_dir(&path).map_err(|error| io_error(&path, error))?;

    Ok(json!({
        "path": path.to_string_lossy(),
        "created": true,
    }))
}

pub(crate) fn move_path(arguments: &Value) -> Result<Value, CapabilityError> {
    let source = path_argument(arguments, "source")?;
    let destination = path_argument(arguments, "destination")?;
    existing_parent(&destination)?;

    let replace = match arguments.get("replace") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err(invalid_arguments("replace must be a boolean")),
    };

    if destination.exists() && !replace {
        return Err(CapabilityError {
            code: ErrorCode::PreconditionFailed,
            message: "destination already exists".into(),
            recovery_hint: Some("set replace=true only when replacement is intended".into()),
            details: json!({
                "destination": destination.to_string_lossy(),
                "reason": "destination_exists",
            }),
        });
    }

    if destination.exists() {
        remove_existing(&destination)?;
    }

    fs::rename(&source, &destination).map_err(|error| io_error(&source, error))?;

    Ok(json!({
        "source": source.to_string_lossy(),
        "destination": destination.to_string_lossy(),
        "replaced": replace,
    }))
}

fn remove_existing(path: &Path) -> Result<(), CapabilityError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(path, error))?;
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| io_error(path, error))
    } else {
        fs::remove_file(path).map_err(|error| io_error(path, error))
    }
}

fn existing_parent(path: &Path) -> Result<&Path, CapabilityError> {
    let parent = path
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| CapabilityError {
            code: ErrorCode::InvalidArguments,
            message: "parent directory does not exist".into(),
            recovery_hint: None,
            details: json!({
                "path": path.to_string_lossy(),
                "parent": path.parent().map(|parent| parent.to_string_lossy()),
                "reason": "parent_missing",
            }),
        })?;
    Ok(parent)
}

fn path_argument(arguments: &Value, key: &str) -> Result<PathBuf, CapabilityError> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a path string")))
}

fn content_argument(arguments: &Value) -> Result<&str, CapabilityError> {
    arguments
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_arguments("content must be a string"))
}
