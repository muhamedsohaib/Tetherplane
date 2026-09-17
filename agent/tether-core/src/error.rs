use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidArguments,
    CapabilityUnavailable,
    PermissionDenied,
    ApprovalRequired,
    ForegroundLeaseRequired,
    HumanActivityConflict,
    StaleReference,
    ResourceConflict,
    PreconditionFailed,
    ActionUnverified,
    Timeout,
    Disconnected,
    ProcessFinished,
    OutputTruncated,
    ProviderFailure,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CapabilityError {
    pub code: ErrorCode,
    pub message: String,
    pub recovery_hint: Option<String>,
    pub details: Value,
}
