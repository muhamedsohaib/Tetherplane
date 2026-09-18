use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tether_core::{CapabilityError, ResponseBudget, ResponseMode};

use crate::{invalid_arguments, io_error};

pub(crate) fn read(arguments: &Value, mode: ResponseMode) -> Result<Value, CapabilityError> {
    let path = path_argument(arguments, "path")?;
    read_path(&path, arguments, mode)
}

pub(crate) fn read_many(arguments: &Value, mode: ResponseMode) -> Result<Value, CapabilityError> {
    let paths = arguments
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_arguments("paths must be an array"))?;

    let mut entries = Vec::with_capacity(paths.len());
    for raw_path in paths {
        let Some(raw_path) = raw_path.as_str() else {
            entries.push(json!({
                "status": "error",
                "error": {
                    "code": "invalid_arguments",
                    "message": "path entry must be a string"
                }
            }));
            continue;
        };

        let path = PathBuf::from(raw_path);
        match read_path(&path, arguments, mode.clone()) {
            Ok(mut data) => {
                if let Some(object) = data.as_object_mut() {
                    object.insert("status".into(), Value::String("success".into()));
                }
                entries.push(data);
            }
            Err(error) => {
                entries.push(json!({
                    "path": raw_path,
                    "status": "error",
                    "error": error,
                }));
            }
        }
    }

    Ok(json!({ "entries": entries }))
}

fn read_path(path: &Path, arguments: &Value, mode: ResponseMode) -> Result<Value, CapabilityError> {
    let text = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let total_lines = lines.len();
    let offset = optional_i64(arguments, "offset")?.unwrap_or(0);
    let start_line = if offset >= 0 {
        usize::try_from(offset)
            .unwrap_or(usize::MAX)
            .min(total_lines)
    } else {
        let tail = usize::try_from(offset.unsigned_abs()).unwrap_or(usize::MAX);
        total_lines.saturating_sub(tail)
    };

    let length = optional_usize(arguments, "length")?;
    let end_line = length
        .map(|length| start_line.saturating_add(length).min(total_lines))
        .unwrap_or(total_lines);
    let selected = lines[start_line..end_line].concat();

    let budget = ResponseBudget::for_mode(mode);
    let bounded = budget.apply_text(&selected, 0)?;
    let continuation = if let Some(cursor) = bounded.continuation {
        Some(json!({
            "kind": "byte",
            "offset": cursor.offset,
            "start_line": start_line,
        }))
    } else if end_line < total_lines {
        Some(json!({
            "kind": "line",
            "offset": end_line,
        }))
    } else {
        None
    };

    let lines_returned = bounded.content.lines().count();

    Ok(json!({
        "path": path.to_string_lossy(),
        "content": bounded.content,
        "start_line": start_line,
        "lines_returned": lines_returned,
        "total_lines": total_lines,
        "truncated": continuation.is_some(),
        "continuation": continuation,
    }))
}

fn path_argument(arguments: &Value, key: &str) -> Result<PathBuf, CapabilityError> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a path string")))
}

fn optional_i64(arguments: &Value, key: &str) -> Result<Option<i64>, CapabilityError> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| invalid_arguments(&format!("{key} must be an integer"))),
    }
}

fn optional_usize(arguments: &Value, key: &str) -> Result<Option<usize>, CapabilityError> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let raw = value.as_u64().ok_or_else(|| {
                invalid_arguments(&format!("{key} must be a non-negative integer"))
            })?;
            usize::try_from(raw)
                .map(Some)
                .map_err(|_| invalid_arguments(&format!("{key} is too large")))
        }
    }
}
