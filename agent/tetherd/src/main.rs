#![forbid(unsafe_code)]

mod runtime;
mod stdio_rpc;

use std::path::PathBuf;
use std::sync::Arc;

use runtime::AgentRuntime;

struct CliOptions {
    allowed_roots: Vec<PathBuf>,
}

fn parse_args() -> Result<CliOptions, String> {
    let mut arguments = std::env::args().skip(1);
    let mut stdio_rpc = false;
    let mut allowed_roots = Vec::new();

    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--stdio-rpc" => stdio_rpc = true,
            "--allow" => {
                let path = arguments
                    .next()
                    .ok_or_else(|| "--allow requires a path".to_owned())?;
                allowed_roots.push(PathBuf::from(path));
            }
            _ => return Err(format!("unknown tetherd argument: {argument}")),
        }
    }

    if !stdio_rpc {
        return Err("tetherd requires --stdio-rpc for the local JSONL transport".into());
    }

    Ok(CliOptions { allowed_roots })
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

    let runtime = match AgentRuntime::new(options.allowed_roots) {
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
