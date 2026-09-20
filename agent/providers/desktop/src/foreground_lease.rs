use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tether_core::{CapabilityError, ErrorCode};
use uuid::Uuid;

use crate::{DesktopPoint, ForegroundWindowIdentity};

pub const MAX_FOREGROUND_LEASE_TTL_MS: u64 = 120_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RestorationStatus {
    NotRequired,
    Armed,
    Pending,
    Restored,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForegroundLease {
    pub lease_id: String,
    pub principal_id: String,
    pub approved_by_actor_id: String,
    pub target_resource: String,
    pub capabilities: BTreeSet<String>,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub reason: String,
    pub restoration_required: bool,
    pub baseline_cursor: Option<DesktopPoint>,
    pub baseline_foreground: Option<ForegroundWindowIdentity>,
    pub released_at_ms: Option<u64>,
    pub restoration_status: RestorationStatus,
    pub restored_at_ms: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct ForegroundLeaseGrant {
    pub principal_id: String,
    pub approved_by_actor_id: String,
    pub target_resource: String,
    pub capabilities: BTreeSet<String>,
    pub issued_at_ms: u64,
    pub ttl_ms: u64,
    pub reason: String,
    pub baseline_cursor: Option<DesktopPoint>,
    pub baseline_foreground: Option<ForegroundWindowIdentity>,
}

#[derive(Debug, Default)]
pub struct ForegroundLeaseStore {
    leases: Mutex<HashMap<String, ForegroundLease>>,
}

impl ForegroundLeaseStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a local foreground lease with an opaque random identifier.
    ///
    /// # Errors
    ///
    /// Returns `invalid_arguments` when the requested scope or lifetime is invalid.
    pub fn acquire(&self, grant: ForegroundLeaseGrant) -> Result<ForegroundLease, CapabilityError> {
        if grant.principal_id.trim().is_empty()
            || grant.target_resource.trim().is_empty()
            || grant.capabilities.is_empty()
            || grant.reason.trim().is_empty()
        {
            return Err(invalid_arguments(
                "foreground lease principal, target, capabilities, and reason are required",
            ));
        }
        if grant.ttl_ms == 0 || grant.ttl_ms > MAX_FOREGROUND_LEASE_TTL_MS {
            return Err(invalid_arguments(
                "foreground lease ttl_ms must be between 1 and 120000",
            ));
        }

        let restoration_required = grant.baseline_cursor.is_some();
        let lease = ForegroundLease {
            lease_id: Uuid::new_v4().to_string(),
            principal_id: grant.principal_id,
            approved_by_actor_id: grant.approved_by_actor_id,
            target_resource: grant.target_resource,
            capabilities: grant.capabilities,
            issued_at_ms: grant.issued_at_ms,
            expires_at_ms: grant.issued_at_ms.saturating_add(grant.ttl_ms),
            reason: grant.reason,
            restoration_required,
            baseline_cursor: grant.baseline_cursor,
            baseline_foreground: grant.baseline_foreground,
            released_at_ms: None,
            restoration_status: if restoration_required {
                RestorationStatus::Armed
            } else {
                RestorationStatus::NotRequired
            },
            restored_at_ms: None,
        };

        self.leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(lease.lease_id.clone(), lease.clone());
        Ok(lease)
    }

    #[must_use]
    pub fn get(&self, lease_id: &str, now_ms: u64) -> Option<ForegroundLease> {
        let mut leases = self
            .leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let lease = leases.get_mut(lease_id)?;
        expire_if_needed(lease, now_ms);
        Some(lease.clone())
    }

    /// Releases a lease for its target principal or for a trusted local human actor.
    ///
    /// # Errors
    ///
    /// Returns `permission_denied` when a different principal attempts release.
    pub fn release(
        &self,
        lease_id: &str,
        principal_id: Option<&str>,
        human_override: bool,
        now_ms: u64,
    ) -> Result<ForegroundLease, CapabilityError> {
        let mut leases = self
            .leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let lease = leases
            .get_mut(lease_id)
            .ok_or_else(|| foreground_lease_required("foreground lease does not exist"))?;
        expire_if_needed(lease, now_ms);

        if !human_override && principal_id != Some(lease.principal_id.as_str()) {
            return Err(CapabilityError {
                code: ErrorCode::PermissionDenied,
                message: "foreground lease belongs to a different principal".into(),
                recovery_hint: None,
                details: json!({ "lease_id": lease_id }),
            });
        }

        if lease.released_at_ms.is_none() {
            lease.released_at_ms = Some(now_ms);
            if lease.restoration_required {
                lease.restoration_status = RestorationStatus::Pending;
            }
        }
        Ok(lease.clone())
    }

    /// Marks pending restoration as complete.
    ///
    /// # Errors
    ///
    /// Returns `foreground_lease_required` for an unknown lease.
    pub fn mark_restored(
        &self,
        lease_id: &str,
        now_ms: u64,
    ) -> Result<ForegroundLease, CapabilityError> {
        let mut leases = self
            .leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let lease = leases
            .get_mut(lease_id)
            .ok_or_else(|| foreground_lease_required("foreground lease does not exist"))?;
        if lease.restoration_required {
            lease.restoration_status = RestorationStatus::Restored;
            lease.restored_at_ms = Some(now_ms);
        }
        Ok(lease.clone())
    }
}

impl ForegroundLease {
    /// Verifies that this lease authorizes one physical operation.
    ///
    /// # Errors
    ///
    /// Returns `foreground_lease_required` when the lease is inactive or out of scope.
    pub fn authorize(
        &self,
        principal_id: Option<&str>,
        target_resource: &str,
        capability: &str,
    ) -> Result<(), CapabilityError> {
        if self.released_at_ms.is_some() {
            return Err(foreground_lease_required(
                "foreground lease is released or expired",
            ));
        }
        if principal_id != Some(self.principal_id.as_str()) {
            return Err(foreground_lease_required(
                "foreground lease principal does not match",
            ));
        }
        if self.target_resource != target_resource {
            return Err(foreground_lease_required(
                "foreground lease target resource does not match",
            ));
        }
        if !self.capabilities.contains(capability) {
            return Err(foreground_lease_required(
                "foreground lease capability is outside scope",
            ));
        }
        Ok(())
    }
}

fn expire_if_needed(lease: &mut ForegroundLease, now_ms: u64) {
    if lease.released_at_ms.is_none() && now_ms >= lease.expires_at_ms {
        lease.released_at_ms = Some(now_ms);
        if lease.restoration_required {
            lease.restoration_status = RestorationStatus::Pending;
        }
    }
}

fn foreground_lease_required(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ForegroundLeaseRequired,
        message: message.to_owned(),
        recovery_hint: Some("obtain a new scoped foreground lease".into()),
        details: serde_json::json!({}),
    }
}

fn invalid_arguments(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}
