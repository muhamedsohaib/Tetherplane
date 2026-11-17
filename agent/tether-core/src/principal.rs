use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolFamily {
    Device,
    Files,
    Process,
    Browser,
    Desktop,
    Batch,
}

impl ToolFamily {
    pub const ALL: [Self; 6] = [
        Self::Device,
        Self::Files,
        Self::Process,
        Self::Browser,
        Self::Desktop,
        Self::Batch,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Device => "device",
            Self::Files => "files",
            Self::Process => "process",
            Self::Browser => "browser",
            Self::Desktop => "desktop",
            Self::Batch => "batch",
        }
    }

    #[must_use]
    pub fn all_set() -> BTreeSet<Self> {
        BTreeSet::from(Self::ALL)
    }
}

#[must_use]
pub fn tool_family_for_capability(capability: &str) -> Option<ToolFamily> {
    let namespace = capability.split_once('.').map_or(capability, |(ns, _)| ns);
    match namespace {
        "device" | "job" | "audit" => Some(ToolFamily::Device),
        "filesystem" | "search" | "files" => Some(ToolFamily::Files),
        "process" => Some(ToolFamily::Process),
        "browser" => Some(ToolFamily::Browser),
        "desktop" => Some(ToolFamily::Desktop),
        "batch" => Some(ToolFamily::Batch),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalRole {
    Owner,
    #[default]
    Operator,
}

impl PrincipalRole {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Operator => "operator",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalAuthentication {
    LocalProcessBinding,
    OwnerPairedUniversal,
    RelaySynchronized,
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

fn default_profile_id() -> String {
    "universal".to_owned()
}

fn default_revision() -> u64 {
    1
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapabilityDenialKind {
    ExplicitDeny,
    FamilyRevoked,
    OperationNotGranted,
}

impl CapabilityDenialKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ExplicitDeny => "explicit_deny",
            Self::FamilyRevoked => "family_revoked",
            Self::OperationNotGranted => "operation_not_granted",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PrincipalPermissionSet {
    pub principal_id: String,
    #[serde(default)]
    pub role: PrincipalRole,
    #[serde(default = "default_profile_id")]
    pub profile_id: String,
    #[serde(default)]
    pub universal_permissions: bool,
    #[serde(default)]
    pub allowed_families: BTreeSet<ToolFamily>,
    #[serde(default)]
    pub denied_families: BTreeSet<ToolFamily>,
    #[serde(default)]
    pub allowed_capabilities: BTreeSet<String>,
    #[serde(default)]
    pub denied_capabilities: BTreeSet<String>,
    #[serde(default)]
    pub allowed_roots: Vec<PathBuf>,
    #[serde(default)]
    pub allow_destructive: bool,
}

impl PrincipalPermissionSet {
    #[must_use]
    pub fn universal_owner(principal_id: impl Into<String>) -> Self {
        Self {
            principal_id: principal_id.into(),
            role: PrincipalRole::Owner,
            profile_id: "universal".to_owned(),
            universal_permissions: true,
            allowed_families: ToolFamily::all_set(),
            denied_families: BTreeSet::new(),
            allowed_capabilities: BTreeSet::new(),
            denied_capabilities: BTreeSet::new(),
            allowed_roots: Vec::new(),
            allow_destructive: true,
        }
    }

    /// Evaluates whether `capability` is granted for this principal permission set.
    ///
    /// # Errors
    ///
    /// Returns [`CapabilityDenialKind`] when the capability or its tool family is
    /// explicitly denied, revoked, or not granted.
    pub fn evaluate_capability(&self, capability: &str) -> Result<(), CapabilityDenialKind> {
        if self.denied_capabilities.contains(capability) {
            return Err(CapabilityDenialKind::ExplicitDeny);
        }

        let family = tool_family_for_capability(capability);
        if let Some(family) = family
            && self.denied_families.contains(&family)
        {
            return Err(CapabilityDenialKind::ExplicitDeny);
        }

        if self.allowed_capabilities.contains(capability) {
            return Ok(());
        }

        if let Some(family) = family
            && self.allowed_families.contains(&family)
        {
            return Ok(());
        }

        if self.universal_permissions {
            return Ok(());
        }

        if self.role == PrincipalRole::Owner
            && let Some(family) = family
            && !self.allowed_families.contains(&family)
        {
            return Err(CapabilityDenialKind::FamilyRevoked);
        }

        Err(CapabilityDenialKind::OperationNotGranted)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SynchronizedDevicePolicy {
    pub device_id: String,
    pub owner_account_id: String,
    pub owner_principal_id: String,
    #[serde(default = "default_revision")]
    pub revision: u64,
    #[serde(default)]
    pub updated_at_ms: u64,
    #[serde(default)]
    pub updated_by: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub emergency_lockdown: bool,
    pub owner_policy: PrincipalPermissionSet,
    #[serde(default)]
    pub operator_policies: BTreeMap<String, PrincipalPermissionSet>,
}

impl SynchronizedDevicePolicy {
    #[must_use]
    pub fn universal_for_owner(
        device_id: impl Into<String>,
        owner_account_id: impl Into<String>,
        owner_principal_id: impl Into<String>,
    ) -> Self {
        let device_id = device_id.into();
        let owner_account_id = owner_account_id.into();
        let owner_principal_id = owner_principal_id.into();
        Self {
            device_id,
            owner_account_id,
            owner_principal_id: owner_principal_id.clone(),
            revision: 1,
            updated_at_ms: 0,
            updated_by: owner_principal_id.clone(),
            reason: "Universal default permissions assigned to owner-paired device".to_owned(),
            emergency_lockdown: false,
            owner_policy: PrincipalPermissionSet::universal_owner(owner_principal_id),
            operator_policies: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn resolve_principal(&self, principal_id: Option<&str>) -> Option<&PrincipalPermissionSet> {
        let principal_id = principal_id?;
        let canonical_owner = format!("human:{}", self.owner_account_id);
        if principal_id == self.owner_principal_id
            || principal_id == self.owner_policy.principal_id
            || principal_id == canonical_owner
        {
            return Some(&self.owner_policy);
        }

        self.operator_policies.get(principal_id)
    }
}
