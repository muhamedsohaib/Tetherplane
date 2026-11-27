use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalAuthentication {
    LocalProcessBinding,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PrincipalProfile {
    pub principal_id: String,
    pub authentication: PrincipalAuthentication,
    #[serde(default)]
    pub allowed_devices: BTreeSet<String>,
    #[serde(default)]
    pub allowed_capabilities: BTreeSet<String>,
    #[serde(default, alias = "allowed_roots")]
    pub allowed_directories: Vec<PathBuf>,
}

/// Owner-desired capability set for one device (S4). The relay assigns
/// monotonically increasing versions per device; the device applies only
/// versions newer than its current effective version. No principal travels
/// with it: desired state narrows the launch-bound principal and must
/// never be trusted as an identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DesiredPolicy {
    pub version: u64,
    #[serde(rename = "allowedCapabilities")]
    pub allowed_capabilities: BTreeSet<String>,
}

/// Device verdict on one desired version.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AckStatus {
    Applied,
    Rejected,
}

/// Acknowledgment for one desired version, sent on the dedicated ack
/// channel (never piggybacked on results). `applied_capabilities` is the
/// standing effective set: the newly applied set on success, or the
/// unchanged prior set on rejection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PolicyAcknowledgment {
    pub version: u64,
    pub status: AckStatus,
    #[serde(rename = "appliedCapabilities")]
    pub applied_capabilities: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug)]
struct EffectiveState {
    version: u64,
    allowed_capabilities: BTreeSet<String>,
}

/// Live effective policy: the launch-bound ceiling narrowed by owner
/// desired state (S4). Synchronization may narrow or restore within the
/// ceiling, never exceed it; anything exceeding the ceiling is rejected
/// whole (effective stands, version frozen). Without a launch-bound
/// profile there is no ceiling to narrow within, so every desired
/// version is rejected and local checks stay open.
#[derive(Debug)]
pub struct EffectivePolicy {
    ceiling: Option<BTreeSet<String>>,
    state: RwLock<EffectiveState>,
}

impl EffectivePolicy {
    /// New per-connection policy starting at the ceiling (version 0).
    /// Fresh state per connection is what lets a reconnect re-apply the
    /// relay's current desired version instead of stalling as stale.
    #[must_use]
    pub fn new(ceiling: PrincipalProfile) -> Self {
        let allowed_capabilities = ceiling.allowed_capabilities.clone();
        Self {
            ceiling: Some(ceiling.allowed_capabilities),
            state: RwLock::new(EffectiveState {
                version: 0,
                allowed_capabilities,
            }),
        }
    }

    /// Open agent (no launch profile): checks allow everything locally
    /// and every desired version is refused — the sync channel cannot
    /// author policy where no local authority exists.
    #[must_use]
    pub fn without_ceiling() -> Self {
        Self {
            ceiling: None,
            state: RwLock::new(EffectiveState {
                version: 0,
                allowed_capabilities: BTreeSet::new(),
            }),
        }
    }

    /// Apply one desired version. Returns `None` (caller sends no ack)
    /// for stale or duplicate versions; otherwise returns the
    /// acknowledgment to send, applied or rejected.
    pub fn apply_desired(&self, desired: &DesiredPolicy) -> Option<PolicyAcknowledgment> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if desired.version <= state.version {
            return None;
        }
        let Some(ceiling) = &self.ceiling else {
            return Some(PolicyAcknowledgment {
                version: desired.version,
                status: AckStatus::Rejected,
                applied_capabilities: BTreeSet::new(),
                reason: Some(
                    "no launch-bound principal profile; restart with --principal-profile to enable policy sync"
                        .to_owned(),
                ),
            });
        };
        if !desired.allowed_capabilities.is_subset(ceiling) {
            return Some(PolicyAcknowledgment {
                version: desired.version,
                status: AckStatus::Rejected,
                applied_capabilities: state.allowed_capabilities.clone(),
                reason: Some(
                    "desired policy exceeds the launch-bound ceiling; relaunch with a new profile to widen"
                        .to_owned(),
                ),
            });
        }
        state.version = desired.version;
        state
            .allowed_capabilities
            .clone_from(&desired.allowed_capabilities);
        Some(PolicyAcknowledgment {
            version: desired.version,
            status: AckStatus::Applied,
            applied_capabilities: state.allowed_capabilities.clone(),
            reason: None,
        })
    }

    /// Enforcement query: `None` when the capability is allowed, else
    /// the denial reason. Called before provider dispatch.
    #[must_use]
    pub fn check(&self, capability: &str) -> Option<String> {
        self.ceiling.as_ref()?;
        let state = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.allowed_capabilities.contains(capability) {
            None
        } else {
            Some(format!(
                "capability {capability} is not granted by synchronized device policy (version {})",
                state.version
            ))
        }
    }

    /// Current effective version and capability set (for status reads).
    #[must_use]
    pub fn snapshot(&self) -> (u64, BTreeSet<String>) {
        let state = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (state.version, state.allowed_capabilities.clone())
    }
}
