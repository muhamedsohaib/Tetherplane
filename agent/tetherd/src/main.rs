#![forbid(unsafe_code)]

mod job;
mod runtime;
mod stdio_rpc;

use std::path::PathBuf;
use std::sync::Arc;

use runtime::AgentRuntime;
use tether_core::PrincipalProfile;

struct CliOptions {
    allowed_roots: Vec<PathBuf>,
    principal_profile: Option<PathBuf>,
    state_dir: Option<PathBuf>,
}

fn parse_args() -> Result<CliOptions, String> {
    let mut arguments = std::env::args().skip(1);
    let mut stdio_rpc = false;
    let mut allowed_roots = Vec::new();
    let mut principal_profile = None;
    let mut state_dir = None;

    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--stdio-rpc" => stdio_rpc = true,
            "--allow" => {
                let path = arguments
                    .next()
                    .ok_or_else(|| "--allow requires a path".to_owned())?;
                allowed_roots.push(PathBuf::from(path));
            }
            "--principal-profile" => {
                let path = arguments
                    .next()
                    .ok_or_else(|| "--principal-profile requires a path".to_owned())?;
                principal_profile = Some(PathBuf::from(path));
            }
            "--state-dir" => {
                let path = arguments
                    .next()
                    .ok_or_else(|| "--state-dir requires a path".to_owned())?;
                state_dir = Some(PathBuf::from(path));
            }
            _ => return Err(format!("unknown tetherd argument: {argument}")),
        }
    }

    if !stdio_rpc {
        return Err("tetherd requires --stdio-rpc for the local JSONL transport".into());
    }

    Ok(CliOptions {
        allowed_roots,
        principal_profile,
        state_dir,
    })
}

fn load_principal_profile(path: Option<&PathBuf>) -> Result<Option<PrincipalProfile>, String> {
    let Some(path) = path else {
        return Ok(None);
    };

    let content = std::fs::read_to_string(path).map_err(|error| {
        format!(
            "failed to read principal profile {}: {error}",
            path.display()
        )
    })?;
    let profile = serde_json::from_str::<PrincipalProfile>(&content)
        .map_err(|error| format!("invalid principal profile {}: {error}", path.display()))?;
    Ok(Some(profile))
}

#[tokio::main]
async fn main() {
    let options = match parse_args() {
        Ok(options) => options,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };

    let principal = match load_principal_profile(options.principal_profile.as_ref()) {
        Ok(principal) => principal,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };

    let runtime = match AgentRuntime::new(options.allowed_roots, principal, options.state_dir) {
        Ok(runtime) => Arc::new(runtime),
        Err(error) => {
            eprintln!("failed to initialize tetherd runtime: {}", error.message);
            std::process::exit(1);
        }
    };

    if let Err(error) = stdio_rpc::serve(runtime).await {
        eprintln!("stdio RPC failed: {error}");
        std::process::exit(1);
    }
}
