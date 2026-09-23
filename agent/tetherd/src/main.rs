#![forbid(unsafe_code)]

mod audit;
mod idempotency;
mod job;
mod relay_ws;
mod runtime;
mod stdio_rpc;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use runtime::AgentRuntime;
use tether_browser_provider::{BrowserBridgeConfig, BrowserProvider};
use tether_core::PrincipalProfile;

enum TransportMode {
    Stdio,
    Relay {
        url: String,
        device_id: String,
        credential_file: PathBuf,
        allow_insecure_localhost: bool,
    },
}

struct CliOptions {
    transport: TransportMode,
    allowed_roots: Vec<PathBuf>,
    principal_profile: Option<PathBuf>,
    state_dir: Option<PathBuf>,
    browser_bridge: Option<String>,
    browser_bridge_token_file: Option<PathBuf>,
}

fn parse_args() -> Result<CliOptions, String> {
    let mut arguments = std::env::args().skip(1);
    let mut stdio_rpc = false;
    let mut allowed_roots = Vec::new();
    let mut principal_profile = None;
    let mut state_dir = None;
    let mut browser_bridge = None;
    let mut browser_bridge_token_file = None;
    let mut relay_url = None;
    let mut device_id = None;
    let mut device_credential_file = None;
    let mut relay_allow_insecure_localhost = false;

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
            "--browser-bridge" => {
                browser_bridge =
                    Some(arguments.next().ok_or_else(|| {
                        "--browser-bridge requires a loopback address".to_owned()
                    })?);
            }
            "--browser-bridge-token-file" => {
                let path = arguments
                    .next()
                    .ok_or_else(|| "--browser-bridge-token-file requires a path".to_owned())?;
                browser_bridge_token_file = Some(PathBuf::from(path));
            }
            "--relay-url" => {
                relay_url = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--relay-url requires a URL".to_owned())?,
                );
            }
            "--device-id" => {
                device_id = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--device-id requires a value".to_owned())?,
                );
            }
            "--device-credential-file" => {
                device_credential_file =
                    Some(PathBuf::from(arguments.next().ok_or_else(|| {
                        "--device-credential-file requires a path".to_owned()
                    })?));
            }
            "--relay-allow-insecure-localhost" => relay_allow_insecure_localhost = true,
            _ => return Err(format!("unknown tetherd argument: {argument}")),
        }
    }

    let transport = match (stdio_rpc, relay_url) {
        (true, None) => {
            if device_id.is_some() || device_credential_file.is_some() {
                return Err("--device-id and --device-credential-file require --relay-url".into());
            }
            TransportMode::Stdio
        }
        (false, Some(url)) => TransportMode::Relay {
            url,
            device_id: device_id.ok_or_else(|| "--relay-url requires --device-id".to_owned())?,
            credential_file: device_credential_file
                .ok_or_else(|| "--relay-url requires --device-credential-file".to_owned())?,
            allow_insecure_localhost: relay_allow_insecure_localhost,
        },
        (true, Some(_)) => {
            return Err("--stdio-rpc and --relay-url are mutually exclusive".into());
        }
        (false, None) => {
            return Err("tetherd requires either --stdio-rpc or --relay-url".into());
        }
    };

    Ok(CliOptions {
        transport,
        allowed_roots,
        principal_profile,
        state_dir,
        browser_bridge,
        browser_bridge_token_file,
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

fn load_browser_token(path: Option<&PathBuf>) -> Result<Option<String>, String> {
    let Some(path) = path else {
        return Ok(None);
    };

    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("failed to read browser bridge token file: {error}"))?;
    let token = content.trim();
    if token.is_empty() {
        return Err("browser bridge token file is empty".to_owned());
    }
    Ok(Some(token.to_owned()))
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

    let transport = options.transport;

    let principal = match load_principal_profile(options.principal_profile.as_ref()) {
        Ok(principal) => principal,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };

    let browser_token = match load_browser_token(options.browser_bridge_token_file.as_ref()) {
        Ok(token) => token,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };

    let browser_provider = if let Some(address) = options.browser_bridge {
        match BrowserProvider::connect(BrowserBridgeConfig {
            address,
            token: browser_token,
            timeout_ms: 10_000,
        })
        .await
        {
            Ok(provider) => Some(Arc::new(provider)),
            Err(error) => {
                eprintln!("browser bridge unavailable: {}", error.message);
                None
            }
        }
    } else {
        None
    };

    let runtime = match AgentRuntime::new(
        options.allowed_roots,
        principal,
        options.state_dir.as_deref(),
        browser_provider,
    ) {
        Ok(runtime) => Arc::new(runtime),
        Err(error) => {
            eprintln!("failed to initialize tetherd runtime: {}", error.message);
            std::process::exit(1);
        }
    };

    let result = match transport {
        TransportMode::Stdio => stdio_rpc::serve(runtime)
            .await
            .map_err(|error| format!("stdio RPC failed: {error}")),
        TransportMode::Relay {
            url,
            device_id,
            credential_file,
            allow_insecure_localhost,
        } => {
            let credential = match relay_ws::load_device_credential(&credential_file) {
                Ok(credential) => credential,
                Err(message) => {
                    eprintln!("{message}");
                    std::process::exit(2);
                }
            };
            relay_ws::serve(
                runtime,
                relay_ws::RelayConfig {
                    url,
                    device_id,
                    credential,
                    allow_insecure_localhost,
                    reconnect_delay: Duration::from_secs(2),
                },
            )
            .await
            .map_err(|error| format!("relay transport failed: {error}"))
        }
    };

    if let Err(message) = result {
        eprintln!("{message}");
        std::process::exit(1);
    }
}
