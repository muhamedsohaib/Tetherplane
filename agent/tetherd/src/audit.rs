use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tether_core::{
    Actor, CapabilityError, CapabilityProvider, ErrorCode, InvocationEnvelope, ProviderResult,
    ResultEnvelope, VerificationStatus,
};
use uuid::Uuid;

use crate::idempotency::request_fingerprint;

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
    ) -> Result<String, CapabilityError> {
        let event = AuditEvent {
            event_id: format!("audit_{}", Uuid::new_v4().as_simple()),
            timestamp_unix_ms: now_ms()?,
            principal_id: invocation.principal_id.clone(),
            actor: invocation.actor.clone(),
            job_id: audit_job_id(invocation, result),
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
            .map_err(|error| provider_failure(format!("failed to append audit event: {error}")))?;
        Ok(event.event_id)
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

/// Transport context for one execution, supplied by the caller that owns
/// the connection lifecycle. Fields stay `None` when the caller cannot
/// observe them; the builder turns every absence into an explicit
/// `observation_gaps` entry instead of guessing.
#[derive(Clone, Debug)]
pub struct EvidenceContext {
    pub transport: Option<String>,
    pub generation: Option<String>,
    pub route_id: Option<String>,
}

impl EvidenceContext {
    #[must_use]
    pub fn unspecified() -> Self {
        Self {
            transport: None,
            generation: None,
            route_id: None,
        }
    }
}

/// How the runtime disposed of the invocation. This is what lets evidence
/// distinguish a fresh execution from duplicate handling and from
/// store-availability failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidenceDispatch {
    Executed,
    Replayed,
    Conflict,
    Pending,
    Direct,
    DirectUntracked,
    StoreUnavailable,
    StoreFailure,
}

/// Provenance of the effective idempotency key: supplied by the client,
/// generated for an unkeyed mutation (S5), or ignored because the
/// capability is not a mutation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKeyScope {
    Explicit,
    Auto,
    Ignored,
}

/// Tracked provider health observed alongside an executed outcome. Only
/// ever attached to paths that actually executed; replay/conflict/store
/// verdicts describe the store, not the provider.
#[derive(Clone, Debug)]
pub struct DegradedObservation {
    pub state: String,
    pub reason: Option<String>,
}

pub struct EvidenceObservation<'a> {
    pub invocation: &'a InvocationEnvelope,
    pub result: &'a ResultEnvelope,
    pub context: &'a EvidenceContext,
    pub dispatch: EvidenceDispatch,
    pub key_scope: Option<EvidenceKeyScope>,
    pub duration_ms: u64,
    pub audit_event_id: Option<&'a str>,
    pub degraded: Option<DegradedObservation>,
}

#[derive(Debug, Deserialize, Serialize)]
struct ExecutionBlock {
    request_id: String,
    capability: String,
    provider: String,
    principal_id: Option<String>,
    actor: Actor,
    device_id: Option<String>,
    job_id: Option<String>,
    session_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct TargetBlock {
    kind: String,
    arguments_hash: String,
    ownership: Option<String>,
    lease_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct ConnectionBlock {
    transport: Option<String>,
    generation: Option<String>,
    route_id: Option<String>,
    reconnect_of: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct CorrelationBlock {
    idempotency_key_hash: Option<String>,
    key_scope: Option<EvidenceKeyScope>,
    fingerprint: Option<String>,
    batch_parent: Option<String>,
    checkpoint_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct DegradedBlock {
    state: String,
    reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct OutcomeBlock {
    status: String,
    verification: String,
    error_code: Option<String>,
    uncertain: bool,
    policy_decision: String,
    duration_ms: u64,
    duplicate_handling: String,
    replayed: bool,
    degraded: Option<DegradedBlock>,
}

#[derive(Debug, Deserialize, Serialize)]
struct AuthorizationBlock {
    principal_id: Option<String>,
    decision: String,
    scope: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct DurabilityBlock {
    state_dir: bool,
    audit_persisted: bool,
    idempotency_tracking: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct AttestationBlock {
    attests: String,
    proves_user_intent: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct IntegrityBlock {
    evidence_hash: String,
    prev_evidence_id: Option<String>,
    prev_audit_event_id: Option<String>,
}

/// Provider-neutral execution evidence: what `tetherd` observed during
/// one authorized operation, after the policy decision. Hashes only —
/// raw arguments, keys, messages, and details never appear. The shape is
/// `VouchOut`-ready (stable blocks, hash-chained) with no dependency on
/// `VouchOut` itself; integration needs separate owner approval.
#[derive(Debug, Deserialize, Serialize)]
struct EvidenceBody {
    evidence_id: String,
    emitted_at_ms: u64,
    agent_version: String,
    execution: ExecutionBlock,
    target: TargetBlock,
    connection: ConnectionBlock,
    correlation: CorrelationBlock,
    outcome: OutcomeBlock,
    authorization: AuthorizationBlock,
    durability: DurabilityBlock,
    attestation: AttestationBlock,
    observation_gaps: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct EvidenceRecord {
    #[serde(flatten)]
    body: EvidenceBody,
    integrity: IntegrityBlock,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct GenerationState {
    #[serde(default)]
    current_generation: Option<String>,
    #[serde(default)]
    superseded: Vec<String>,
}

pub struct EvidenceStore {
    directory: PathBuf,
    path: PathBuf,
    generations_path: PathBuf,
    lock: Mutex<()>,
    last_id: Mutex<Option<String>>,
}

impl EvidenceStore {
    pub fn new(state_dir: &Path) -> Result<Self, CapabilityError> {
        let directory = state_dir.join("evidence");
        fs::create_dir_all(&directory).map_err(|error| {
            provider_failure(format!("failed to create evidence directory: {error}"))
        })?;
        let path = directory.join("evidence.jsonl");
        let generations_path = directory.join("generations.json");
        let last_id = tail_evidence_id(&path)?;
        Ok(Self {
            directory,
            generations_path,
            path,
            lock: Mutex::new(()),
            last_id: Mutex::new(last_id),
        })
    }

    /// Appends one evidence record and returns its id. The record is
    /// hash-chained to its predecessor and a newly observed connection
    /// generation supersedes the previous one.
    pub fn append(&self, observation: &EvidenceObservation) -> Result<String, CapabilityError> {
        let evidence_id = format!("ev_{}", Uuid::new_v4().as_simple());
        let body = build_evidence_body(&evidence_id, observation, now_ms()?);
        let encoded_body = serde_json::to_vec(&body)
            .map_err(|error| provider_failure(format!("failed to encode evidence: {error}")))?;

        let _guard = self
            .lock
            .lock()
            .map_err(|_| provider_failure("evidence lock is poisoned".into()))?;
        let prev_id = self
            .last_id
            .lock()
            .map_err(|_| provider_failure("evidence lock is poisoned".into()))?
            .clone();
        let record = EvidenceRecord {
            body,
            integrity: IntegrityBlock {
                evidence_hash: format!("sha256:{}", sha256_hex(&encoded_body)),
                prev_evidence_id: prev_id,
                prev_audit_event_id: observation.audit_event_id.map(str::to_owned),
            },
        };
        let encoded = serde_json::to_vec(&record)
            .map_err(|error| provider_failure(format!("failed to encode evidence: {error}")))?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| provider_failure(format!("failed to open evidence log: {error}")))?;
        file.write_all(&encoded)
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.flush())
            .map_err(|error| provider_failure(format!("failed to append evidence: {error}")))?;
        file.sync_all()
            .map_err(|error| provider_failure(format!("failed to fsync evidence: {error}")))?;
        drop(file);

        if let Some(generation) = observation.context.generation.as_deref() {
            self.supersede_generation(generation)?;
        }
        self.last_id
            .lock()
            .map_err(|_| provider_failure("evidence lock is poisoned".into()))?
            .replace(evidence_id.clone());
        Ok(evidence_id)
    }

    /// Whether `generation` has been superseded by a newer observed
    /// connection generation. Evidence carrying a superseded generation
    /// belongs to a dead connection epoch. This is the defined query
    /// interface for supersession (S7 acceptance); live transport
    /// callers arrive with the relay-wiring follow-up.
    #[allow(dead_code)]
    pub fn is_superseded(&self, generation: &str) -> Result<bool, CapabilityError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| provider_failure("evidence lock is poisoned".into()))?;
        Ok(load_generations(&self.generations_path)?
            .superseded
            .iter()
            .any(|superseded| superseded == generation))
    }

    fn supersede_generation(&self, generation: &str) -> Result<(), CapabilityError> {
        let mut state = load_generations(&self.generations_path)?;
        if state.current_generation.as_deref() == Some(generation) {
            return Ok(());
        }
        if let Some(previous) = state.current_generation.replace(generation.to_owned())
            && !state.superseded.iter().any(|known| known == &previous)
        {
            state.superseded.push(previous);
        }
        let encoded = serde_json::to_vec_pretty(&state)
            .map_err(|error| provider_failure(format!("failed to encode generations: {error}")))?;
        let temp = self
            .directory
            .join(format!(".generations.{}.tmp", Uuid::new_v4().as_simple()));
        fs::write(&temp, encoded).map_err(|error| {
            provider_failure(format!("failed to write generations state: {error}"))
        })?;
        {
            let file = OpenOptions::new().write(true).open(&temp).map_err(|error| {
                provider_failure(format!("failed to reopen generations state: {error}"))
            })?;
            file.sync_all().map_err(|error| {
                provider_failure(format!("failed to fsync generations state: {error}"))
            })?;
        }
        fs::rename(&temp, &self.generations_path).map_err(|error| {
            let _ = fs::remove_file(&temp);
            provider_failure(format!("failed to publish generations state: {error}"))
        })?;
        sync_dir(&self.directory)
    }
}

fn build_evidence_body(
    evidence_id: &str,
    observation: &EvidenceObservation,
    emitted_at_ms: u64,
) -> EvidenceBody {
    let invocation = observation.invocation;
    let result = observation.result;
    let error_code = result.error.as_ref().map(|error| &error.code);
    let uncertain = error_code.is_some_and(|code| *code == ErrorCode::ActionUnverified);
    let decision = policy_decision(result);
    let provider = provider_of(&invocation.capability);
    let gaps = observation_gaps(observation, &provider);

    EvidenceBody {
        evidence_id: evidence_id.to_owned(),
        emitted_at_ms,
        agent_version: env!("CARGO_PKG_VERSION").to_owned(),
        execution: ExecutionBlock {
            request_id: invocation.request_id.to_string(),
            capability: invocation.capability.clone(),
            provider: provider.clone(),
            principal_id: invocation.principal_id.clone(),
            actor: invocation.actor.clone(),
            device_id: invocation.device_id.clone(),
            job_id: audit_job_id(invocation, result),
            session_id: invocation.session_id.clone(),
        },
        target: TargetBlock {
            kind: provider,
            arguments_hash: hash_value(&invocation.arguments),
            ownership: None,
            lease_id: None,
        },
        connection: ConnectionBlock {
            transport: observation.context.transport.clone(),
            generation: observation.context.generation.clone(),
            route_id: observation.context.route_id.clone(),
            reconnect_of: None,
        },
        correlation: CorrelationBlock {
            idempotency_key_hash: invocation
                .idempotency_key
                .as_deref()
                .map(|key| format!("sha256:{}", sha256_hex(key.as_bytes()))),
            key_scope: observation.key_scope,
            fingerprint: invocation
                .idempotency_key
                .is_some()
                .then(|| request_fingerprint(invocation).ok())
                .flatten(),
            batch_parent: None,
            checkpoint_id: None,
        },
        outcome: OutcomeBlock {
            status: enum_string(&result.status).unwrap_or_else(|_| "unknown".to_owned()),
            verification: enum_string(&result.verification)
                .unwrap_or_else(|_| "unknown".to_owned()),
            error_code: error_code.and_then(|code| enum_string(code).ok()),
            uncertain,
            policy_decision: decision.clone(),
            duration_ms: observation.duration_ms,
            duplicate_handling: duplicate_handling(observation.dispatch).to_owned(),
            replayed: observation.dispatch == EvidenceDispatch::Replayed,
            degraded: observation.degraded.as_ref().map(|degraded| DegradedBlock {
                state: degraded.state.clone(),
                reason: degraded.reason.clone(),
            }),
        },
        authorization: AuthorizationBlock {
            principal_id: invocation.principal_id.clone(),
            decision,
            scope: "launch-ceiling".to_owned(),
        },
        durability: DurabilityBlock {
            state_dir: true,
            audit_persisted: observation.audit_event_id.is_some(),
            idempotency_tracking: idempotency_tracking(observation.dispatch).to_owned(),
        },
        attestation: AttestationBlock {
            attests: "observed-provider-response-only".to_owned(),
            proves_user_intent: false,
        },
        observation_gaps: gaps,
    }
}

/// Every unobserved field gets a named gap entry: absence is data,
/// never silence. Structural gaps (ownership, leases, reconnect
/// lineage) apply to every record; the rest are conditional on what
/// the observation actually lacked.
fn observation_gaps(observation: &EvidenceObservation, provider: &str) -> Vec<String> {
    let mut gaps = Vec::new();
    if observation.context.transport.is_none() {
        gaps.push("connection.transport".to_owned());
    }
    if observation.context.generation.is_none() {
        gaps.push("connection.generation".to_owned());
    }
    if observation.context.route_id.is_none() {
        gaps.push("connection.route_id".to_owned());
    }
    gaps.push("connection.reconnect_of".to_owned());
    gaps.push("target.ownership".to_owned());
    gaps.push("target.lease_id".to_owned());
    if observation.invocation.capability == "batch.execute" {
        gaps.push("correlation.batch_parent".to_owned());
    }
    if observation.invocation.capability == "job.checkpoint" {
        gaps.push("correlation.checkpoint_id".to_owned());
    }
    if observation.key_scope == Some(EvidenceKeyScope::Ignored) {
        gaps.push("correlation.unused_key".to_owned());
    }
    if observation.audit_event_id.is_none() {
        gaps.push("durability.audit_persisted".to_owned());
    }
    if provider == "unknown" {
        gaps.push("execution.provider".to_owned());
    }
    gaps
}

fn duplicate_handling(dispatch: EvidenceDispatch) -> &'static str {
    match dispatch {
        EvidenceDispatch::Replayed => "replayed",
        EvidenceDispatch::Conflict => "conflict",
        EvidenceDispatch::Pending => "uncertain",
        EvidenceDispatch::Executed
        | EvidenceDispatch::Direct
        | EvidenceDispatch::DirectUntracked
        | EvidenceDispatch::StoreUnavailable
        | EvidenceDispatch::StoreFailure => "none",
    }
}

fn idempotency_tracking(dispatch: EvidenceDispatch) -> &'static str {
    match dispatch {
        EvidenceDispatch::Executed
        | EvidenceDispatch::Replayed
        | EvidenceDispatch::Conflict
        | EvidenceDispatch::Pending => "durable",
        EvidenceDispatch::StoreUnavailable
        | EvidenceDispatch::StoreFailure
        | EvidenceDispatch::DirectUntracked => "unavailable",
        EvidenceDispatch::Direct => "not-applicable",
    }
}

fn provider_of(capability: &str) -> String {
    capability.split_once('.').map_or_else(
        || "unknown".to_owned(),
        |(namespace, _)| namespace.to_owned(),
    )
}

fn hash_value(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    format!("sha256:{}", sha256_hex(&bytes))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

fn load_generations(path: &Path) -> Result<GenerationState, CapabilityError> {
    if !path.exists() {
        return Ok(GenerationState::default());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| provider_failure(format!("failed to read generations: {error}")))?;
    serde_json::from_str(&content)
        .map_err(|error| provider_failure(format!("invalid persisted generations: {error}")))
}

fn tail_evidence_id(path: &Path) -> Result<Option<String>, CapabilityError> {
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path)
        .map_err(|error| provider_failure(format!("failed to read evidence log: {error}")))?;
    let last = content.lines().rfind(|line| !line.trim().is_empty());
    let Some(last) = last else {
        return Ok(None);
    };
    let record = serde_json::from_str::<EvidenceRecord>(last)
        .map_err(|error| provider_failure(format!("invalid persisted evidence: {error}")))?;
    Ok(Some(record.body.evidence_id))
}

fn sync_dir(directory: &Path) -> Result<(), CapabilityError> {
    #[cfg(unix)]
    {
        let dir = OpenOptions::new()
            .read(true)
            .open(directory)
            .map_err(|error| {
                provider_failure(format!("failed to open evidence directory: {error}"))
            })?;
        dir.sync_all().map_err(|error| {
            provider_failure(format!("failed to fsync evidence directory: {error}"))
        })?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
        Ok(())
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
                details: serde_json::json!({}),
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

fn audit_job_id(invocation: &InvocationEnvelope, result: &ResultEnvelope) -> Option<String> {
    if let Some(job_id) = invocation.job_id.as_ref() {
        return Some(job_id.clone());
    }

    if invocation.capability.starts_with("job.")
        && let Some(job_id) = invocation.arguments.get("job_id").and_then(Value::as_str)
    {
        return Some(job_id.to_owned());
    }

    if invocation.capability == "job.create"
        && let Some(job_id) = result
            .data
            .as_ref()
            .and_then(|data| data.get("job_id"))
            .and_then(Value::as_str)
    {
        return Some(job_id.to_owned());
    }

    None
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

#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::{ActorKind, ResponseMode, ResultStatus, Timing};

    fn invocation() -> InvocationEnvelope {
        InvocationEnvelope {
            protocol_version: "1.0".to_owned(),
            request_id: Uuid::parse_str("00000000-0000-4000-8000-000000000701").unwrap(),
            device_id: Some("Leno".to_owned()),
            principal_id: Some("model:test".to_owned()),
            job_id: None,
            capability: "filesystem.append".to_owned(),
            arguments: json!({ "path": "/tmp/x", "content": "SECRET-ARG-9f3c" }),
            actor: Actor {
                id: "test".to_owned(),
                kind: ActorKind::AiClient,
            },
            session_id: None,
            response_mode: ResponseMode::Compact,
            idempotency_key: Some("SECRET-KEY-71bd".to_owned()),
            preconditions: vec![],
            expectations: vec![],
        }
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
            timing: Timing { duration_ms: 2 },
        }
    }

    fn error_result(invocation: &InvocationEnvelope, code: ErrorCode) -> ResultEnvelope {
        let mut result = success_result(invocation);
        result.status = ResultStatus::Error;
        result.data = None;
        result.verification = VerificationStatus::Failed;
        result.error = Some(CapabilityError {
            code,
            message: "SECRET-MESSAGE-5e0b".to_owned(),
            recovery_hint: None,
            details: json!({ "secret": "SECRET-DETAIL-c4d9" }),
        });
        result
    }

    fn observation<'a>(
        invocation: &'a InvocationEnvelope,
        result: &'a ResultEnvelope,
        context: &'a EvidenceContext,
        dispatch: EvidenceDispatch,
    ) -> EvidenceObservation<'a> {
        EvidenceObservation {
            invocation,
            result,
            context,
            dispatch,
            key_scope: Some(EvidenceKeyScope::Explicit),
            duration_ms: 3,
            audit_event_id: Some("audit_link_1"),
            degraded: None,
        }
    }

    fn unique_state_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tetherplane-evidence-unit-{label}-{}-{}",
            std::process::id(),
            Uuid::new_v4().as_simple()
        ))
    }

    fn read_record(state_dir: &Path) -> Value {
        let raw = std::fs::read_to_string(state_dir.join("evidence").join("evidence.jsonl"))
            .expect("evidence file must exist");
        serde_json::from_str::<Value>(raw.trim()).expect("single evidence record")
    }

    #[test]
    fn evidence_persists_hashes_never_raw_arguments_keys_or_messages() {
        let state_dir = unique_state_dir("hashes");
        let store = EvidenceStore::new(&state_dir).unwrap();
        let invocation = invocation();
        let result = error_result(&invocation, ErrorCode::CapabilityUnavailable);
        let context = EvidenceContext::unspecified();

        let id = store
            .append(&observation(
                &invocation,
                &result,
                &context,
                EvidenceDispatch::Executed,
            ))
            .unwrap();
        assert!(id.starts_with("ev_"));

        let raw =
            std::fs::read_to_string(state_dir.join("evidence").join("evidence.jsonl")).unwrap();
        for secret in [
            "SECRET-ARG-9f3c",
            "SECRET-KEY-71bd",
            "SECRET-MESSAGE-5e0b",
            "SECRET-DETAIL-c4d9",
        ] {
            assert!(
                !raw.contains(secret),
                "evidence must never persist raw secrets, leaked {secret}"
            );
        }

        let record: Value = serde_json::from_str(raw.trim()).unwrap();
        let key_hash = record["correlation"]["idempotency_key_hash"]
            .as_str()
            .expect("key hash present");
        assert!(key_hash.starts_with("sha256:"));
        assert!(
            record["target"]["arguments_hash"]
                .as_str()
                .expect("arguments hash present")
                .starts_with("sha256:")
        );
        assert_eq!(
            record["correlation"]["fingerprint"].as_str().unwrap().len(),
            64,
            "fingerprint stays store-compatible bare hex"
        );
        assert_eq!(record["outcome"]["error_code"], "capability_unavailable");

        std::fs::remove_dir_all(&state_dir).unwrap();
    }

    #[test]
    fn evidence_distinguishes_success_failure_uncertain_and_duplicates() {
        let state_dir = unique_state_dir("outcomes");
        let store = EvidenceStore::new(&state_dir).unwrap();
        let context = EvidenceContext::unspecified();

        let cases = [
            (
                EvidenceDispatch::Executed,
                None,
                "success",
                "none",
                false,
                false,
            ),
            (
                EvidenceDispatch::Executed,
                Some(ErrorCode::CapabilityUnavailable),
                "error",
                "none",
                false,
                false,
            ),
            (
                EvidenceDispatch::Pending,
                Some(ErrorCode::ActionUnverified),
                "error",
                "uncertain",
                true,
                false,
            ),
            (
                EvidenceDispatch::Replayed,
                None,
                "success",
                "replayed",
                false,
                true,
            ),
            (
                EvidenceDispatch::Conflict,
                Some(ErrorCode::ResourceConflict),
                "error",
                "conflict",
                false,
                false,
            ),
        ];
        for (index, (dispatch, code, status, handling, uncertain, replayed)) in
            cases.into_iter().enumerate()
        {
            let mut invocation = invocation();
            invocation.request_id = Uuid::new_v4();
            let result = match code {
                None => success_result(&invocation),
                Some(code) => error_result(&invocation, code),
            };
            store
                .append(&observation(&invocation, &result, &context, dispatch))
                .unwrap();

            let raw =
                std::fs::read_to_string(state_dir.join("evidence").join("evidence.jsonl")).unwrap();
            let line = raw.lines().nth(index).expect("one line per append");
            let record: Value = serde_json::from_str(line).unwrap();
            assert_eq!(record["outcome"]["status"], status);
            assert_eq!(record["outcome"]["duplicate_handling"], handling);
            assert_eq!(record["outcome"]["uncertain"], uncertain);
            assert_eq!(record["outcome"]["replayed"], replayed);
        }

        std::fs::remove_dir_all(&state_dir).unwrap();
    }

    #[test]
    fn evidence_distinguishes_durable_tracking_availability() {
        let state_dir = unique_state_dir("durability");
        let store = EvidenceStore::new(&state_dir).unwrap();
        let context = EvidenceContext::unspecified();
        let invocation = invocation();

        let durable = success_result(&invocation);
        store
            .append(&observation(
                &invocation,
                &durable,
                &context,
                EvidenceDispatch::Executed,
            ))
            .unwrap();

        let unavailable = error_result(&invocation, ErrorCode::ProviderFailure);
        store
            .append(&observation(
                &invocation,
                &unavailable,
                &context,
                EvidenceDispatch::StoreUnavailable,
            ))
            .unwrap();

        let mut unkeyed = invocation.clone();
        unkeyed.idempotency_key = None;
        unkeyed.capability = "device.status".to_owned();
        let read = success_result(&unkeyed);
        let read_observation = EvidenceObservation {
            key_scope: None,
            ..observation(&unkeyed, &read, &context, EvidenceDispatch::Direct)
        };
        store.append(&read_observation).unwrap();

        let raw =
            std::fs::read_to_string(state_dir.join("evidence").join("evidence.jsonl")).unwrap();
        let lines: Vec<Value> = raw
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["durability"]["idempotency_tracking"], "durable");
        assert_eq!(
            lines[1]["durability"]["idempotency_tracking"],
            "unavailable"
        );
        assert_eq!(
            lines[2]["durability"]["idempotency_tracking"],
            "not-applicable"
        );
        assert_eq!(lines[0]["durability"]["audit_persisted"], true);

        // The audit link is explicit too: no audit event, no silent gap.
        let mut no_audit = observation(&invocation, &durable, &context, EvidenceDispatch::Executed);
        no_audit.audit_event_id = None;
        store.append(&no_audit).unwrap();
        let raw =
            std::fs::read_to_string(state_dir.join("evidence").join("evidence.jsonl")).unwrap();
        let last: Value = serde_json::from_str(raw.lines().last().unwrap()).unwrap();
        assert_eq!(last["durability"]["audit_persisted"], false);
        assert!(last["integrity"]["prev_audit_event_id"].is_null());

        std::fs::remove_dir_all(&state_dir).unwrap();
    }

    #[test]
    fn old_generation_evidence_is_marked_superseded() {
        let state_dir = unique_state_dir("generations");
        let store = EvidenceStore::new(&state_dir).unwrap();
        let invocation = invocation();
        let result = success_result(&invocation);

        let first = EvidenceContext {
            transport: Some("relay-ws".to_owned()),
            generation: Some("gen-a".to_owned()),
            route_id: Some("route-1".to_owned()),
        };
        store
            .append(&observation(
                &invocation,
                &result,
                &first,
                EvidenceDispatch::Executed,
            ))
            .unwrap();
        assert!(!store.is_superseded("gen-a").unwrap());

        let second = EvidenceContext {
            transport: Some("relay-ws".to_owned()),
            generation: Some("gen-b".to_owned()),
            route_id: Some("route-2".to_owned()),
        };
        store
            .append(&observation(
                &invocation,
                &result,
                &second,
                EvidenceDispatch::Executed,
            ))
            .unwrap();

        assert!(store.is_superseded("gen-a").unwrap());
        assert!(!store.is_superseded("gen-b").unwrap());
        let generations =
            std::fs::read_to_string(state_dir.join("evidence").join("generations.json")).unwrap();
        assert!(generations.contains("gen-a"));
        assert!(generations.contains("gen-b"));

        // Context-free appends (no generation) never disturb generation tracking.
        let unspecified = EvidenceContext::unspecified();
        store
            .append(&observation(
                &invocation,
                &result,
                &unspecified,
                EvidenceDispatch::Direct,
            ))
            .unwrap();
        assert!(store.is_superseded("gen-a").unwrap());
        assert!(!store.is_superseded("gen-b").unwrap());

        std::fs::remove_dir_all(&state_dir).unwrap();
    }

    #[test]
    fn evidence_records_hash_chain_with_audit_link() {
        let state_dir = unique_state_dir("chain");
        let store = EvidenceStore::new(&state_dir).unwrap();
        let context = EvidenceContext::unspecified();

        let mut first_invocation = invocation();
        first_invocation.request_id = Uuid::new_v4();
        let first_result = success_result(&first_invocation);
        let first_id = store
            .append(&observation(
                &first_invocation,
                &first_result,
                &context,
                EvidenceDispatch::Executed,
            ))
            .unwrap();

        let mut second_invocation = invocation();
        second_invocation.request_id = Uuid::new_v4();
        let second_result = success_result(&second_invocation);
        let mut second_observation = observation(
            &second_invocation,
            &second_result,
            &context,
            EvidenceDispatch::Executed,
        );
        second_observation.audit_event_id = Some("audit_link_2");
        let second_id = store.append(&second_observation).unwrap();

        let raw =
            std::fs::read_to_string(state_dir.join("evidence").join("evidence.jsonl")).unwrap();
        let lines: Vec<Value> = raw
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0]["integrity"]["prev_evidence_id"].is_null());
        assert_eq!(lines[1]["integrity"]["prev_evidence_id"], first_id);
        assert_eq!(lines[1]["integrity"]["prev_audit_event_id"], "audit_link_2");
        assert_eq!(lines[1]["evidence_id"], second_id);

        // The integrity hash is deterministic over the full body: rebuild
        // the body for the same observation and timestamp, and the hash
        // must match.
        let emitted_at_ms = lines[1]["emitted_at_ms"].as_u64().unwrap();
        let rebuilt = build_evidence_body(&second_id, &second_observation, emitted_at_ms);
        let expected = format!(
            "sha256:{}",
            sha256_hex(&serde_json::to_vec(&rebuilt).unwrap())
        );
        assert_eq!(lines[1]["integrity"]["evidence_hash"], expected);

        std::fs::remove_dir_all(&state_dir).unwrap();
    }

    #[test]
    fn evidence_never_claims_user_intent() {
        let state_dir = unique_state_dir("attestation");
        let store = EvidenceStore::new(&state_dir).unwrap();
        let invocation = invocation();
        let result = success_result(&invocation);
        let context = EvidenceContext::unspecified();
        store
            .append(&observation(
                &invocation,
                &result,
                &context,
                EvidenceDispatch::Executed,
            ))
            .unwrap();

        let record = read_record(&state_dir);
        assert_eq!(record["attestation"]["proves_user_intent"], false);
        assert_eq!(
            record["attestation"]["attests"],
            "observed-provider-response-only"
        );

        std::fs::remove_dir_all(&state_dir).unwrap();
    }

    #[test]
    fn unspecified_context_and_unobserved_targets_are_explicit_gaps() {
        let state_dir = unique_state_dir("gaps");
        let store = EvidenceStore::new(&state_dir).unwrap();
        let invocation = invocation();
        let result = success_result(&invocation);
        let context = EvidenceContext::unspecified();
        store
            .append(&observation(
                &invocation,
                &result,
                &context,
                EvidenceDispatch::Executed,
            ))
            .unwrap();

        let record = read_record(&state_dir);
        let gaps = record["observation_gaps"].as_array().unwrap();
        let names: Vec<&str> = gaps.iter().filter_map(Value::as_str).collect();
        for expected in [
            "connection.transport",
            "connection.generation",
            "connection.route_id",
            "target.ownership",
            "target.lease_id",
        ] {
            assert!(
                names.contains(&expected),
                "missing explicit gap {expected}, saw {names:?}"
            );
        }
        assert!(record["target"]["ownership"].is_null());
        assert!(record["connection"]["generation"].is_null());

        std::fs::remove_dir_all(&state_dir).unwrap();
    }

    #[test]
    fn batch_parent_gap_is_scoped_to_batch_executions() {
        let state_dir = unique_state_dir("batch-gap");
        let store = EvidenceStore::new(&state_dir).unwrap();
        let context = EvidenceContext::unspecified();

        let mut batch = invocation();
        batch.capability = "batch.execute".to_owned();
        let batch_result = success_result(&batch);
        store
            .append(&observation(
                &batch,
                &batch_result,
                &context,
                EvidenceDispatch::Executed,
            ))
            .unwrap();

        let plain = invocation();
        let plain_result = success_result(&plain);
        store
            .append(&observation(
                &plain,
                &plain_result,
                &context,
                EvidenceDispatch::Executed,
            ))
            .unwrap();

        let raw =
            std::fs::read_to_string(state_dir.join("evidence").join("evidence.jsonl")).unwrap();
        let lines: Vec<Value> = raw
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect();
        let batch_gaps = lines[0]["observation_gaps"].as_array().unwrap();
        assert!(
            batch_gaps
                .iter()
                .any(|gap| gap == "correlation.batch_parent"),
            "batch leaves are router-internal and must be an explicit gap"
        );
        let plain_gaps = lines[1]["observation_gaps"].as_array().unwrap();
        assert!(
            !plain_gaps
                .iter()
                .any(|gap| gap == "correlation.batch_parent"),
            "non-batch executions must not carry the batch gap"
        );

        std::fs::remove_dir_all(&state_dir).unwrap();
    }
}
