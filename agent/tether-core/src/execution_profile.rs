use std::collections::BTreeSet;

/// Explicit rights on a provider-neutral resource identity, not a host path.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ResourceAccess {
    Read,
    Write,
    Create,
    Delete,
    Execute,
}

/// Resource attachment requested by a profile. OS attachment remains a separate
/// provider responsibility; these fields are not evidence of containment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileResource {
    pub resource_id: String,
    pub access: BTreeSet<ResourceAccess>,
    pub private: bool,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ExecutionEffect {
    ReadWorkspace,
    WriteScratch,
    Network,
    PrivilegedIpc,
    HumanInterface,
    Unknown(String),
}

/// An immutable revision must match one complete locally commissioned grant.
/// Constructing a profile does not authorize it or establish OS support.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionProfile {
    pub profile_id: String,
    pub revision: u64,
    pub organization_id: String,
    pub principal_id: String,
    pub device_id: String,
    pub enrollment_generation: u64,
    pub workspace: ProfileResource,
    pub scratch: ProfileResource,
    pub allowed_effects: BTreeSet<ExecutionEffect>,
}

/// Trusted local commissioning context. Never populated from invocation JSON.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionBinding {
    pub organization_id: String,
    pub principal_id: String,
    pub device_id: String,
    pub enrollment_generation: u64,
}

/// Mandatory local limits, intersected independently with the complete grant.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionResourceCeiling {
    pub workspace: ProfileResource,
    pub scratch: ProfileResource,
    pub allowed_effects: BTreeSet<ExecutionEffect>,
}

impl ExecutionProfile {
    /// Supported first-profile shape only: attached (non-private) read-only
    /// workspace plus private, non-executable scratch. Scratch delete stays
    /// explicit: it must be commissioned by the complete grant and ceiling.
    /// Sibling grant and ceiling checks remain independent.
    pub(crate) fn is_supported_restricted_shape(&self) -> bool {
        let identifiers = [
            &self.profile_id,
            &self.organization_id,
            &self.principal_id,
            &self.device_id,
            &self.workspace.resource_id,
            &self.scratch.resource_id,
        ];
        identifiers.iter().all(|id| !id.trim().is_empty())
            && self.revision > 0
            && self.enrollment_generation > 0
            && self.workspace.resource_id != self.scratch.resource_id
            && !self.workspace.private
            && self.workspace.access == BTreeSet::from([ResourceAccess::Read])
            && self.scratch.private
            && BTreeSet::from([
                ResourceAccess::Read,
                ResourceAccess::Write,
                ResourceAccess::Create,
            ])
            .is_subset(&self.scratch.access)
            && !self.scratch.access.contains(&ResourceAccess::Execute)
            && self.allowed_effects
                == BTreeSet::from([
                    ExecutionEffect::ReadWorkspace,
                    ExecutionEffect::WriteScratch,
                ])
    }
}

impl ExecutionResourceCeiling {
    pub(crate) fn permits(&self, profile: &ExecutionProfile) -> bool {
        resource_within(&profile.workspace, &self.workspace)
            && resource_within(&profile.scratch, &self.scratch)
            && profile.allowed_effects.is_subset(&self.allowed_effects)
    }
}

fn resource_within(requested: &ProfileResource, ceiling: &ProfileResource) -> bool {
    requested.resource_id == ceiling.resource_id
        && requested.private == ceiling.private
        && requested.access.is_subset(&ceiling.access)
}
