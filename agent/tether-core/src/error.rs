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

/// Truthful per-capability readiness (Architecture B, S3).
///
/// A capability is `Ready` only after a live probe of the actual provider
/// operation succeeds; every other state names why calls cannot proceed
/// normally. Reported with `observed_at` freshness and a `reason` wherever
/// capability health is exposed.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityState {
    /// Last live probe of the actual provider operation succeeded.
    Ready,
    /// Provider reachable but partially functional (a sub-capability is down).
    Degraded,
    /// Provider unreachable (or not configured); calls fail without dispatch.
    Disconnected,
    /// Provider reachable but policy denies the capability for the principal.
    Unauthorized,
    /// Configured but not yet verified, or a recent failure is unconfirmed.
    Recovering,
}

impl CapabilityState {
    /// Ready is the only state that predicts calls will proceed normally.
    #[must_use]
    pub const fn is_ready(self) -> bool {
        matches!(self, Self::Ready)
    }
}
