#![cfg_attr(windows, windows_subsystem = "windows")]
#![forbid(unsafe_code)]

// Owner-session browser companion only. This is NOT a second device agent.
// The child receives file paths, never token contents or broader capabilities.
#[cfg(not(windows))]
fn main() {
    eprintln!("tetherplane-browserw is a Windows-only launcher");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    if let Err(error) = windows::run() {
        windows::record_failure(error);
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod windows {
    use std::env;
    use std::ffi::OsString;
    use std::fs::{self, File, OpenOptions};
    use std::io::Write;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{self, Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const MAX_LOG_BYTES: u64 = 1024 * 1024;
    const INITIAL_RETRY_SECS: u64 = 2;
    const MAX_RETRY_SECS: u64 = 60;

    struct Options {
        host: PathBuf,
        state: PathBuf,
        node: PathBuf,
        require_background_optin: bool,
    }

    fn options() -> Result<Options, &'static str> {
        let binary = env::current_exe().map_err(|_| "launcher executable path unavailable")?;
        let package = binary
            .parent()
            .and_then(Path::parent)
            .ok_or("launcher must be inside an installed bin directory")?;
        let local = env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA missing")?;
        let mut host = package.join("browser").join("host.mjs");
        let mut state = PathBuf::from(local).join("Tetherplane");
        let mut require_background_optin = false;

        let argv: Vec<OsString> = env::args_os().skip(1).collect();
        let mut cursor = 0;
        while cursor < argv.len() {
            let flag = argv[cursor].to_str().ok_or("invalid launcher argument")?;
            cursor += 1;
            if flag == "--require-background-optin" {
                require_background_optin = true;
                continue;
            }
            let value = argv
                .get(cursor)
                .ok_or("launcher switch requires one path")?;
            match flag {
                "--browser-host-script" => host = PathBuf::from(value),
                "--browser-state-dir" => state = PathBuf::from(value),
                _ => return Err("unsupported browser launcher switch"),
            }
            cursor += 1;
        }
        if !host.is_absolute() || !host.is_file() {
            return Err("browser host script missing or not absolute");
        }
        if !matches!(
            host.file_name().and_then(|name| name.to_str()),
            Some("host.mjs" | "browser-extension-host.ts")
        ) {
            return Err("unexpected browser host script identity");
        }
        if !state.is_absolute() || !state.is_dir() {
            return Err("browser owner state directory missing");
        }
        let bundled_node = package.join("runtime").join("node.exe");
        let node = if bundled_node.is_file() {
            bundled_node
        } else {
            PathBuf::from("node.exe")
        };
        Ok(Options {
            host,
            state,
            node,
            require_background_optin,
        })
    }

    fn require_owner_enrollment(state: &Path) -> Result<(), &'static str> {
        match fs::symlink_metadata(state.join("browser-enrollment.revoked")) {
            Ok(_) => return Err("owner revoked the browser enrollment"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("browser revocation state is unreadable"),
        }
        for file in ["browser-bridge.token", "browser-extension-launch.token"] {
            let metadata = fs::metadata(state.join(file))
                .map_err(|_| "owner browser token file is unavailable")?;
            if !metadata.is_file() || metadata.len() < 32 {
                return Err("owner browser token file is invalid");
            }
        }
        let pin = fs::read_to_string(state.join("browser-extension.id"))
            .map_err(|_| "owner browser extension pin is unavailable")?;
        let id = pin.trim();
        if id.len() != 32 || !id.bytes().all(|c| (b'a'..=b'p').contains(&c)) {
            return Err("owner browser extension pin is invalid");
        }
        Ok(())
    }

    // A Windows exclusive share-mode lock is released on process exit/crash.
    // This is a background host instance guard, not an authentication secret.
    fn acquire_owner_browser_instance_lock(state: &Path) -> Result<File, &'static str> {
        let meta = fs::symlink_metadata(state).map_err(|_| "owner state missing")?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("owner state invalid");
        }
        let path = state.join(".tetherplane-owner-browser.lock");
        match fs::symlink_metadata(&path) {
            Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
                return Err("browser lock path invalid");
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err("browser lock unavailable");
            }
            _ => {}
        }
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(path)
            .map_err(|_| "browser owner instance already running or unavailable")
    }

    fn require_background_optin(state: &Path) -> Result<(), &'static str> {
        let marker = state.join("browser-background.optin");
        let meta = fs::symlink_metadata(&marker).map_err(|_| "background browser not approved")?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 128 {
            return Err("background browser approval invalid");
        }
        let content =
            fs::read_to_string(marker).map_err(|_| "background browser approval unreadable")?;
        if content != "owner-approved-browser-background-v1\n" {
            return Err("background browser approval withdrawn");
        }
        Ok(())
    }

    fn rotate_if_needed(path: &Path) -> Result<(), &'static str> {
        if fs::metadata(path).is_ok_and(|info| info.len() > MAX_LOG_BYTES) {
            let old = path.with_extension("old");
            if old.exists() {
                fs::remove_file(&old).map_err(|_| "cannot rotate old browser log")?;
            }
            fs::rename(path, old).map_err(|_| "cannot rotate browser log")?;
        }
        Ok(())
    }

    fn append_event(state: &Path, event: &str) -> Result<(), &'static str> {
        let path = state.join("browser-host-supervisor.log");
        rotate_if_needed(&path)?;
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .map_err(|_| "browser supervisor log unavailable")?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |span| span.as_secs());
        writeln!(file, "{stamp} {event}").map_err(|_| "browser supervisor log write failed")
    }

    fn open_child_log(state: &Path, file: &str) -> Result<File, &'static str> {
        let path = state.join(file);
        rotate_if_needed(&path)?;
        OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .map_err(|_| "browser child log unavailable")
    }

    pub(super) fn record_failure(message: &str) {
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            let state = PathBuf::from(local).join("Tetherplane");
            if state.is_dir() {
                let _ = append_event(&state, message);
            }
        }
    }

    pub(super) fn run() -> Result<(), &'static str> {
        let settings = options()?;
        let _owner_lock = acquire_owner_browser_instance_lock(&settings.state)?;
        require_owner_enrollment(&settings.state)?;
        if settings.require_background_optin {
            require_background_optin(&settings.state)?;
        }
        append_event(&settings.state, "OWNER_BROWSER_WINDOWLESS_LAUNCHER_START")?;
        let mut retry_seconds = INITIAL_RETRY_SECS;

        loop {
            // Revoked or removed owner-controlled files cannot be silently
            // recreated by the launcher, even after a child crash.
            require_owner_enrollment(&settings.state)?;
            if settings.require_background_optin {
                require_background_optin(&settings.state)?;
            }
            let stdout = open_child_log(&settings.state, "browser-host.stdout.log")?;
            let stderr = open_child_log(&settings.state, "browser-host.stderr.log")?;

            // The PE GUI subsystem hides this launcher. CREATE_NO_WINDOW
            // separately prevents its console-subsystem Node child from
            // allocating a Windows Terminal/conhost window.
            let started = Instant::now();
            let mut child_command = Command::new(&settings.node);
            if settings.require_background_optin {
                child_command.env(
                    "TETHERPLANE_BROWSER_BACKGROUND_OPTIN_FILE",
                    settings.state.join("browser-background.optin"),
                );
            }
            let mut child = child_command
                .arg(&settings.host)
                .current_dir(
                    settings
                        .host
                        .parent()
                        .ok_or("browser host directory unavailable")?,
                )
                .env(
                    "TETHERPLANE_BROWSER_BRIDGE_TOKEN_FILE",
                    settings.state.join("browser-bridge.token"),
                )
                .env(
                    "TETHERPLANE_EXTENSION_LAUNCH_TOKEN_FILE",
                    settings.state.join("browser-extension-launch.token"),
                )
                .env(
                    "TETHERPLANE_EXTENSION_ID_FILE",
                    settings.state.join("browser-extension.id"),
                )
                .env(
                    "TETHERPLANE_BROWSER_LAUNCHER_PID",
                    process::id().to_string(),
                )
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::from(stdout))
                .stderr(Stdio::from(stderr))
                .spawn()
                .map_err(|_| "unable to launch windowless browser host")?;

            let exit = child
                .wait()
                .map_err(|_| "unable to wait for browser host process")?;
            let event = if exit.success() {
                "BROWSER_HOST_EXITED"
            } else {
                "BROWSER_HOST_FAILED_RETRYING"
            };
            append_event(&settings.state, event)?;

            // Bound crash-loop volume; a normally healthy host never exits.
            if started.elapsed() >= Duration::from_secs(60) {
                retry_seconds = INITIAL_RETRY_SECS;
            } else {
                retry_seconds = retry_seconds.saturating_mul(2).min(MAX_RETRY_SECS);
            }
            thread::sleep(Duration::from_secs(retry_seconds));
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn exclusive_browser_lock_prevents_duplicates_and_recovers_on_exit() {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let dir = env::temp_dir().join(format!("tp-browser-lock-{}-{suffix}", process::id()));
            fs::create_dir(&dir).expect("isolated owner directory");
            let first =
                acquire_owner_browser_instance_lock(&dir).expect("first browser owner accepted");
            assert!(
                acquire_owner_browser_instance_lock(&dir).is_err(),
                "second browser supervisor must not start"
            );
            drop(first);
            let next = acquire_owner_browser_instance_lock(&dir)
                .expect("OS must release lock after owner closes");
            drop(next);
            fs::remove_file(dir.join(".tetherplane-owner-browser.lock"))
                .expect("remove only synthetic lock");
            fs::remove_dir(dir).expect("remove only synthetic directory");
        }

        #[test]
        fn background_marker_is_required_and_checked_again() {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let dir = env::temp_dir().join(format!("tp-browser-optin-{}-{suffix}", process::id()));
            fs::create_dir(&dir).expect("isolated owner directory");
            assert!(require_background_optin(&dir).is_err());
            let marker = dir.join("browser-background.optin");
            fs::write(&marker, b"owner-approved-browser-background-v1\n")
                .expect("synthetic opt-in marker");
            assert!(require_background_optin(&dir).is_ok());
            fs::write(&marker, b"replaced\n").expect("change synthetic marker");
            assert!(require_background_optin(&dir).is_err());
            fs::remove_file(marker).expect("remove only synthetic marker");
            fs::remove_dir(dir).expect("remove only synthetic directory");
        }

        #[test]
        fn revoked_owner_marker_prevents_windowless_host_relaunch() {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let directory =
                env::temp_dir().join(format!("tetherplane-revoked-{}-{suffix}", process::id()));
            fs::create_dir(&directory).expect("isolated revocation test directory");
            fs::write(directory.join("browser-enrollment.revoked"), b"revoked\n")
                .expect("synthetic owner marker");
            let result = require_owner_enrollment(&directory);
            assert_eq!(result, Err("owner revoked the browser enrollment"));
            fs::remove_file(directory.join("browser-enrollment.revoked"))
                .expect("remove only synthetic marker");
            fs::remove_dir(directory).expect("remove isolated test directory");
        }
    }
}
