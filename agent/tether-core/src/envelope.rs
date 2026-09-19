use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::CapabilityError;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    Human,
    AiClient,
    System,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Actor {
    pub id: String,
    pub kind: ActorKind,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseMode {
    Compact,
    Normal,
    Debug,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct InvocationEnvelope {
    pub protocol_version: String,
    pub request_id: Uuid,
    pub device_id: Option<String>,
    #[serde(default)]
    pub principal_id: Option<String>,
    #[serde(default)]
    pub job_id: Option<String>,
    pub capability: String,
    pub arguments: Value,
    pub actor: Actor,
    pub session_id: Option<String>,
    pub response_mode: ResponseMode,
    pub idempotency_key: Option<String>,
    pub preconditions: Vec<Value>,
    pub expectations: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResultStatus {
    Success,
    Error,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    NotApplicable,
    Verified,
    ExecutedUnverified,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Timing {
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ResultEnvelope {
    pub protocol_version: String,
    pub request_id: Uuid,
    pub status: ResultStatus,
    pub data: Option<Value>,
    pub delta: Option<Value>,
    pub error: Option<CapabilityError>,
    pub verification: VerificationStatus,
    pub continuation: Option<Value>,
    pub policy: Option<Value>,
    pub timing: Timing,
}
