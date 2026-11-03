//! Compatibility for the Nov 2026 per-user GUI launcher argument-file format.
//! Developer-beta only: never reads the live task's file during tests,
//! never prints values, credentials, paths or the JSON body.
use std::collections::HashSet;
use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 16 * 1024;
const MAX_ARGS: usize = 96;
const REPARSE_POINT: u32 = 0x400;

fn load_json_args(path: &Path) -> Result<Vec<String>, String> {
    if !path.is_absolute() {
        return Err("beta arguments file path must be absolute".into());
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "beta arguments file unavailable".to_string())?;
    if !metadata.file_type().is_file() || metadata.file_attributes() & REPARSE_POINT != 0 {
        return Err("beta arguments file must be a regular, non-reparse-point file".into());
    }
    if metadata.len() > MAX_BYTES {
        return Err("beta arguments file exceeds maximum size".into());
    }
    let bytes = fs::read(path).map_err(|_| "beta arguments file cannot be read".to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("beta arguments file exceeds maximum size".into());
    }
    let arguments: Vec<String> = serde_json::from_slice(&bytes)
        .map_err(|_| "beta arguments file must contain a JSON string array".to_string())?;
    if arguments.is_empty() || arguments.len() > MAX_ARGS {
        return Err("beta arguments file has invalid argument count".into());
    }
    if arguments.iter().any(|arg| {
        arg.is_empty()
            || arg.len() > 2048
            || arg.contains('\0')
            || arg.contains('\r')
            || arg.contains('\n')
    }) {
        return Err("beta arguments file includes invalid argument bytes".into());
    }
    if arguments.iter().any(|arg| arg == "--arguments-file") {
        return Err("nested beta arguments files are prohibited".into());
    }
    // Prevent a writable file from using duplicate critical flags to silently
    // override device identity or authorization-related configuration.
    let mut seen = HashSet::new();
    for arg in &arguments {
        if matches!(
            arg.as_str(),
            "--relay-url"
                | "--device-id"
                | "--device-credential-file"
                | "--principal-profile"
                | "--state-dir"
        ) && !seen.insert(arg.as_str())
        {
            return Err("duplicate security-sensitive beta argument".into());
        }
    }
    Ok(arguments)
}

/// Expand only `--arguments-file ABSOLUTE_JSON`, optionally followed by one
/// explicit opt-in notification flag. No arbitrary overrides are permitted.
///
/// # Errors
/// Rejects nonexistent, malformed, reparse-point, oversized, nested or
/// ambiguous input without exposing any argument values.
pub(crate) fn expand(arguments: Vec<String>) -> Result<Vec<String>, String> {
    if arguments
        .first()
        .is_none_or(|value| value != "--arguments-file")
    {
        if arguments.iter().any(|arg| arg == "--arguments-file") {
            return Err("--arguments-file must be the first argument".into());
        }
        return Ok(arguments);
    }
    let extra_toasts = match arguments.as_slice() {
        [_, _] => false,
        [_, _, extra] if extra == "--dev-beta-local-toasts" => true,
        _ => return Err("beta arguments file mode accepts no command-line overrides".into()),
    };
    let path = PathBuf::from(&arguments[1]);
    let mut loaded = load_json_args(&path)?;
    if extra_toasts {
        if loaded.iter().any(|arg| arg == "--dev-beta-local-toasts") {
            return Err("duplicate developer-beta notification opt-in".into());
        }
        loaded.push("--dev-beta-local-toasts".to_owned());
    }
    Ok(loaded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_file(body: &[u8]) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("tp-beta-arguments-{}.json", uuid::Uuid::new_v4()));
        assert!(!path.exists());
        fs::write(&path, body).expect("write synthetic argument fixture");
        path
    }

    fn expand_file(path: &Path, extra: bool) -> Result<Vec<String>, String> {
        let mut args = vec!["--arguments-file".to_owned(), path.to_string_lossy().into()];
        if extra {
            args.push("--dev-beta-local-toasts".into());
        }
        expand(args)
    }

    #[test]
    fn live_launcher_json_array_shape_expands_with_explicit_beta_flag() {
        let fixture = serde_json::to_vec(&vec![
            "--relay-url",
            "wss://example.test/device",
            "--device-id",
            "SYNTHETIC",
            "--device-credential-file",
            r"C:\fake-not-a-credential.txt",
            "--allow",
            r"C:\synthetic-workspace",
            "--principal-profile",
            r"C:\fake-principal.json",
            "--state-dir",
            r"C:\synthetic-state",
        ])
        .unwrap();
        let file = test_file(&fixture);
        let plain = expand_file(&file, false).unwrap();
        let optional = expand_file(&file, true).unwrap();
        assert_eq!(optional.len(), plain.len() + 1);
        assert_eq!(
            optional.last().map(String::as_str),
            Some("--dev-beta-local-toasts")
        );
        assert_eq!(&optional[..plain.len()], &plain);
        fs::remove_file(file).unwrap();
    }

    #[test]
    fn rejects_malformed_json_oversize_and_nested_files() {
        for data in [
            b"{\"flag\": \"bad\"}".as_slice(),
            b"[\"--arguments-file\", \"C:\\\\other.json\"]",
            b"[\"\"\"]",
            b"not json",
        ] {
            let file = test_file(data);
            assert!(expand_file(&file, false).is_err());
            fs::remove_file(file).unwrap();
        }
        let file = test_file(&vec![b' '; 16 * 1024 + 1]);
        assert!(expand_file(&file, false).is_err());
        fs::remove_file(file).unwrap();
    }

    #[test]
    fn rejects_unapproved_overrides_and_duplicate_security_flags() {
        let file = test_file(br#"["--relay-url","wss://a.test","--relay-url","wss://b.test"]"#);
        assert!(expand_file(&file, false).is_err());
        fs::remove_file(file).unwrap();

        let file = test_file(br#"["--stdio-rpc","--dev-beta-local-toasts"]"#);
        assert!(expand_file(&file, true).is_err());
        let extra = vec![
            "--arguments-file".to_string(),
            file.to_string_lossy().into(),
            "--relay-url".to_string(),
            "wss://attacker.test".to_string(),
        ];
        assert!(expand(extra).is_err());
        fs::remove_file(file).unwrap();
    }

    #[test]
    fn rejects_missing_relative_or_embedded_arguments_files() {
        assert!(expand(vec!["--relay-url".into(), "wss://safe.test".into()]).is_ok());
        assert!(expand(vec!["--relay-url".into(), "--arguments-file".into()]).is_err());
        assert!(expand(vec!["--arguments-file".into(), "config.json".into()]).is_err());
        assert!(expand(vec!["--arguments-file".into()]).is_err());
    }
}
