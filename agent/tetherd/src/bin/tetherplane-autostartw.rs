#![cfg_attr(windows, windows_subsystem = "windows")]
#![forbid(unsafe_code)]

// Disabled-by-default, user-managed packaged Windows startup task.
// No new OAuth client, device identity, service, registry key or elevation.
#[cfg(not(windows))]
fn main() {
    eprintln!("tetherplane-autostartw is a Windows-only package entry");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    if windows::run().is_err() {
        std::process::exit(2);
    }
}

#[cfg(windows)]
mod windows {
    use std::env;
    use std::os::windows::process::CommandExt;
    use std::process::{self, Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub(super) fn run() -> Result<(), &'static str> {
        if env::args_os().nth(1).is_some() {
            return Err("startup task accepts no command-line arguments");
        }
        let current = env::current_exe().map_err(|_| "startup executable path unavailable")?;
        let bin = current.parent().ok_or("startup bin directory missing")?;
        if !bin
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
        {
            return Err("startup executable is outside expected package bin");
        }
        let package = bin.parent().ok_or("startup package directory missing")?;
        let node = package.join("runtime").join("node.exe");
        let script = package.join("app").join("agent-autostart.mjs");
        let agent = package.join("bin").join("tetherd-agentw.exe");
        if !node.is_file() || !script.is_file() || !agent.is_file() {
            return Err("startup requires the complete trusted package");
        }
        // Node rechecks the protected owner identity before launching agent.
        // It owns the child and watches this launcher for abnormal termination.
        let mut child = Command::new(node)
            .arg(script)
            .current_dir(package)
            .env("TETHERPLANE_STORE_AUTOSTART_PARENT_PID", process::id().to_string())
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "windowless Store startup child failed")?;
        let result = child
            .wait()
            .map_err(|_| "cannot supervise Store startup child")?;
        if !result.success() {
            return Err("Store startup child exited unsuccessfully");
        }
        Ok(())
    }
}
