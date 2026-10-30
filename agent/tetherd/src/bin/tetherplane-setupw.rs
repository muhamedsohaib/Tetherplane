#![cfg_attr(windows, windows_subsystem = "windows")]
#![forbid(unsafe_code)]

// Windows Store owner-initiated setup entry only. Never pairs, mints credentials
// or registers agent tasks. The existing wizard enforces owner authorization.
#[cfg(not(windows))]
fn main() {
    eprintln!("tetherplane-setupw requires Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    if windows::run().is_err() {
        windows::event("STORE_SETUP_WINDOWLESS_FAILED");
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod windows {
    use std::env;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{self, Command, Stdio};
    use std::time::{SystemTime, UNIX_EPOCH};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const MAX_LOG_BYTES: u64 = 1024 * 1024;

    // Fixed status identifiers only; never credentials, paths, or setup URLs.
    pub(super) fn event(value: &str) {
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            let dir = PathBuf::from(local).join("TetherplaneSetupLogs");
            if fs::create_dir_all(&dir).is_ok() {
                let log = dir.join("store-setupw.log");
                if fs::metadata(&log).is_ok_and(|m| m.len() > MAX_LOG_BYTES) {
                    let previous = dir.join("store-setupw.old");
                    let _ = fs::remove_file(&previous);
                    let _ = fs::rename(&log, previous);
                }
                if let Ok(mut f) = OpenOptions::new().append(true).create(true).open(log) {
                    let time = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_or(0, |d| d.as_secs());
                    let _ = writeln!(f, "{time} {value}");
                }
            }
        }
    }

    pub(super) fn run() -> Result<(), &'static str> {
        if env::args_os().skip(1).next().is_some() {
            return Err("unexpected setup arguments");
        }
        let executable = env::current_exe().map_err(|_| "setup executable unavailable")?;
        let bin = executable
            .parent()
            .ok_or("setup bin directory unavailable")?;
        if !bin
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
        {
            return Err("setup executable is outside the expected bin directory");
        }
        let package = bin.parent().ok_or("package root unavailable")?;
        let node = package.join("runtime").join("node.exe");
        let script = package.join("app").join("runtime-app.mjs");
        if !node.is_file() || !script.is_file() {
            return Err("required signed Node or owner wizard is unavailable");
        }
        event("STORE_SETUP_WINDOWLESS_START");
        // Node.exe is PE subsystem 3, so launching it directly as an MSIX app
        // risks creating Windows Terminal. This is PE subsystem 2; its signed
        // Node child receives CREATE_NO_WINDOW and remains in the owner session.
        let mut child = Command::new(node)
            .arg(script)
            .current_dir(package)
            .env("TETHERPLANE_STORE_LAUNCHER_PID", process::id().to_string())
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "unable to start windowless Store setup")?;
        let exit = child
            .wait()
            .map_err(|_| "unable to supervise Store setup")?;
        if !exit.success() {
            return Err("Store setup child exited unsuccessfully");
        }
        event("STORE_SETUP_WINDOWLESS_STOP");
        Ok(())
    }
}
