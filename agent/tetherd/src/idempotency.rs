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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationPhase {
    Accepted,
    Running,
    Completed,
    Failed,
    TimedOut,
    OutcomeUnknown,
    #[default]
    ReconciliationRequired,
}

#[derive(Debug, Deserialize, Serialize)]
struct PendingRecord {
    fingerprint: String,
    #[serde(default)]
    generation: Option<Uuid>,
    #[serde(default)]
    phase: MutationPhase,
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

// A failed fsync or publication must stop dispatch (or make the already
// executed result uncertain). Temporary records are retained for diagnosis.
fn create_synced(path: &Path, encoded: &[u8], label: &str) -> Result<(), CapabilityError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| provider_failure(format!("failed to create {label}: {error}")))?;
    file.write_all(encoded)
        .and_then(|()| file.sync_all())
        .map_err(|error| provider_failure(format!("failed to sync {label}: {error}")))
}

fn sync_directory(path: &Path) -> Result<(), CapabilityError> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                provider_failure(format!("failed to sync idempotency directory: {error}"))
            })
    }
    #[cfg(not(unix))]
    {
        // Rust std cannot portably fsync a Windows directory entry. File data
        // is synced before publication; power-loss metadata durability remains
        // an explicit Windows release gate, not a claimed guarantee.
        if !path.is_dir() {
            return Err(provider_failure(
                "idempotency directory is unavailable".into(),
            ));
        }
        Ok(())
    }
}

fn publish_synced(
    directory: &Path,
    temporary: &Path,
    destination: &Path,
    encoded: &[u8],
    label: &str,
) -> Result<(), CapabilityError> {
    create_synced(temporary, encoded, label)?;
    fs::rename(temporary, destination)
        .map_err(|error| provider_failure(format!("failed to publish {label}: {error}")))?;
    sync_directory(directory)
}

pub struct IdempotencyStore {
    directory: PathBuf,
    generation: Uuid,
}

impl IdempotencyStore {
    pub fn new(state_dir: &Path) -> Result<Self, CapabilityError> {
        let directory = state_dir.join("idempotency");
        fs::create_dir_all(&directory).map_err(|error| {
            provider_failure(format!("failed to create idempotency directory: {error}"))
        })?;
        // Persist this directory name in the existing state directory on Unix.
        // A newly created ancestor still needs separately verified provisioning.
        sync_directory(state_dir)?;
        Ok(Self {
            directory,
            generation: Uuid::new_v4(),
        })
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
            generation: Some(self.generation),
            phase: MutationPhase::Accepted,
        };
        let encoded = serde_json::to_vec_pretty(&record).map_err(|error| {
            provider_failure(format!(
                "failed to encode pending idempotency record: {error}"
            ))
        })?;

        create_synced(&paths.pending, &encoded, "idempotency reservation")?;
        sync_directory(&self.directory)
    }

    /// Persist execution start before invoking an external mutation.
    /// A mismatch or a restarted generation cannot be silently resumed.
    pub fn mark_running(&self, invocation: &InvocationEnvelope) -> Result<(), CapabilityError> {
        let key = invocation
            .idempotency_key
            .as_deref()
            .ok_or_else(|| provider_failure("idempotency key is missing".into()))?;
        let paths = self.record_paths(invocation, key)?;
        let mut record = read_json::<PendingRecord>(&paths.pending, "pending idempotency record")?;
        if record.fingerprint != request_fingerprint(invocation)?
            || record.generation != Some(self.generation)
        {
            return Err(idempotency_conflict(invocation));
        }
        record.phase = MutationPhase::Running;
        let temporary = self
            .directory
            .join(format!(".running.{}.tmp", Uuid::new_v4().as_simple()));
        let content = serde_json::to_vec_pretty(&record).map_err(|error| {
            provider_failure(format!("failed to encode running mutation: {error}"))
        })?;
        publish_synced(
            &self.directory,
            &temporary,
            &paths.pending,
            &content,
            "running idempotency record",
        )?;
        Ok(())
    }

    /// Trusted local status: a foreign generation is always uncertain.
    /// This never runs or retries a mutation.
    pub fn operation_phase(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<Option<MutationPhase>, CapabilityError> {
        let Some(key) = invocation.idempotency_key.as_deref() else {
            return Ok(None);
        };
        let paths = self.record_paths(invocation, key)?;
        let fingerprint = request_fingerprint(invocation)?;
        if paths.completed.exists() {
            let record =
                read_json::<CompletedRecord>(&paths.completed, "completed idempotency record")?;
            if record.fingerprint != fingerprint {
                return Err(idempotency_conflict(invocation));
            }
            let phase = if matches!(&record.result.status, ResultStatus::Success) {
                MutationPhase::Completed
            } else if matches!(
                record.result.error.as_ref().map(|e| &e.code),
                Some(ErrorCode::Timeout)
            ) {
                MutationPhase::TimedOut
            } else if matches!(
                record.result.error.as_ref().map(|e| &e.code),
                Some(ErrorCode::ActionUnverified)
            ) {
                MutationPhase::OutcomeUnknown
            } else {
                MutationPhase::Failed
            };
            return Ok(Some(phase));
        }
        if paths.pending.exists() {
            let record = read_json::<PendingRecord>(&paths.pending, "pending idempotency record")?;
            if record.fingerprint != fingerprint {
                return Err(idempotency_conflict(invocation));
            }
            if record.generation != Some(self.generation) {
                return Ok(Some(MutationPhase::ReconciliationRequired));
            }
            return Ok(Some(record.phase));
        }
        Ok(None)
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
        publish_synced(
            &self.directory,
            &temp,
            &paths.completed,
            &encoded,
            "completed idempotency record",
        )?;
        // Completion has been published before removing the durable pending
        // fence. An interrupted cleanup leaves both records; lookup prefers
        // authoritative completed results.
        let _ = fs::remove_file(&paths.pending);
        sync_directory(&self.directory)?;
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

// An effect may already have happened even when persisting its result fails.
// Never label this a failed external mutation or allow automatic retry.
pub fn completion_unverified_result(invocation: &InvocationEnvelope) -> ResultEnvelope {
    let mut result = pending_result(invocation);
    if let Some(error) = result.error.as_mut() {
        error.message =
            "mutation outcome is uncertain because completion could not be durably recorded".into();
        error.details["operation_phase"] = json!("reconciliation_required");
    }
    result
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

#[cfg(test)]
mod lifecycle_tests {
    use super::{IdempotencyLookup, IdempotencyStore, MutationPhase};
    use serde_json::json;
    use std::io::Write as _;

    fn invocation() -> tether_core::InvocationEnvelope {
        serde_json::from_value(json!({
            "protocol_version": "1.0",
            "request_id": uuid::Uuid::new_v4(),
            "device_id": "Leno",
            "principal_id": "operator:isolated-test",
            "job_id": null,
            "capability": "filesystem.append",
            "arguments": { "path": "isolated", "content": "nonsecret" },
            "actor": { "id": "test", "kind": "ai_client" },
            "session_id": null,
            "response_mode": "compact",
            "idempotency_key": "phase4-key",
            "preconditions": [],
            "expectations": []
        }))
        .unwrap()
    }

    #[test]
    fn pending_mutation_requires_reconciliation_after_process_restart() {
        let root =
            std::env::temp_dir().join(format!("tp-phase4-{}", uuid::Uuid::new_v4().simple()));
        let request = invocation();
        let store = IdempotencyStore::new(&root).unwrap();
        store.reserve(&request).unwrap();
        assert_eq!(
            store.operation_phase(&request).unwrap(),
            Some(MutationPhase::Accepted)
        );
        store.mark_running(&request).unwrap();
        assert_eq!(
            store.operation_phase(&request).unwrap(),
            Some(MutationPhase::Running)
        );
        drop(store);

        let reopened = IdempotencyStore::new(&root).unwrap();
        assert_eq!(
            reopened.operation_phase(&request).unwrap(),
            Some(MutationPhase::ReconciliationRequired)
        );
        assert!(matches!(
            reopened.lookup(&request).unwrap(),
            IdempotencyLookup::Pending
        ));
        // Never infer failure, clear a reservation, or restart execution.
        std::fs::remove_dir_all(root).unwrap();
    }

    fn completed_result(request: &tether_core::InvocationEnvelope) -> tether_core::ResultEnvelope {
        serde_json::from_value(json!({
            "protocol_version": "1.0",
            "request_id": request.request_id,
            "status": "success",
            "data": {"effect": "once"},
            "delta": null,
            "error": null,
            "verification": "verified",
            "continuation": null,
            "policy": null,
            "timing": {"duration_ms": 0}
        }))
        .unwrap()
    }

    #[test]
    fn isolated_crash_worker() {
        let Ok(scenario) = std::env::var("TETHERPLANE_PHASE4B_CRASH_CASE") else {
            return;
        };
        let root =
            std::path::PathBuf::from(std::env::var("TETHERPLANE_PHASE4B_CRASH_ROOT").unwrap());
        let store = IdempotencyStore::new(&root).unwrap();
        let request = invocation();
        store.reserve(&request).unwrap();
        if scenario != "reserved" {
            store.mark_running(&request).unwrap();
        }
        if scenario == "effect_unrecorded" || scenario == "completion_unacknowledged" {
            let effect_path = root.join("external-effect.txt");
            let mut effect = std::fs::File::create(effect_path).unwrap();
            effect.write_all(b"once").unwrap();
            effect.sync_all().unwrap();
        }
        if scenario == "completion_unacknowledged" {
            store
                .complete(&request, &completed_result(&request))
                .unwrap();
        }
        std::fs::write(root.join("ready-to-kill"), "ready").unwrap();
        // The parent kills this isolated process after observing the marker.
        // Neither the normal application return path nor acknowledgment runs.
        loop {
            std::thread::park();
        }
    }

    #[test]
    fn subprocess_termination_preserves_reconciliation_and_completed_replay() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        for scenario in [
            "reserved",
            "running",
            "effect_unrecorded",
            "completion_unacknowledged",
        ] {
            let root = std::env::temp_dir().join(format!(
                "tetherplane-phase4b-child-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let mut child = Command::new(std::env::current_exe().unwrap())
                .arg("--exact")
                .arg("idempotency::lifecycle_tests::isolated_crash_worker")
                .arg("--nocapture")
                .env("TETHERPLANE_PHASE4B_CRASH_CASE", scenario)
                .env("TETHERPLANE_PHASE4B_CRASH_ROOT", &root)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !root.join("ready-to-kill").exists() {
                if Instant::now() >= deadline || child.try_wait().unwrap().is_some() {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("worker did not reach crash barrier for {scenario}");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            child.kill().unwrap();
            assert!(!child.wait().unwrap().success());

            let reopened = IdempotencyStore::new(&root).unwrap();
            let retry = invocation();
            let phase = reopened.operation_phase(&retry).unwrap();
            if scenario == "completion_unacknowledged" {
                assert_eq!(phase, Some(MutationPhase::Completed));
                match reopened.lookup(&retry).unwrap() {
                    IdempotencyLookup::Replay(result) => {
                        assert_eq!(result.data, Some(json!({"effect":"once"})));
                        assert_eq!(result.request_id, retry.request_id);
                    }
                    other => panic!("must replay durably recorded result: {other:?}"),
                }
            } else {
                assert_eq!(phase, Some(MutationPhase::ReconciliationRequired));
                assert!(matches!(
                    reopened.lookup(&retry).unwrap(),
                    IdempotencyLookup::Pending
                ));
            }
            assert_eq!(
                root.join("external-effect.txt").exists(),
                matches!(scenario, "effect_unrecorded" | "completion_unacknowledged")
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn malformed_pending_record_fails_closed_after_restart() {
        let root = std::env::temp_dir().join(format!(
            "tetherplane-phase4b-malformed-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let request = invocation();
        let store = IdempotencyStore::new(&root).unwrap();
        store.reserve(&request).unwrap();
        let paths = store.record_paths(&request, "phase4-key").unwrap();
        std::fs::write(paths.pending, b"{\"fingerprint\":").unwrap();
        drop(store);
        let reopened = IdempotencyStore::new(&root).unwrap();
        assert!(reopened.lookup(&request).is_err());
        assert!(reopened.operation_phase(&request).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn storage_creation_and_rename_errors_never_clear_pending_fence() {
        use super::{create_synced, publish_synced};
        let root = std::env::temp_dir().join(format!(
            "tetherplane-phase4b-storage-error-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let request = invocation();
        let store = IdempotencyStore::new(&root).unwrap();
        let paths = store.record_paths(&request, "phase4-key").unwrap();
        std::fs::create_dir_all(&paths.pending).unwrap();
        assert!(store.reserve(&request).is_err());
        std::fs::remove_dir_all(&paths.pending).unwrap();

        store.reserve(&request).unwrap();
        store.mark_running(&request).unwrap();
        let destination_directory = store.directory.join("rename-target");
        std::fs::create_dir_all(&destination_directory).unwrap();
        let temp = store.directory.join("test-rename.tmp");
        assert!(
            publish_synced(
                &store.directory,
                &temp,
                &destination_directory,
                b"{}",
                "test rename",
            )
            .is_err()
        );
        assert!(
            temp.exists(),
            "failed publication retains diagnostic record"
        );
        let missing_parent = root.join("nonexistent").join("temp");
        assert!(create_synced(&missing_parent, b"{}", "test write").is_err());

        // A blocked completion path models an I/O failure after an effect.
        std::fs::create_dir_all(&paths.completed).unwrap();
        assert!(
            store
                .complete(&request, &completed_result(&request))
                .is_err()
        );
        std::fs::remove_dir_all(&paths.completed).unwrap();
        drop(store);
        let reopened = IdempotencyStore::new(&root).unwrap();
        assert_eq!(
            reopened.operation_phase(&request).unwrap(),
            Some(MutationPhase::ReconciliationRequired)
        );
        assert!(matches!(
            reopened.lookup(&request).unwrap(),
            IdempotencyLookup::Pending
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn competing_store_generations_cannot_reserve_the_same_key_twice() {
        use std::sync::{Arc, Barrier};
        let root = std::env::temp_dir().join(format!(
            "tetherplane-phase4b-cross-generation-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let first = IdempotencyStore::new(&root).unwrap();
        let second = IdempotencyStore::new(&root).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let ready_a = Arc::clone(&barrier);
        let ready_b = Arc::clone(&barrier);
        let task_a = std::thread::spawn(move || {
            ready_a.wait();
            first.reserve(&invocation()).is_ok()
        });
        let task_b = std::thread::spawn(move || {
            ready_b.wait();
            second.reserve(&invocation()).is_ok()
        });
        barrier.wait();
        let a = task_a.join().unwrap();
        let b = task_b.join().unwrap();
        assert_ne!(a, b, "create_new must admit exactly one writer");
        let reopened = IdempotencyStore::new(&root).unwrap();
        assert_eq!(
            reopened.operation_phase(&invocation()).unwrap(),
            Some(MutationPhase::ReconciliationRequired)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persisted_phase_matches_recorded_transitions_and_restart() {
        let root = std::env::temp_dir().join(format!(
            "tetherplane-phase4b-phase-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let request = invocation();
        let store = IdempotencyStore::new(&root).unwrap();
        store.reserve(&request).unwrap();
        assert_eq!(
            store.operation_phase(&request).unwrap(),
            Some(MutationPhase::Accepted)
        );
        store.mark_running(&request).unwrap();
        assert_eq!(
            store.operation_phase(&request).unwrap(),
            Some(MutationPhase::Running)
        );
        store
            .complete(&request, &completed_result(&request))
            .unwrap();
        assert_eq!(
            store.operation_phase(&request).unwrap(),
            Some(MutationPhase::Completed)
        );
        drop(store);
        let reopened = IdempotencyStore::new(&root).unwrap();
        assert_eq!(
            reopened.operation_phase(&request).unwrap(),
            Some(MutationPhase::Completed)
        );
        assert!(matches!(
            reopened.lookup(&request).unwrap(),
            IdempotencyLookup::Replay(_)
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completion_persistence_error_must_be_action_unverified() {
        use super::completion_unverified_result;
        let request = invocation();
        let result = completion_unverified_result(&request);
        assert_eq!(
            result.error.as_ref().unwrap().details["operation_phase"],
            "reconciliation_required"
        );
        assert!(matches!(
            result.error.as_ref().unwrap().code,
            tether_core::ErrorCode::ActionUnverified
        ));
    }
}
