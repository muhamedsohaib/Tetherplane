use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tether_core::{
    Actor, CapabilityError, CapabilityProvider, ErrorCode, InvocationEnvelope, ProviderResult,
    ResultEnvelope, VerificationStatus,
};
use uuid::Uuid;

const DEFAULT_AUDIT_LIMIT: usize = 100;
const MAX_AUDIT_LIMIT: usize = 500;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AuditEvent {
    pub event_id: String,
    pub timestamp_unix_ms: u64,
    pub principal_id: Option<String>,
    pub actor: Actor,
    pub job_id: Option<String>,
    pub request_id: String,
    pub device_id: Option<String>,
    pub capability: String,
    pub policy_decision: String,
    pub result_status: String,
    pub error_code: Option<String>,
    pub verification: String,
}

pub struct AuditStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl AuditStore {
    pub fn new(state_dir: &Path) -> Result<Self, CapabilityError> {
        let audit_dir = state_dir.join("audit");
        fs::create_dir_all(&audit_dir).map_err(|error| {
            provider_failure(format!("failed to create audit directory: {error}"))
        })?;
        Ok(Self {
            path: audit_dir.join("events.jsonl"),
            lock: Mutex::new(()),
        })
    }

    pub fn append(
        &self,
        invocation: &InvocationEnvelope,
        result: &ResultEnvelope,
    ) -> Result<(), CapabilityError> {
        let event = AuditEvent {
            event_id: format!("audit_{}", Uuid::new_v4().as_simple()),
            timestamp_unix_ms: now_ms()?,
            principal_id: invocation.principal_id.clone(),
            actor: invocation.actor.clone(),
            job_id: invocation.job_id.clone(),
            request_id: invocation.request_id.to_string(),
            device_id: invocation.device_id.clone(),
            capability: invocation.capability.clone(),
            policy_decision: policy_decision(result),
            result_status: enum_string(&result.status)?,
            error_code: result
                .error
                .as_ref()
                .map(|error| enum_string(&error.code))
                .transpose()?,
            verification: enum_string(&result.verification)?,
        };

        let encoded = serde_json::to_string(&event)
            .map_err(|error| provider_failure(format!("failed to encode audit event: {error}")))?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| provider_failure("audit lock is poisoned".into()))?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| provider_failure(format!("failed to open audit log: {error}")))?;
        file.write_all(encoded.as_bytes())
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.flush())
            .map_err(|error| provider_failure(format!("failed to append audit event: {error}")))
    }

    fn read(
        &self,
        principal_id: &str,
        job_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<AuditEvent>, CapabilityError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| provider_failure("audit lock is poisoned".into()))?;
        if !self.path.exists() {
            return Ok(Vec::new());
        }

        let file = fs::File::open(&self.path)
            .map_err(|error| provider_failure(format!("failed to read audit log: {error}")))?;
        let reader = BufReader::new(file);
        let mut events = Vec::new();

        for line in reader.lines() {
            let line = line.map_err(|error| {
                provider_failure(format!("failed to read audit event: {error}"))
            })?;
            let event = serde_json::from_str::<AuditEvent>(&line).map_err(|error| {
                provider_failure(format!("invalid persisted audit event: {error}"))
            })?;
            if event.principal_id.as_deref() != Some(principal_id) {
                continue;
            }
            if job_id.is_some_and(|expected| event.job_id.as_deref() != Some(expected)) {
                continue;
            }
            events.push(event);
        }

        let start = events.len().saturating_sub(limit);
        Ok(events.split_off(start))
    }
}

pub struct AuditProvider {
    store: Arc<AuditStore>,
}

impl AuditProvider {
    pub fn new(store: Arc<AuditStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl CapabilityProvider for AuditProvider {
    fn namespace(&self) -> &'static str {
        "audit"
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let operation = invocation
            .capability
            .strip_prefix("audit.")
            .ok_or_else(|| invalid_arguments("capability must use the audit namespace"))?;
        if operation != "read" {
            return Err(CapabilityError {
                code: ErrorCode::CapabilityUnavailable,
                message: format!("audit operation is unavailable: {operation}"),
                recovery_hint: None,
                details: json!({ "operation": operation }),
            });
        }

        let principal_id = invocation
            .principal_id
            .as_deref()
            .ok_or_else(|| CapabilityError {
                code: ErrorCode::PermissionDenied,
                message: "audit.read requires an authenticated principal".into(),
                recovery_hint: None,
                details: Value::Null,
            })?;
        let limit = invocation
            .arguments
            .get("limit")
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|value| usize::try_from(value).ok())
                    .filter(|value| *value > 0 && *value <= MAX_AUDIT_LIMIT)
                    .ok_or_else(|| invalid_arguments("audit limit must be between 1 and 500"))
            })
            .transpose()?
            .unwrap_or(DEFAULT_AUDIT_LIMIT);
        let job_id = invocation.arguments.get("job_id").and_then(Value::as_str);

        let events = self.store.read(principal_id, job_id, limit)?;
        Ok(ProviderResult {
            data: json!({ "events": events }),
            delta: None,
            verification: VerificationStatus::Verified,
        })
    }
}

fn policy_decision(result: &ResultEnvelope) -> String {
    match result.error.as_ref().map(|error| &error.code) {
        Some(ErrorCode::PermissionDenied) => "deny",
        Some(ErrorCode::ApprovalRequired) => "require_approval",
        _ => "allow",
    }
    .into()
}

fn enum_string<T: Serialize>(value: &T) -> Result<String, CapabilityError> {
    serde_json::to_value(value)
        .map_err(|error| provider_failure(format!("failed to encode audit enum: {error}")))?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| provider_failure("audit enum did not serialize as a string".into()))
}

fn now_ms() -> Result<u64, CapabilityError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| provider_failure(format!("system clock error: {error}")))?
        .as_millis();
    u64::try_from(millis)
        .map_err(|_| provider_failure("system clock exceeds supported range".into()))
}

fn invalid_arguments(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
        details: Value::Null,
    }
}

fn provider_failure(message: String) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ProviderFailure,
        message,
        recovery_hint: None,
        details: Value::Null,
    }
}
