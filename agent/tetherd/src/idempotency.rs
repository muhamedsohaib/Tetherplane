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
    /// Explicit unkeyed evidence: true when the runtime generated the key
    /// for a mutation the client submitted without one. Defaults to false
    /// so pre-S5 records (explicit keys only) still deserialize.
    #[serde(default)]
    auto_key: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct CompletedRecord {
    fingerprint: String,
    result: ResultEnvelope,
    /// Explicit unkeyed evidence, mirroring [`PendingRecord::auto_key`].
    #[serde(default)]
    auto_key: bool,
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

    pub fn reserve(
        &self,
        invocation: &InvocationEnvelope,
        auto_key: bool,
    ) -> Result<(), CapabilityError> {
        let key = invocation
            .idempotency_key
            .as_deref()
            .ok_or_else(|| provider_failure("idempotency key is missing".into()))?;
        let paths = self.record_paths(invocation, key)?;
        let record = PendingRecord {
            fingerprint: request_fingerprint(invocation)?,
            auto_key,
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
            })?;
        // Durable before execution: the reservation must survive OS/power
        // loss, not just process crash, so fsync the file and the
        // directory entry that names it.
        file.sync_all().map_err(|error| {
            provider_failure(format!("failed to fsync idempotency reservation: {error}"))
        })?;
        drop(file);
        sync_dir(&self.directory)
    }

    pub fn complete(
        &self,
        invocation: &InvocationEnvelope,
        result: &ResultEnvelope,
        auto_key: bool,
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
            auto_key,
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
        {
            let file = OpenOptions::new().read(true).open(&temp).map_err(|error| {
                provider_failure(format!(
                    "failed to reopen completed idempotency record: {error}"
                ))
            })?;
            file.sync_all().map_err(|error| {
                provider_failure(format!(
                    "failed to fsync completed idempotency record: {error}"
                ))
            })?;
        }
        fs::rename(&temp, &paths.completed).map_err(|error| {
            let _ = fs::remove_file(&temp);
            provider_failure(format!(
                "failed to publish completed idempotency record: {error}"
            ))
        })?;
        sync_dir(&self.directory)?;
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

/// Deterministic request-scoped key for a mutation the client submitted
/// without an explicit idempotency key. Scope: bound principal +
/// device + capability + request identity. Retrying the same request
/// reproduces the key (replay on identical payload, conflict on mutated
/// payload); a newly submitted request carries a new request identity
/// and therefore always executes. Auto keys dedupe retries of one
/// request only — they are explicitly NOT a cross-request
/// exactly-once guarantee. The `unkeyed-` prefix marks the provenance
/// in audit trails; the authoritative evidence flag is the `auto_key`
/// bit on the stored Pending/Completed record.
pub fn auto_idempotency_key(invocation: &InvocationEnvelope) -> String {
    let context = serde_json::to_vec(&json!({
        "principal_id": invocation.principal_id.as_deref().unwrap_or("compat:unbound"),
        "device_id": invocation.device_id,
        "capability": invocation.capability,
        "request_id": invocation.request_id,
    }));
    let bytes = context.unwrap_or_else(|_| invocation.request_id.as_bytes().to_vec());
    let digest = sha256_hex(&bytes);
    format!("unkeyed-{}", &digest[..32])
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

fn sync_dir(directory: &Path) -> Result<(), CapabilityError> {
    #[cfg(unix)]
    {
        let dir = OpenOptions::new()
            .read(true)
            .open(directory)
            .map_err(|error| {
                provider_failure(format!("failed to open idempotency directory: {error}"))
            })?;
        dir.sync_all().map_err(|error| {
            provider_failure(format!("failed to fsync idempotency directory: {error}"))
        })?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        // Directory fsync is a Unix durability primitive; file fsync above
        // still holds on other platforms.
        let _ = directory;
        Ok(())
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::{Actor, ActorKind, ResponseMode};

    fn invocation(key: Option<&str>) -> InvocationEnvelope {
        InvocationEnvelope {
            protocol_version: "1.0".to_owned(),
            request_id: Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap(),
            device_id: Some("Leno".to_owned()),
            principal_id: Some("model:test".to_owned()),
            job_id: None,
            capability: "filesystem.append".to_owned(),
            arguments: json!({ "path": "/tmp/x", "content": "x\n" }),
            actor: Actor {
                id: "test".to_owned(),
                kind: ActorKind::AiClient,
            },
            session_id: None,
            response_mode: ResponseMode::Compact,
            idempotency_key: key.map(str::to_owned),
            preconditions: vec![],
            expectations: vec![],
        }
    }

    fn unique_state_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tetherplane-idempotency-unit-{label}-{}-{}",
            std::process::id(),
            Uuid::new_v4().as_simple()
        ))
    }

    fn success_result(invocation: &InvocationEnvelope) -> ResultEnvelope {
        ResultEnvelope {
            protocol_version: invocation.protocol_version.clone(),
            request_id: invocation.request_id,
            status: ResultStatus::Success,
            data: Some(json!({})),
            delta: None,
            error: None,
            verification: VerificationStatus::Verified,
            continuation: None,
            policy: None,
            timing: Timing { duration_ms: 1 },
        }
    }

    #[test]
    fn auto_key_is_deterministic_and_marked_unkeyed() {
        let base = invocation(None);
        let first = auto_idempotency_key(&base);
        let second = auto_idempotency_key(&base);
        assert_eq!(first, second);
        assert!(
            first.starts_with("unkeyed-"),
            "auto key must carry the explicit unkeyed marker, got {first}"
        );
    }

    #[test]
    fn auto_key_is_scoped_to_context_and_request_identity() {
        let base = invocation(None);
        let base_key = auto_idempotency_key(&base);

        let mut other_request = base.clone();
        other_request.request_id = Uuid::new_v4();
        assert_ne!(auto_idempotency_key(&other_request), base_key);

        let mut other_principal = base.clone();
        other_principal.principal_id = Some("model:other".to_owned());
        assert_ne!(auto_idempotency_key(&other_principal), base_key);

        let mut other_device = base.clone();
        other_device.device_id = Some("Other".to_owned());
        assert_ne!(auto_idempotency_key(&other_device), base_key);

        let mut other_capability = base.clone();
        other_capability.capability = "filesystem.write".to_owned();
        assert_ne!(auto_idempotency_key(&other_capability), base_key);

        // Same context + same request identity reproduces the key, so a
        // retried request replays instead of re-executing.
        assert_eq!(auto_idempotency_key(&base), base_key);
    }

    #[test]
    fn reserve_without_complete_leaves_pending_never_replay() {
        let state_dir = unique_state_dir("pending");
        let store = IdempotencyStore::new(&state_dir).unwrap();
        let mut inv = invocation(None);
        inv.idempotency_key = Some(auto_idempotency_key(&inv));

        assert!(matches!(
            store.lookup(&inv).unwrap(),
            IdempotencyLookup::Miss
        ));
        store.reserve(&inv, true).unwrap();

        // The reserve→complete crash window stays explicitly uncertain:
        // Pending, never an automatic replay or re-execution.
        assert!(matches!(
            store.lookup(&inv).unwrap(),
            IdempotencyLookup::Pending
        ));

        // A mutated payload under the same key conflicts even while pending.
        let mut mutated = inv.clone();
        mutated.arguments = json!({ "path": "/tmp/x", "content": "different\n" });
        assert!(matches!(
            store.lookup(&mutated).unwrap(),
            IdempotencyLookup::Conflict
        ));

        std::fs::remove_dir_all(&state_dir).unwrap();
    }

    #[test]
    fn completed_record_marks_auto_key_evidence() {
        let state_dir = unique_state_dir("evidence");
        let store = IdempotencyStore::new(&state_dir).unwrap();

        let mut auto = invocation(None);
        auto.idempotency_key = Some(auto_idempotency_key(&auto));
        store.reserve(&auto, true).unwrap();
        let result = success_result(&auto);
        store.complete(&auto, &result, true).unwrap();
        let paths = store
            .record_paths(&auto, auto.idempotency_key.as_deref().unwrap())
            .unwrap();
        let raw = std::fs::read_to_string(&paths.completed).unwrap();
        assert!(
            raw.contains("\"auto_key\": true"),
            "auto-keyed completion must record the unkeyed evidence flag: {raw}"
        );

        let mut explicit = invocation(Some("explicit-evidence"));
        explicit.request_id = Uuid::new_v4();
        store.reserve(&explicit, false).unwrap();
        let result = success_result(&explicit);
        store.complete(&explicit, &result, false).unwrap();
        let paths = store
            .record_paths(&explicit, explicit.idempotency_key.as_deref().unwrap())
            .unwrap();
        let raw = std::fs::read_to_string(&paths.completed).unwrap();
        assert!(
            raw.contains("\"auto_key\": false"),
            "explicit keys must not masquerade as auto-keyed: {raw}"
        );

        std::fs::remove_dir_all(&state_dir).unwrap();
    }

    #[test]
    fn pre_s5_records_without_evidence_flag_still_read() {
        let state_dir = unique_state_dir("legacy");
        let store = IdempotencyStore::new(&state_dir).unwrap();
        let inv = invocation(Some("legacy-key"));

        // Simulate a record written before S5 added `auto_key`: the flag
        // defaults to false (explicit) and the record still reads.
        let paths = store.record_paths(&inv, "legacy-key").unwrap();
        let fingerprint = request_fingerprint(&inv).unwrap();
        std::fs::write(
            &paths.pending,
            format!("{{\"fingerprint\": \"{fingerprint}\"}}"),
        )
        .unwrap();
        assert!(matches!(
            store.lookup(&inv).unwrap(),
            IdempotencyLookup::Pending
        ));

        std::fs::remove_dir_all(&state_dir).unwrap();
    }
}
