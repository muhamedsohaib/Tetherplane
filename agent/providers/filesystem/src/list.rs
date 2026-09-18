use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{Value, json};
use tether_core::CapabilityError;

use crate::{invalid_arguments, io_error};

pub(crate) fn list(arguments: &Value) -> Result<Value, CapabilityError> {
    let root = path_argument(arguments, "path")?;
    let depth = optional_usize(arguments, "depth")?.unwrap_or(1);
    let metadata = fs::metadata(&root).map_err(|error| io_error(&root, error))?;
    if !metadata.is_dir() {
        return Err(invalid_arguments(
            "filesystem.list path must be a directory",
        ));
    }

    let mut entries = Vec::new();
    walk(&root, &root, 1, depth, &mut entries)?;
    entries.sort_by(|left, right| {
        left["relative_path"]
            .as_str()
            .cmp(&right["relative_path"].as_str())
    });

    Ok(json!({
        "path": root.to_string_lossy(),
        "depth": depth,
        "entries": entries,
    }))
}

pub(crate) fn info(arguments: &Value) -> Result<Value, CapabilityError> {
    let path = path_argument(arguments, "path")?;
    let metadata = fs::metadata(&path).map_err(|error| io_error(&path, error))?;
    let modified = metadata
        .modified()
        .map_err(|error| io_error(&path, error))?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| invalid_arguments("modified time predates the Unix epoch"))?;

    let line_count = if metadata.is_file() {
        fs::read_to_string(&path)
            .ok()
            .map(|contents| contents.lines().count())
    } else {
        None
    };

    Ok(json!({
        "path": path.to_string_lossy(),
        "type": metadata_type(&metadata),
        "size": metadata.len(),
        "modified_time": format!("{}.{:09}", modified.as_secs(), modified.subsec_nanos()),
        "modified_unix_ms": modified.as_millis(),
        "line_count": line_count,
    }))
}

fn walk(
    root: &Path,
    current: &Path,
    current_depth: usize,
    max_depth: usize,
    entries: &mut Vec<Value>,
) -> Result<(), CapabilityError> {
    if current_depth > max_depth {
        return Ok(());
    }

    let read_dir = fs::read_dir(current).map_err(|error| io_error(current, error))?;
    let mut children = read_dir
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| io_error(current, error))?;
    children.sort_by_key(fs::DirEntry::file_name);

    for child in children {
        let path = child.path();
        let file_type = child.file_type().map_err(|error| io_error(&path, error))?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| invalid_arguments("listed entry escaped the requested root"))?;

        entries.push(json!({
            "relative_path": relative.to_string_lossy().replace('\\', "/"),
            "type": file_type_name(&file_type),
            "depth": current_depth,
        }));

        if file_type.is_dir() {
            walk(
                root,
                &path,
                current_depth.saturating_add(1),
                max_depth,
                entries,
            )?;
        }
    }

    Ok(())
}

fn metadata_type(metadata: &fs::Metadata) -> &'static str {
    if metadata.is_file() {
        "file"
    } else if metadata.is_dir() {
        "directory"
    } else if metadata.file_type().is_symlink() {
        "symlink"
    } else {
        "other"
    }
}

fn file_type_name(file_type: &fs::FileType) -> &'static str {
    if file_type.is_file() {
        "file"
    } else if file_type.is_dir() {
        "directory"
    } else if file_type.is_symlink() {
        "symlink"
    } else {
        "other"
    }
}

fn path_argument(arguments: &Value, key: &str) -> Result<PathBuf, CapabilityError> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a path string")))
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
