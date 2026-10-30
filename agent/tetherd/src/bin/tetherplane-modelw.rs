#![cfg_attr(windows, windows_subsystem = "windows")]
#![forbid(unsafe_code)]

// Per-user optional model worker supervisor: NOT an authenticated device agent.
// Never put credentials on a command line or start a console application with
// a visible Windows Terminal window.
#[cfg(not(windows))]
fn main() {
    eprintln!("tetherplane-modelw is Windows-only");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    if let Err(reason) = windows::run() {
        windows::record_error(reason);
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod windows {
    use std::env;
    use std::fs::{self, File, OpenOptions};
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{self, Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const MAX_ARGS_BYTES: u64 = 16 * 1024;
    const MAX_LOG_BYTES: u64 = 1024 * 1024;

    struct Spec {
        root: PathBuf,
        node: PathBuf,
        script: PathBuf,
        args: Vec<String>,
    }

    fn read_spec() -> Result<Spec, &'static str> {
        let launch_tokens: Vec<_> = env::args_os().skip(1).collect();
        if launch_tokens.len() != 2 || launch_tokens[0] != "--arguments-file" {
            return Err("model launcher requires one --arguments-file path");
        }
        let executable = env::current_exe().map_err(|_| "model launcher path unavailable")?;
        let root = executable
            .parent()
            .and_then(Path::parent)
            .ok_or("model launcher must be in installed bin")?
            .to_path_buf();
        let expected = root.join("config").join("model-worker-args.json");
        let supplied = PathBuf::from(&launch_tokens[1]);
        if !supplied.is_absolute() {
            return Err("model arguments path must be absolute");
        }
        let actual = fs::canonicalize(supplied).map_err(|_| "model arguments file unavailable")?;
        let canonical_expected =
            fs::canonicalize(expected).map_err(|_| "installed model arguments file unavailable")?;
        if !actual
            .to_string_lossy()
            .eq_ignore_ascii_case(&canonical_expected.to_string_lossy())
        {
            return Err("model arguments must be the installed owned file");
        }
        let meta = fs::metadata(&actual).map_err(|_| "cannot inspect model worker arguments")?;
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_ARGS_BYTES {
            return Err("model worker arguments file size or type invalid");
        }
        let bytes = fs::read(&actual).map_err(|_| "cannot read model worker arguments file")?;
        let args: Vec<String> = serde_json::from_slice(&bytes)
            .map_err(|_| "model worker arguments must be JSON strings")?;
        if args.len() < 12 || args.len() > 96 {
            return Err("model worker argument count invalid");
        }
        for flag in [
            "--device",
            "--model-endpoint",
            "--model",
            "--tetherd",
            "--principal-profile",
            "--state-dir",
        ] {
            let positions: Vec<usize> = args
                .iter()
                .enumerate()
                .filter_map(|(index, item)| (item == flag).then_some(index))
                .collect();
            if positions.len() != 1 {
                return Err("required model worker argument missing or duplicated");
            }
            let value = args
                .get(positions[0] + 1)
                .ok_or("model worker argument value missing")?;
            if value.is_empty() || value.starts_with("--") {
                return Err("required model worker argument value invalid");
            }
        }
        let agent_position = args
            .iter()
            .position(|arg| arg == "--tetherd")
            .ok_or("model agent reference missing")?;
        let installed_agent = fs::canonicalize(root.join("bin").join("tetherd.exe"))
            .map_err(|_| "installed stdio agent unavailable")?;
        let configured_agent = fs::canonicalize(&args[agent_position + 1])
            .map_err(|_| "configured stdio agent unavailable")?;
        if !configured_agent
            .to_string_lossy()
            .eq_ignore_ascii_case(&installed_agent.to_string_lossy())
        {
            return Err("model worker cannot substitute a foreign agent executable");
        }
        let script = root
            .join("adapters")
            .join("model-client")
            .join("dist")
            .join("worker-main.js");
        if !script.is_file() {
            return Err("installed model worker script unavailable");
        }
        let bundled = root.join("runtime").join("node.exe");
        let node = if bundled.is_file() {
            bundled
        } else {
            PathBuf::from("node.exe")
        };
        Ok(Spec {
            root,
            node,
            script,
            args,
        })
    }

    fn rotate(path: &Path) -> Result<(), &'static str> {
        if fs::metadata(path).is_ok_and(|info| info.len() > MAX_LOG_BYTES) {
            let older = path.with_extension("old");
            if older.exists() {
                fs::remove_file(&older).map_err(|_| "cannot clear old model log")?;
            }
            fs::rename(path, older).map_err(|_| "cannot rotate model log")?;
        }
        Ok(())
    }

    fn open_log(path: &Path) -> Result<File, &'static str> {
        rotate(path)?;
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|_| "model worker log unavailable")
    }

    fn event(config: &Path, status: &str) -> Result<(), &'static str> {
        let mut file = open_log(&config.join("model-worker-supervisor.log"))?;
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        writeln!(file, "{secs} {status}").map_err(|_| "model worker event log write failed")
    }

    pub(super) fn record_error(error: &str) {
        if let Ok(exe) = env::current_exe()
            && let Some(root) = exe.parent().and_then(Path::parent)
        {
            let config = root.join("config");
            if config.is_dir() {
                let _ = event(&config, error);
            }
        }
    }

    pub(super) fn run() -> Result<(), &'static str> {
        let spec = read_spec()?;
        let config = spec.root.join("config");
        event(&config, "MODEL_WORKER_NATIVE_GUI_START")?;
        let mut backoff = 2_u64;
        loop {
            let stdout = open_log(&config.join("model-worker.stdout.log"))?;
            let stderr = open_log(&config.join("model-worker.stderr.log"))?;
            let started = Instant::now();
            let mut child = Command::new(&spec.node)
                .arg(&spec.script)
                .args(&spec.args)
                .current_dir(&spec.root)
                .env("TETHERPLANE_MODEL_LAUNCHER_PID", process::id().to_string())
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::from(stdout))
                .stderr(Stdio::from(stderr))
                .spawn()
                .map_err(|_| "unable to spawn windowless model worker")?;
            let status = child
                .wait()
                .map_err(|_| "unable to wait for model worker")?;
            event(
                &config,
                if status.success() {
                    "MODEL_WORKER_EXITED"
                } else {
                    "MODEL_WORKER_FAILED_RETRYING"
                },
            )?;
            if started.elapsed() >= Duration::from_secs(60) {
                backoff = 2;
            } else {
                backoff = backoff.saturating_mul(2).min(60);
            }
            thread::sleep(Duration::from_secs(backoff));
        }
    }
}
