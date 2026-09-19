#![forbid(unsafe_code)]

mod runtime;
mod stdio_rpc;

use std::sync::Arc;

use runtime::AgentRuntime;

#[tokio::main]
async fn main() {
    if !std::env::args().any(|argument| argument == "--stdio-rpc") {
        eprintln!("tetherd requires --stdio-rpc for the local JSONL transport");
        std::process::exit(2);
    }

    let runtime = match AgentRuntime::new() {
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
