use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tether_core::{
    CapabilityError, ErrorCode, InvocationEnvelope, ResultEnvelope, ResultStatus, Timing,
    VerificationStatus,
};
use uuid::Uuid;

#[derive(Debug)]
pub enum IdempotencyLookup {
    Miss,
    Pending,
    Replay(Box<ResultEnvelope>),
    Conflict,
}

#[derive(Debug, Deserialize, Serialize)]
struct PendingRecord {
    fingerprint: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct CompletedRecord {
    fingerprint: String,
    result: ResultEnvelope,
}

struct RecordPaths {
    pending: PathBuf,
    completed: PathBuf,
}

pub struct IdempotencyStore {
    directory: PathBuf,
}

impl IdempotencyStore {
    pub fn new(state_dir: &Path) -> Result<Self, CapabilityError> {
        let directory = state_dir.join("idempotency");
        fs::create_dir_all(&directory).map_err(|error| {
            provider_failure(format!("failed to create idempotency directory: {error}"))
        })?;
        Ok(Self { directory })
    }

    pub fn lookup(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<IdempotencyLookup, CapabilityError> {
        let Some(key) = invocation.idempotency_key.as_deref() else {
            return Ok(IdempotencyLookup::Miss);
        };
        let paths = self.record_paths(invocation, key)?;
        let fingerprint = request_fingerprint(invocation)?;

        if paths.completed.exists() {
            let record =
                read_json::<CompletedRecord>(&paths.completed, "completed idempotency record")?;
            if record.fingerprint != fingerprint {
                return Ok(IdempotencyLookup::Conflict);
            }
            let mut replay = record.result;
            replay
                .protocol_version
                .clone_from(&invocation.protocol_version);
            replay.request_id = invocation.request_id;
            return Ok(IdempotencyLookup::Replay(Box::new(replay)));
        }

        if paths.pending.exists() {
            let record = read_json::<PendingRecord>(&paths.pending, "pending idempotency record")?;
            if record.fingerprint != fingerprint {
                return Ok(IdempotencyLookup::Conflict);
            }
            return Ok(IdempotencyLookup::Pending);
        }

        Ok(IdempotencyLookup::Miss)
    }

    pub fn reserve(&self, invocation: &InvocationEnvelope) -> Result<(), CapabilityError> {
        let key = invocation
            .idempotency_key
            .as_deref()
            .ok_or_else(|| provider_failure("idempotency key is missing".into()))?;
        let paths = self.record_paths(invocation, key)?;
        let record = PendingRecord {
            fingerprint: request_fingerprint(invocation)?,
        };
        let encoded = serde_json::to_vec_pretty(&record).map_err(|error| {
            provider_failure(format!(
                "failed to encode pending idempotency record: {error}"
            ))
        })?;

        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&paths.pending)
            .map_err(|error| {
                provider_failure(format!("failed to reserve idempotency key: {error}"))
            })?;
        file.write_all(&encoded)
            .and_then(|()| file.flush())
            .map_err(|error| {
                provider_failure(format!(
                    "failed to persist idempotency reservation: {error}"
                ))
            })
    }

    pub fn complete(
        &self,
        invocation: &InvocationEnvelope,
        result: &ResultEnvelope,
    ) -> Result<(), CapabilityError> {
        let key = invocation
            .idempotency_key
            .as_deref()
            .ok_or_else(|| provider_failure("idempotency key is missing".into()))?;
        let paths = self.record_paths(invocation, key)?;
        let fingerprint = request_fingerprint(invocation)?;

        if paths.completed.exists() {
            let existing =
                read_json::<CompletedRecord>(&paths.completed, "completed idempotency record")?;
            if existing.fingerprint == fingerprint {
                let _ = fs::remove_file(&paths.pending);
                return Ok(());
            }
            return Err(idempotency_conflict(invocation));
        }

        let record = CompletedRecord {
            fingerprint,
            result: result.clone(),
        };
        let encoded = serde_json::to_vec_pretty(&record).map_err(|error| {
            provider_failure(format!(
                "failed to encode completed idempotency record: {error}"
            ))
        })?;
        let temp = self
            .directory
            .join(format!(".complete.{}.tmp", Uuid::new_v4().as_simple()));
        fs::write(&temp, encoded).map_err(|error| {
            provider_failure(format!(
                "failed to write completed idempotency record: {error}"
            ))
        })?;
        fs::rename(&temp, &paths.completed).map_err(|error| {
            let _ = fs::remove_file(&temp);
            provider_failure(format!(
                "failed to publish completed idempotency record: {error}"
            ))
        })?;
        let _ = fs::remove_file(&paths.pending);
        Ok(())
    }

    fn record_paths(
        &self,
        invocation: &InvocationEnvelope,
        key: &str,
    ) -> Result<RecordPaths, CapabilityError> {
        let identity = serde_json::to_vec(&json!({
            "principal_id": invocation
                .principal_id
                .as_deref()
                .unwrap_or("compat:unbound"),
            "device_id": invocation.device_id,
            "capability": invocation.capability,
            "idempotency_key": key,
        }))
        .map_err(|error| {
            provider_failure(format!("failed to encode idempotency identity: {error}"))
        })?;
        let id = sha256_hex(&identity);
        Ok(RecordPaths {
            pending: self.directory.join(format!("{id}.pending.json")),
            completed: self.directory.join(format!("{id}.complete.json")),
        })
    }
}

pub fn is_mutation_capability(capability: &str) -> bool {
    matches!(
        capability,
        "filesystem.write"
            | "filesystem.append"
            | "filesystem.mkdir"
            | "filesystem.move"
            | "filesystem.patch"
            | "filesystem.delete"
            | "process.run"
            | "process.input"
            | "process.terminate"
            | "job.create"
            | "job.checkpoint"
            | "job.acquire_lease"
            | "job.release_lease"
            | "batch.execute"
            | "browser.create_tab"
            | "browser.navigate"
            | "browser.close"
            | "browser.act"
            | "browser.upload"
    ) || capability.starts_with("browser.verified_action")
        || capability.starts_with("desktop.physical_")
}

pub fn conflict_result(invocation: &InvocationEnvelope) -> ResultEnvelope {
    error_result(invocation, idempotency_conflict(invocation))
}

pub fn pending_result(invocation: &InvocationEnvelope) -> ResultEnvelope {
    error_result(
        invocation,
        CapabilityError {
            code: ErrorCode::ActionUnverified,
            message: "a prior idempotent mutation was reserved but no final result was persisted"
                .into(),
            recovery_hint: Some(
                "inspect canonical state before deciding whether manual recovery is needed".into(),
            ),
            details: json!({ "capability": invocation.capability }),
        },
    )
}

pub fn store_failure_result(
    invocation: &InvocationEnvelope,
    error: CapabilityError,
) -> ResultEnvelope {
    error_result(invocation, error)
}

pub fn unavailable_result(invocation: &InvocationEnvelope) -> ResultEnvelope {
    error_result(
        invocation,
        CapabilityError {
            code: ErrorCode::ProviderFailure,
            message:
                "durable idempotency requires tetherd to run with a configured state directory"
                    .into(),
            recovery_hint: Some("restart tetherd with --state-dir".into()),
            details: json!({ "capability": invocation.capability }),
        },
    )
}

fn request_fingerprint(invocation: &InvocationEnvelope) -> Result<String, CapabilityError> {
    let bytes = serde_json::to_vec(&json!({
        "job_id": invocation.job_id,
        "session_id": invocation.session_id,
        "arguments": invocation.arguments,
        "preconditions": invocation.preconditions,
        "expectations": invocation.expectations,
    }))
    .map_err(|error| {
        provider_failure(format!("failed to encode idempotency fingerprint: {error}"))
    })?;
    Ok(sha256_hex(&bytes))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, label: &str) -> Result<T, CapabilityError> {
    let content = fs::read_to_string(path)
        .map_err(|error| provider_failure(format!("failed to read {label}: {error}")))?;
    serde_json::from_str(&content)
        .map_err(|error| provider_failure(format!("invalid {label}: {error}")))
}

fn idempotency_conflict(invocation: &InvocationEnvelope) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ResourceConflict,
        message: "idempotency key is already bound to a different mutation".into(),
        recovery_hint: Some("use a new idempotency key".into()),
        details: json!({ "capability": invocation.capability }),
    }
}

fn error_result(invocation: &InvocationEnvelope, error: CapabilityError) -> ResultEnvelope {
    ResultEnvelope {
        protocol_version: invocation.protocol_version.clone(),
        request_id: invocation.request_id,
        status: ResultStatus::Error,
        data: None,
        delta: None,
        error: Some(error),
        verification: VerificationStatus::Failed,
        continuation: None,
        policy: None,
        timing: Timing { duration_ms: 0 },
    }
}

fn provider_failure(message: String) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ProviderFailure,
        message,
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}
