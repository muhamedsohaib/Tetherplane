//! Test-only fixture launcher and authorizer for the non-default
//! `test-support` feature. Never compiled into default or release builds, and
//! production dispatch never references these fixtures.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tether_core::{
    AuthorizedLaunch, CapabilityError, ExecutionBinding, ExecutionEffect, ExecutionProfile,
    ExecutionResourceCeiling, LocalPolicyBroker, LocalPolicyConfig, PrincipalAuthentication,
    PrincipalProfile, ProfileResource, ResourceAccess,
};

use crate::capability_unavailable;
use crate::isolation::{CommissionedLaunchAuthorizer, IsolatedLauncher, TrustedLaunchAuthorizer};
use crate::session::ProcessSession;

pub const TEST_PRINCIPAL_ID: &str = "process-fixture-principal";
pub const TEST_DEVICE_ID: &str = "process-fixture-device";

/// The exact supported restricted profile shape used by provider tests.
#[must_use]
pub fn fixture_profile() -> ExecutionProfile {
    ExecutionProfile {
        profile_id: "fixture-restricted-profile".into(),
        revision: 1,
        organization_id: "fixture-org".into(),
        principal_id: TEST_PRINCIPAL_ID.into(),
        device_id: TEST_DEVICE_ID.into(),
        enrollment_generation: 1,
        workspace: ProfileResource {
            resource_id: "fixture-workspace".into(),
            access: [ResourceAccess::Read].into(),
            private: false,
        },
        scratch: ProfileResource {
            resource_id: "fixture-scratch".into(),
            access: [
                ResourceAccess::Read,
                ResourceAccess::Write,
                ResourceAccess::Create,
            ]
            .into(),
            private: true,
        },
        allowed_effects: [
            ExecutionEffect::ReadWorkspace,
            ExecutionEffect::WriteScratch,
        ]
        .into(),
    }
}

/// Fixture authorizer equivalent to production commissioning over exactly one
/// locally trusted profile for the fixture principal/device identities.
#[must_use]
pub fn fixture_authorizer() -> Arc<dyn TrustedLaunchAuthorizer> {
    let profile = fixture_profile();
    let principal = PrincipalProfile {
        principal_id: TEST_PRINCIPAL_ID.into(),
        authentication: PrincipalAuthentication::LocalProcessBinding,
        allowed_devices: [TEST_DEVICE_ID.to_owned()].into(),
        allowed_capabilities: ["process.run".to_owned()].into(),
        allowed_directories: vec![],
    };
    let binding = ExecutionBinding {
        organization_id: "fixture-org".into(),
        principal_id: TEST_PRINCIPAL_ID.into(),
        device_id: TEST_DEVICE_ID.into(),
        enrollment_generation: 1,
    };
    let ceiling = ExecutionResourceCeiling {
        workspace: profile.workspace.clone(),
        scratch: profile.scratch.clone(),
        allowed_effects: profile.allowed_effects.clone(),
    };
    let config = LocalPolicyConfig::new(vec![])
        .with_principal(principal)
        .with_execution_authority(binding, vec![profile], ceiling);
    let broker = Arc::new(LocalPolicyBroker::new(config));
    Arc::new(CommissionedLaunchAuthorizer::new(
        broker,
        vec![fixture_profile()],
    ))
}

/// Fixture standing in for a future verified OS backend. It performs
/// host-account spawning and exists only under `test-support`; never linked
/// into production dispatch.
pub struct TestIsolatedLauncher {
    pty_supported: bool,
    setup_failure: bool,
    host_spawn_count: AtomicUsize,
    last_profile_id: Mutex<Option<String>>,
}

impl TestIsolatedLauncher {
    #[must_use]
    pub fn new() -> Self {
        Self {
            pty_supported: true,
            setup_failure: false,
            host_spawn_count: AtomicUsize::new(0),
            last_profile_id: Mutex::new(None),
        }
    }

    #[must_use]
    pub fn with_pty_unsupported(mut self) -> Self {
        self.pty_supported = false;
        self
    }

    #[must_use]
    pub fn with_setup_failure(mut self) -> Self {
        self.setup_failure = true;
        self
    }

    /// Attempts to execute on the host. Fixture backends must keep this at
    /// zero until a configured isolation setup has verified the boundary.
    #[must_use]
    pub fn host_spawn_count(&self) -> usize {
        self.host_spawn_count.load(Ordering::SeqCst)
    }

    /// Profile identity carried by the last broker-issued authority observed.
    #[must_use]
    pub fn last_profile_id(&self) -> Option<String> {
        self.last_profile_id
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

impl Default for TestIsolatedLauncher {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl IsolatedLauncher for TestIsolatedLauncher {
    async fn launch(
        &self,
        authority: &AuthorizedLaunch,
        program: &str,
        args: &[String],
        pty: bool,
    ) -> Result<ProcessSession, CapabilityError> {
        *self
            .last_profile_id
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(authority.profile().profile_id.clone());

        if self.setup_failure {
            return Err(capability_unavailable(
                "fixture isolation setup failed before execution",
            ));
        }
        if pty && !self.pty_supported {
            return Err(capability_unavailable(
                "no verified PTY isolation backend is installed",
            ));
        }

        self.host_spawn_count.fetch_add(1, Ordering::SeqCst);
        ProcessSession::spawn(program, args, pty).await
    }
}
