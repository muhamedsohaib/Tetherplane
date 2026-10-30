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

        let argv: Vec<OsString> = env::args_os().skip(1).collect();
        let mut cursor = 0;
        while cursor < argv.len() {
            let flag = argv[cursor].to_str().ok_or("invalid launcher argument")?;
            cursor += 1;
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
        Ok(Options { host, state, node })
    }

    fn require_owner_enrollment(state: &Path) -> Result<(), &'static str> {
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
        require_owner_enrollment(&settings.state)?;
        append_event(&settings.state, "OWNER_BROWSER_WINDOWLESS_LAUNCHER_START")?;
        let mut retry_seconds = INITIAL_RETRY_SECS;

        loop {
            // Revoked or removed owner-controlled files cannot be silently
            // recreated by the launcher, even after a child crash.
            require_owner_enrollment(&settings.state)?;
            let stdout = open_child_log(&settings.state, "browser-host.stdout.log")?;
            let stderr = open_child_log(&settings.state, "browser-host.stderr.log")?;

            // The PE GUI subsystem hides this launcher. CREATE_NO_WINDOW
            // separately prevents its console-subsystem Node child from
            // allocating a Windows Terminal/conhost window.
            let started = Instant::now();
            let mut child = Command::new(&settings.node)
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
}
