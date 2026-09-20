use std::io;
use std::sync::Arc;

use tether_core::{
    CapabilityError, ErrorCode, InvocationEnvelope, ResultEnvelope, ResultStatus, Timing,
    VerificationStatus,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::sync::Mutex;
use tokio::task::JoinSet;
use uuid::Uuid;

use crate::runtime::AgentRuntime;

pub async fn serve(runtime: Arc<AgentRuntime>) -> io::Result<()> {
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let stdout = Arc::new(Mutex::new(BufWriter::new(tokio::io::stdout())));
    let mut requests = JoinSet::new();

    while let Some(line) = lines.next_line().await? {
        let invocation = match serde_json::from_str::<InvocationEnvelope>(&line) {
            Ok(invocation) => invocation,
            Err(error) => {
                eprintln!("invalid stdio RPC invocation: {error}");
                if let Some(request_id) = recover_request_id(&line) {
                    let result = invalid_invocation_result(request_id, &error.to_string());
                    write_result(&stdout, &result).await?;
                }
                continue;
            }
        };

        let runtime = Arc::clone(&runtime);
        let stdout = Arc::clone(&stdout);
        requests.spawn(async move {
            let result = runtime.execute(invocation).await;
            write_result(&stdout, &result).await
        });
    }

    while let Some(joined) = requests.join_next().await {
        match joined {
            Ok(result) => result?,
            Err(error) => {
                return Err(io::Error::other(format!(
                    "stdio RPC request task failed: {error}"
                )));
            }
        }
    }

    stdout.lock().await.flush().await
}

async fn write_result(
    stdout: &Mutex<BufWriter<tokio::io::Stdout>>,
    result: &ResultEnvelope,
) -> io::Result<()> {
    let encoded = serde_json::to_vec(result).map_err(io::Error::other)?;
    let mut stdout = stdout.lock().await;
    stdout.write_all(&encoded).await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await
}

fn recover_request_id(line: &str) -> Option<Uuid> {
    let marker = "\"request_id\"";
    let marker_index = line.find(marker)?;
    let after_marker = &line[marker_index + marker.len()..];
    let colon_index = after_marker.find(':')?;
    let after_colon = after_marker[colon_index + 1..].trim_start();
    let value = after_colon.strip_prefix('"')?;
    let end_quote = value.find('"')?;
    Uuid::parse_str(&value[..end_quote]).ok()
}

fn invalid_invocation_result(request_id: Uuid, message: &str) -> ResultEnvelope {
    ResultEnvelope {
        protocol_version: "1.0".into(),
        request_id,
        status: ResultStatus::Error,
        data: None,
        delta: None,
        error: Some(CapabilityError {
            code: ErrorCode::InvalidArguments,
            message: format!("invalid invocation JSON: {message}"),
            recovery_hint: None,
            details: serde_json::json!({}),
        }),
        verification: VerificationStatus::Failed,
        continuation: None,
        policy: None,
        timing: Timing { duration_ms: 0 },
    }
}
