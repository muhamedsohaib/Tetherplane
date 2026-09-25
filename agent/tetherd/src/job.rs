use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tether_core::{
    CapabilityError, CapabilityProvider, ErrorCode, InvocationEnvelope, ProviderResult,
    VerificationStatus,
};
use uuid::Uuid;

const DEFAULT_LEASE_TTL_MS: u64 = 60_000;
const MAX_LEASE_TTL_MS: u64 = 3_600_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct JobCheckpoint {
    checkpoint_id: String,
    principal_id: String,
    state: Value,
    created_at_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ExecutionLease {
    lease_id: String,
    principal_id: String,
    expires_at_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct JobRecord {
    job_id: String,
    objective: String,
    target_device: String,
    creator_principal: String,
    permitted_principals: BTreeSet<String>,
    status: String,
    latest_checkpoint: Option<JobCheckpoint>,
    active_lease: Option<ExecutionLease>,
    created_at_unix_ms: u64,
    updated_at_unix_ms: u64,
}

pub struct JobProvider {
    jobs_dir: PathBuf,
    lock: Mutex<()>,
}

impl JobProvider {
    pub fn new(state_dir: &Path) -> Result<Self, CapabilityError> {
        let jobs_dir = state_dir.join("jobs");
        fs::create_dir_all(&jobs_dir).map_err(|error| {
            provider_failure(format!("failed to create job state directory: {error}"))
        })?;
        Ok(Self {
            jobs_dir,
            lock: Mutex::new(()),
        })
    }

    fn create_job(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let principal = authenticated_principal(invocation)?;
        let objective = invocation
            .arguments
            .get("objective")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| invalid_arguments("job.create requires non-empty objective"))?;
        let target_device = invocation
            .arguments
            .get("target_device")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| invocation.device_id.clone())
            .ok_or_else(|| invalid_arguments("job.create requires target device"))?;

        let mut permitted_principals =
            parse_principals(invocation.arguments.get("permitted_principals"))?;
        permitted_principals.insert(principal.to_owned());

        let now = now_ms()?;
        let record = JobRecord {
            job_id: format!("job_{}", Uuid::new_v4().as_simple()),
            objective: objective.to_owned(),
            target_device,
            creator_principal: principal.to_owned(),
            permitted_principals,
            status: "active".into(),
            latest_checkpoint: None,
            active_lease: None,
            created_at_unix_ms: now,
            updated_at_unix_ms: now,
        };

        let _guard = self
            .lock
            .lock()
            .map_err(|_| provider_failure("job state lock is poisoned".into()))?;
        self.store(&record)?;
        provider_result(&record)
    }

    fn get_job(&self, invocation: &InvocationEnvelope) -> Result<ProviderResult, CapabilityError> {
        let principal = authenticated_principal(invocation)?;
        let job_id = requested_job_id(invocation)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| provider_failure("job state lock is poisoned".into()))?;
        let mut record = self.load(job_id)?;
        ensure_job_access(&record, principal)?;

        if prune_expired_lease(&mut record, now_ms()?) {
            record.updated_at_unix_ms = now_ms()?;
            self.store(&record)?;
        }

        provider_result(&record)
    }

    fn list_jobs(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let principal = authenticated_principal(invocation)?;
        let requested_status = invocation
            .arguments
            .get("status")
            .map(|value| {
                value
                    .as_str()
                    .filter(|status| !status.trim().is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| invalid_arguments("status must be a non-empty string"))
            })
            .transpose()?;
        let unleased = invocation
            .arguments
            .get("unleased")
            .map(|value| {
                value
                    .as_bool()
                    .ok_or_else(|| invalid_arguments("unleased must be a boolean"))
            })
            .transpose()?
            .unwrap_or(false);
        let limit = invocation
            .arguments
            .get("limit")
            .map(|value| {
                value
                    .as_u64()
                    .filter(|limit| *limit > 0 && *limit <= 100)
                    .ok_or_else(|| invalid_arguments("limit must be between 1 and 100"))
            })
            .transpose()?
            .unwrap_or(100);
        let limit = usize::try_from(limit)
            .map_err(|_| invalid_arguments("limit exceeds platform range"))?;

        let _guard = self
            .lock
            .lock()
            .map_err(|_| provider_failure("job state lock is poisoned".into()))?;

        let now = now_ms()?;
        let mut paths = fs::read_dir(&self.jobs_dir)
            .map_err(|error| provider_failure(format!("failed to list job state: {error}")))?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect::<Vec<_>>();
        paths.sort();

        let mut jobs = Vec::new();
        for path in paths {
            let content = fs::read_to_string(&path)
                .map_err(|error| provider_failure(format!("failed to read job record: {error}")))?;
            let mut record = serde_json::from_str::<JobRecord>(&content).map_err(|error| {
                provider_failure(format!("invalid persisted job record: {error}"))
            })?;

            if !record.permitted_principals.contains(principal) {
                continue;
            }

            if prune_expired_lease(&mut record, now) {
                record.updated_at_unix_ms = now;
                self.store(&record)?;
            }
            if requested_status
                .as_deref()
                .is_some_and(|status| record.status != status)
            {
                continue;
            }
            if unleased && record.active_lease.is_some() {
                continue;
            }

            jobs.push(record);
        }

        jobs.sort_by(|left, right| {
            left.created_at_unix_ms
                .cmp(&right.created_at_unix_ms)
                .then_with(|| left.job_id.cmp(&right.job_id))
        });
        jobs.truncate(limit);

        provider_result(&json!({ "jobs": jobs }))
    }

    fn checkpoint(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let principal = authenticated_principal(invocation)?;
        let job_id = requested_job_id(invocation)?;
        let state = invocation
            .arguments
            .get("state")
            .filter(|value| value.is_object())
            .ok_or_else(|| invalid_arguments("job.checkpoint requires object args.state"))?;
        if contains_private_reasoning(state) {
            return Err(invalid_arguments(
                "checkpoint state must not contain private reasoning fields",
            ));
        }

        let requested_status = invocation
            .arguments
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_owned);

        let _guard = self
            .lock
            .lock()
            .map_err(|_| provider_failure("job state lock is poisoned".into()))?;
        let mut record = self.load(job_id)?;
        ensure_job_access(&record, principal)?;
        let now = now_ms()?;
        prune_expired_lease(&mut record, now);
        require_active_lease(&record, principal)?;

        record.latest_checkpoint = Some(JobCheckpoint {
            checkpoint_id: format!("checkpoint_{}", Uuid::new_v4().as_simple()),
            principal_id: principal.to_owned(),
            state: state.clone(),
            created_at_unix_ms: now,
        });
        if let Some(status) = requested_status {
            if status.trim().is_empty() {
                return Err(invalid_arguments("checkpoint status cannot be empty"));
            }
            record.status = status;
        }
        record.updated_at_unix_ms = now;
        self.store(&record)?;
        provider_result(&record)
    }

    fn acquire_lease(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let principal = authenticated_principal(invocation)?;
        let job_id = requested_job_id(invocation)?;
        let ttl_ms = invocation
            .arguments
            .get("ttl_ms")
            .map(|value| {
                value
                    .as_u64()
                    .filter(|ttl| *ttl > 0 && *ttl <= MAX_LEASE_TTL_MS)
                    .ok_or_else(|| invalid_arguments("ttl_ms must be between 1 and 3600000"))
            })
            .transpose()?
            .unwrap_or(DEFAULT_LEASE_TTL_MS);

        let _guard = self
            .lock
            .lock()
            .map_err(|_| provider_failure("job state lock is poisoned".into()))?;
        let mut record = self.load(job_id)?;
        ensure_job_access(&record, principal)?;

        let now = now_ms()?;
        prune_expired_lease(&mut record, now);
        if let Some(lease) = &record.active_lease {
            return Err(CapabilityError {
                code: ErrorCode::ResourceConflict,
                message: "job already has an active execution lease".into(),
                recovery_hint: Some("retry after the active lease is released or expires".into()),
                details: json!({
                    "job_id": record.job_id,
                    "lease_id": lease.lease_id,
                    "principal_id": lease.principal_id,
                    "expires_at_unix_ms": lease.expires_at_unix_ms,
                }),
            });
        }

        record.active_lease = Some(ExecutionLease {
            lease_id: format!("lease_{}", Uuid::new_v4().as_simple()),
            principal_id: principal.to_owned(),
            expires_at_unix_ms: now.saturating_add(ttl_ms),
        });
        record.updated_at_unix_ms = now;
        self.store(&record)?;
        provider_result(&record)
    }

    fn release_lease(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let principal = authenticated_principal(invocation)?;
        let job_id = requested_job_id(invocation)?;

        let _guard = self
            .lock
            .lock()
            .map_err(|_| provider_failure("job state lock is poisoned".into()))?;
        let mut record = self.load(job_id)?;
        ensure_job_access(&record, principal)?;

        let now = now_ms()?;
        prune_expired_lease(&mut record, now);
        let lease = record
            .active_lease
            .as_ref()
            .ok_or_else(|| CapabilityError {
                code: ErrorCode::ResourceConflict,
                message: "job has no active execution lease".into(),
                recovery_hint: None,
                details: json!({ "job_id": record.job_id }),
            })?;

        if lease.principal_id != principal {
            return Err(CapabilityError {
                code: ErrorCode::PermissionDenied,
                message: "only the active lease principal may release the lease".into(),
                recovery_hint: None,
                details: json!({
                    "job_id": record.job_id,
                    "lease_principal": lease.principal_id,
                }),
            });
        }

        if let Some(expected_lease_id) =
            invocation.arguments.get("lease_id").and_then(Value::as_str)
            && expected_lease_id != lease.lease_id
        {
            return Err(CapabilityError {
                code: ErrorCode::ResourceConflict,
                message: "lease_id does not match the active lease".into(),
                recovery_hint: None,
                details: json!({
                    "job_id": record.job_id,
                    "active_lease_id": lease.lease_id,
                }),
            });
        }

        record.active_lease = None;
        record.updated_at_unix_ms = now;
        self.store(&record)?;
        provider_result(&record)
    }

    fn load(&self, job_id: &str) -> Result<JobRecord, CapabilityError> {
        validate_job_id(job_id)?;
        let path = self.jobs_dir.join(format!("{job_id}.json"));
        let content = fs::read_to_string(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                invalid_arguments("job_id does not exist")
            } else {
                provider_failure(format!("failed to read job record: {error}"))
            }
        })?;
        serde_json::from_str(&content)
            .map_err(|error| provider_failure(format!("invalid persisted job record: {error}")))
    }

    fn store(&self, record: &JobRecord) -> Result<(), CapabilityError> {
        let path = self.jobs_dir.join(format!("{}.json", record.job_id));
        let temp = self.jobs_dir.join(format!(
            ".{}.{}.tmp",
            record.job_id,
            Uuid::new_v4().as_simple()
        ));
        let encoded = serde_json::to_vec_pretty(record)
            .map_err(|error| provider_failure(format!("failed to encode job record: {error}")))?;
        fs::write(&temp, encoded)
            .map_err(|error| provider_failure(format!("failed to write job record: {error}")))?;

        if path.exists() {
            fs::remove_file(&path).map_err(|error| {
                provider_failure(format!("failed to replace job record: {error}"))
            })?;
        }
        fs::rename(&temp, &path)
            .map_err(|error| provider_failure(format!("failed to publish job record: {error}")))?;
        Ok(())
    }
}

#[async_trait]
impl CapabilityProvider for JobProvider {
    fn namespace(&self) -> &'static str {
        "job"
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let operation = invocation
            .capability
            .strip_prefix("job.")
            .ok_or_else(|| invalid_arguments("capability must use the job namespace"))?;

        match operation {
            "create" => self.create_job(invocation),
            "get" => self.get_job(invocation),
            "list" => self.list_jobs(invocation),
            "checkpoint" => self.checkpoint(invocation),
            "acquire_lease" => self.acquire_lease(invocation),
            "release_lease" => self.release_lease(invocation),
            _ => Err(CapabilityError {
                code: ErrorCode::CapabilityUnavailable,
                message: format!("job operation is unavailable: {operation}"),
                recovery_hint: None,
                details: json!({ "operation": operation }),
            }),
        }
    }
}

fn authenticated_principal(invocation: &InvocationEnvelope) -> Result<&str, CapabilityError> {
    invocation
        .principal_id
        .as_deref()
        .ok_or_else(|| CapabilityError {
            code: ErrorCode::PermissionDenied,
            message: "job operations require an authenticated principal".into(),
            recovery_hint: None,
            details: serde_json::json!({}),
        })
}

fn requested_job_id(invocation: &InvocationEnvelope) -> Result<&str, CapabilityError> {
    let job_id = invocation
        .arguments
        .get("job_id")
        .and_then(Value::as_str)
        .or(invocation.job_id.as_deref())
        .ok_or_else(|| invalid_arguments("job operation requires job_id"))?;
    validate_job_id(job_id)?;
    Ok(job_id)
}

fn validate_job_id(job_id: &str) -> Result<(), CapabilityError> {
    let Some(suffix) = job_id.strip_prefix("job_") else {
        return Err(invalid_arguments("invalid job_id"));
    };
    if suffix.len() != 32
        || !suffix
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(invalid_arguments("invalid job_id"));
    }
    Ok(())
}

fn parse_principals(value: Option<&Value>) -> Result<BTreeSet<String>, CapabilityError> {
    let Some(value) = value else {
        return Ok(BTreeSet::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| invalid_arguments("permitted_principals must be an array"))?;
    let mut principals = BTreeSet::new();
    for item in values {
        let principal = item
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                invalid_arguments("permitted_principals must contain non-empty strings")
            })?;
        principals.insert(principal.to_owned());
    }
    Ok(principals)
}

fn ensure_job_access(record: &JobRecord, principal: &str) -> Result<(), CapabilityError> {
    if record.permitted_principals.contains(principal) {
        return Ok(());
    }
    Err(CapabilityError {
        code: ErrorCode::PermissionDenied,
        message: "principal is not permitted to access this job".into(),
        recovery_hint: None,
        details: json!({
            "job_id": record.job_id,
            "principal_id": principal,
        }),
    })
}

fn require_active_lease(record: &JobRecord, principal: &str) -> Result<(), CapabilityError> {
    let lease = record
        .active_lease
        .as_ref()
        .ok_or_else(|| CapabilityError {
            code: ErrorCode::ResourceConflict,
            message: "job checkpoint requires an active execution lease".into(),
            recovery_hint: Some("acquire the job execution lease first".into()),
            details: json!({ "job_id": record.job_id }),
        })?;
    if lease.principal_id == principal {
        return Ok(());
    }
    Err(CapabilityError {
        code: ErrorCode::PermissionDenied,
        message: "active execution lease is held by another principal".into(),
        recovery_hint: None,
        details: json!({
            "job_id": record.job_id,
            "lease_principal": lease.principal_id,
        }),
    })
}

fn prune_expired_lease(record: &mut JobRecord, now: u64) -> bool {
    if record
        .active_lease
        .as_ref()
        .is_some_and(|lease| lease.expires_at_unix_ms <= now)
    {
        record.active_lease = None;
        return true;
    }
    false
}

fn contains_private_reasoning(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "reasoning" | "chain_of_thought" | "private_reasoning" | "cot"
            ) || contains_private_reasoning(value)
        }),
        Value::Array(values) => values.iter().any(contains_private_reasoning),
        _ => false,
    }
}

fn now_ms() -> Result<u64, CapabilityError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| provider_failure(format!("system clock error: {error}")))?
        .as_millis();
    u64::try_from(millis)
        .map_err(|_| provider_failure("system clock exceeds supported range".into()))
}

fn provider_result<T: Serialize>(value: &T) -> Result<ProviderResult, CapabilityError> {
    let data = serde_json::to_value(value)
        .map_err(|error| provider_failure(format!("failed to encode job result: {error}")))?;
    Ok(ProviderResult {
        data,
        delta: None,
        verification: VerificationStatus::Verified,
    })
}

fn invalid_arguments(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
        details: serde_json::json!({}),
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
