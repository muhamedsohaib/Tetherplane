#![cfg_attr(all(windows, feature = "windows-headless-agent"), windows_subsystem = "windows")]
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
    browser_only: bool,
}

// The Windows Task Scheduler action owns tetherd directly. It passes a path
// to an existing, local, installer-owned JSON argument file, never credentials.
// Reuse the ordinary CLI parser so the file cannot expand local authority.
fn parse_args() -> Result<CliOptions, String> {
    parse_args_from(std::env::args().skip(1).collect())
}

fn parse_args_from(arguments: Vec<String>) -> Result<CliOptions, String> {
    const MAX_ARGUMENTS_FILE_BYTES: u64 = 16 * 1024;
    let expanded = if arguments
        .first()
        .is_some_and(|arg| arg == "--arguments-file")
    {
        if arguments.len() != 2 {
            return Err("--arguments-file requires exactly one file path".into());
        }
        let path = PathBuf::from(&arguments[1]);
        let metadata =
            std::fs::metadata(&path).map_err(|_| "unable to inspect arguments file".to_owned())?;
        if !metadata.is_file() || metadata.len() > MAX_ARGUMENTS_FILE_BYTES {
            return Err("arguments file must be a regular file of at most 16 KiB".into());
        }
        let contents =
            std::fs::read(&path).map_err(|_| "unable to read arguments file".to_owned())?;
        if contents.len() as u64 > MAX_ARGUMENTS_FILE_BYTES {
            return Err("arguments file exceeds 16 KiB".into());
        }
        let parsed: Vec<String> = serde_json::from_slice(&contents)
            .map_err(|_| "arguments file must contain a JSON array of strings".to_owned())?;
        if parsed.is_empty() {
            return Err("arguments file must not be empty".into());
        }
        if parsed.iter().any(|arg| arg == "--arguments-file") {
            return Err("nested arguments files are not permitted".into());
        }
        parsed
    } else {
        if arguments.iter().any(|arg| arg == "--arguments-file") {
            return Err("--arguments-file must be the only CLI option".into());
        }
        arguments
    };

    parse_arg_tokens(expanded.into_iter())
}

fn parse_arg_tokens(mut arguments: impl Iterator<Item = String>) -> Result<CliOptions, String> {
    let mut stdio_rpc = false;
    let mut allowed_roots = Vec::new();
    let mut principal_profile = None;
    let mut state_dir = None;
    let mut browser_bridge = None;
    let mut browser_bridge_token_file = None;
    let mut browser_only = false;
    let mut relay_url = None;
    let mut device_id = None;
    let mut device_credential_file = None;
    let mut relay_allow_insecure_localhost = false;

    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--stdio-rpc" => stdio_rpc = true,
            "--browser-only" => browser_only = true,
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
        browser_only,
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

// A launch flag is local operator configuration, never an AI-supplied grant.
// Reject unsafe browser-only configurations before any bridge handshake.
fn validate_browser_only_launch(
    enabled: bool,
    allowed_roots: &[PathBuf],
    principal: Option<&PrincipalProfile>,
    transport: &TransportMode,
) -> Result<(), &'static str> {
    if !enabled {
        return Ok(());
    }
    if !allowed_roots.is_empty() {
        return Err("browser-only launch must not include --allow directories");
    }
    let Some(profile) = principal else {
        return Err("browser-only launch requires a principal profile");
    };
    let launched_device_id = match transport {
        TransportMode::Relay { device_id, .. } => Some(device_id.as_str()),
        TransportMode::Stdio => None,
    };
    profile.validate_browser_only(launched_device_id)
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

    let principal =
        load_principal_profile(options.principal_profile.as_ref()).unwrap_or_else(|message| {
            eprintln!("{message}");
            std::process::exit(2);
        });

    if let Err(message) = validate_browser_only_launch(
        options.browser_only,
        &options.allowed_roots,
        principal.as_ref(),
        &transport,
    ) {
        eprintln!("{message}");
        std::process::exit(2);
    }

    // An optional browser bridge cannot take the independently authorized
    // device core offline. The browser provider must reauthenticate before
    // advertising or executing any browser operation.
    let browser_provider = if let Some(address) = options.browser_bridge {
        let config = BrowserBridgeConfig {
            address,
            token: None,
            timeout_ms: 2_000,
        };
        if let Some(path) = options.browser_bridge_token_file {
            Some(BrowserProvider::connect_nonfatal_with_token_file(
                config, path,
            ))
        } else {
            Some(BrowserProvider::connect_nonfatal(config))
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
        TransportMode::Stdio => {
            eprintln!("TETHERPLANE_STDIO_READY_V1");
            stdio_rpc::serve(runtime)
                .await
                .map_err(|error| format!("stdio RPC failed: {error}"))
        }
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

#[cfg(test)]
mod arguments_file_tests {
    use super::{TransportMode, parse_args_from};
    use std::fs;

    fn with_file(contents: &str, assert_file: impl FnOnce(String)) {
        let path = std::env::temp_dir().join(format!(
            "tetherplane-arguments-test-{}.json",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, contents).expect("create isolated fixture");
        let display = path.to_string_lossy().to_string();
        assert_file(display);
        fs::remove_file(&path).expect("remove isolated fixture");
    }

    #[test]
    fn arguments_file_parses_existing_relay_options() {
        let args = serde_json::to_string(&[
            "--relay-url",
            "wss://relay.example.test/device",
            "--device-id",
            "Leno",
            "--device-credential-file",
            "C:/isolated-test/credential.txt",
        ])
        .expect("serialize fixture");
        with_file(&args, |file| {
            let parsed = parse_args_from(vec!["--arguments-file".into(), file])
                .unwrap_or_else(|error| panic!("valid arguments file rejected: {error}"));
            match parsed.transport {
                TransportMode::Relay {
                    url,
                    device_id,
                    credential_file,
                    allow_insecure_localhost,
                } => {
                    assert_eq!(url, "wss://relay.example.test/device");
                    assert_eq!(device_id, "Leno");
                    assert_eq!(
                        credential_file.to_string_lossy(),
                        "C:/isolated-test/credential.txt"
                    );
                    assert!(!allow_insecure_localhost);
                }
                TransportMode::Stdio => panic!("relay arguments became stdio transport"),
            }
        });
    }

    #[test]
    fn arguments_file_fails_closed_on_malformed_nested_or_conflicting_inputs() {
        for contents in [
            r#"{"relay_url":"wss://relay.example.test"}"#,
            r#"["--arguments-file","another.json"]"#,
            "[]",
            r#"["--relay-url",7]"#,
        ] {
            with_file(contents, |file| {
                assert!(parse_args_from(vec!["--arguments-file".into(), file]).is_err());
            });
        }
        assert!(
            parse_args_from(vec![
                "--relay-url".into(),
                "wss://relay.example.test/device".into(),
                "--arguments-file".into(),
                "elsewhere.json".into(),
            ])
            .is_err()
        );
        assert!(parse_args_from(vec!["--arguments-file".into()]).is_err());
    }

    #[test]
    fn arguments_file_rejects_oversized_input_without_expanding_arguments() {
        with_file(&" ".repeat(16 * 1024 + 1), |file| {
            assert!(parse_args_from(vec!["--arguments-file".into(), file]).is_err());
        });
    }

    #[test]
    fn arguments_file_preserves_browser_only_flag() {
        with_file(r#"["--stdio-rpc","--browser-only"]"#, |file| {
            let parsed = parse_args_from(vec!["--arguments-file".into(), file])
                .expect("arguments-file must preserve launch policy flags");
            assert!(parsed.browser_only);
        });
    }

    #[test]
    fn direct_cli_remains_compatible() {
        let parsed = parse_args_from(vec!["--stdio-rpc".into()])
            .unwrap_or_else(|error| panic!("stdio regression: {error}"));
        assert!(matches!(parsed.transport, TransportMode::Stdio));
    }
}
