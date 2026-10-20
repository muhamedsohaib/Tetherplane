use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use cap_std::fs::{Dir, OpenOptions};
use cap_std::ambient_authority;
use serde_json::{Value, json};
use tether_core::{CapabilityError, ErrorCode};
use uuid::Uuid;

use crate::{invalid_arguments, io_error};

/// Effective principal AND agent root opened as a durable directory capability.
pub(crate) struct CopyRoot {
    absolute: PathBuf,
    handle: Dir,
}

pub(crate) fn open_copy_roots(
    agent_roots: &[PathBuf],
    principal_roots: Option<&[PathBuf]>,
) -> Result<Vec<CopyRoot>, CapabilityError> {
    let mut effective = BTreeSet::new();
    let canonical = |path: &Path| {
        fs::canonicalize(path).map_err(|error| io_error(path, &error))
    };
    let agent = agent_roots
        .iter()
        .map(|root| canonical(root))
        .collect::<Result<Vec<_>, _>>()?;

    match principal_roots {
        None => effective.extend(agent),
        Some(allowed) => {
            let principal = allowed
                .iter()
                .map(|root| canonical(root))
                .collect::<Result<Vec<_>, _>>()?;
            // An empty principal root list grants no copy authority.
            for agent_root in &agent {
                for principal_root in &principal {
                    if principal_root.starts_with(agent_root) {
                        effective.insert(principal_root.clone());
                    } else if agent_root.starts_with(principal_root) {
                        effective.insert(agent_root.clone());
                    }
                }
            }
        }
    }

    let mut result = Vec::with_capacity(effective.len());
    for absolute in effective {
        let handle = Dir::open_ambient_dir(&absolute, ambient_authority())
            .map_err(|error| io_error(&absolute, &error))?;
        result.push(CopyRoot { absolute, handle });
    }
    Ok(result)
}

fn located<'a>(
    roots: &'a [CopyRoot],
    path: &Path,
) -> Result<(&'a Dir, PathBuf), CapabilityError> {
    // The policy has already authorized the caller's paths. Absolute,
    // traversal-free paths also prevent ambiguity in the handle-relative layer.
    if !path.is_absolute()
        || path
            .components()
            .any(|component| component == Component::ParentDir)
    {
        return Err(copy_denied());
    }
    for root in roots {
        if let Ok(relative) = path.strip_prefix(&root.absolute) {
            if relative.file_name().is_some() {
                return Ok((&root.handle, relative.to_path_buf()));
            }
        }
    }
    Err(copy_denied())
}

fn copy_denied() -> CapabilityError {
    CapabilityError {
        code: ErrorCode::PermissionDenied,
        message: "copy path is outside the effective authorized directories".into(),
        recovery_hint: None,
        details: json!({}),
    }
}

pub(crate) fn copy(
    roots: &[CopyRoot],
    arguments: &Value,
) -> Result<Value, CapabilityError> {
    let source = path_argument(arguments, "source")?;
    let destination = path_argument(arguments, "destination")?;

    if arguments.get("replace").is_some() {
        return Err(invalid_arguments(
            "filesystem.copy never replaces an existing path",
        ));
    }

    let (source_dir, source_relative) = located(roots, &source)?;
    let (destination_root, destination_relative) = located(roots, &destination)?;

    // All subsequent I/O uses directory-relative capability handles.
    // cap-std prevents symlinks and Windows reparse points from escaping the
    // opened directory root, even when a path changes between checks.
    let source_type = source_dir
        .symlink_metadata(&source_relative)
        .map_err(|error| io_error(&source, &error))?
        .file_type();
    if !source_type.is_file() {
        return Err(invalid_arguments("source must be a regular file"));
    }

    let mut input = source_dir
        .open(&source_relative)
        .map_err(|error| io_error(&source, &error))?;
    if !input
        .metadata()
        .map_err(|error| io_error(&source, &error))?
        .is_file()
    {
        return Err(invalid_arguments("source must be a regular file"));
    }

    let parent_relative = destination_relative
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let destination_dir = destination_root
        .open_dir(parent_relative)
        .map_err(|error| io_error(&destination, &error))?;
    let filename = destination_relative
        .file_name()
        .ok_or_else(|| invalid_arguments("destination must be a file path"))?;

    // Stage entirely inside the verified directory handle, then publish with
    // an atomic no-replace hard link. Only the completed file becomes visible
    // at the requested destination. Source and destination may be on separate
    // devices/volumes because the staging file is created beside the target.
    let staging_name = format!(".tetherplane-copy-{}.partial", Uuid::new_v4().simple());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let mut staged = destination_dir
        .open_with(&staging_name, &options)
        .map_err(|error| io_error(&destination, &error))?;

    let prepare_result = (|| {
        let count = std::io::copy(&mut input, &mut staged)
            .map_err(|error| io_error(&destination, &error))?;
        staged
            .sync_all()
            .map_err(|error| io_error(&destination, &error))?;
        Ok::<u64, CapabilityError>(count)
    })();
    drop(staged);

    let result = match prepare_result {
        Ok(bytes) => {
            destination_dir
                .hard_link(&staging_name, &destination_dir, filename)
                .map_err(|error| {
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        CapabilityError {
                            code: ErrorCode::PreconditionFailed,
                            message: "destination already exists".into(),
                            recovery_hint: Some(
                                "choose a new destination; copy does not replace files".into(),
                            ),
                            details: json!({
                                "destination": destination.to_string_lossy(),
                                "reason": "destination_exists",
                            }),
                        }
                    } else {
                        io_error(&destination, &error)
                    }
                })
                .map(|()| bytes)
        }
        Err(error) => Err(error),
    };

    // Remove only this operation's randomized staging file, never existing
    // user files. A cleanup failure must not be reported as a verified copy.
    destination_dir
        .remove_file(&staging_name)
        .map_err(|error| io_error(&destination, &error))?;
    let bytes = result?;

    Ok(json!({
        "source": source.to_string_lossy(),
        "destination": destination.to_string_lossy(),
        "bytes": bytes,
        "replaced": false,
    }))
}

fn path_argument(arguments: &Value, key: &str) -> Result<PathBuf, CapabilityError> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a path string")))
}
