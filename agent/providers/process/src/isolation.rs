//! Provider-neutral isolation boundary. A restricted launch is authorized by a
//! trusted, runtime-injected authorizer and executed only by an OS isolation
//! backend. Provider code never interprets caller-supplied privilege
//! assertions and never falls back to ambient host-account launch.

use std::sync::Arc;

use async_trait::async_trait;
use tether_core::{
    AuthorizedLaunch, CapabilityError, ExecutionProfile, InvocationEnvelope, LocalPolicyBroker,
};

use crate::capability_unavailable;
use crate::session::ProcessSession;

/// Verifies an invocation against locally trusted commissioning authority and
/// issues a broker-backed launch authority. Only the runtime constructs a real
/// implementation; caller JSON can never supply or replace one.
#[async_trait]
pub trait TrustedLaunchAuthorizer: Send + Sync {
    /// # Errors
    ///
    /// Returns the broker's denial unchanged when no commissioned profile
    /// matches, or `capability_unavailable` when no locally commissioned
    /// profile exists at all.
    async fn authorize(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<AuthorizedLaunch, CapabilityError>;
}

/// Creates a restricted process session only after receiving broker-issued
/// authority. Backends must fail closed: a denial or a failed isolation setup
/// never falls back to ambient host-account spawning.
#[async_trait]
pub trait IsolatedLauncher: Send + Sync {
    /// # Errors
    ///
    /// Returns `capability_unavailable` when the requested mode has no verified
    /// isolation backend, or a provider error when the launch itself fails.
    /// The launcher must not spawn after returning an error.
    async fn launch(
        &self,
        authority: &AuthorizedLaunch,
        program: &str,
        args: &[String],
        pty: bool,
    ) -> Result<ProcessSession, CapabilityError>;
}

/// Production authorizer over locally commissioned configuration only.
pub struct CommissionedLaunchAuthorizer {
    broker: Arc<LocalPolicyBroker>,
    commissioned: Vec<ExecutionProfile>,
}

impl CommissionedLaunchAuthorizer {
    /// Candidates come only from locally trusted commissioning configuration.
    /// Caller JSON never supplies grants or identity.
    #[must_use]
    pub fn new(broker: Arc<LocalPolicyBroker>, commissioned: Vec<ExecutionProfile>) -> Self {
        Self {
            broker,
            commissioned,
        }
    }
}

#[async_trait]
impl TrustedLaunchAuthorizer for CommissionedLaunchAuthorizer {
    async fn authorize(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<AuthorizedLaunch, CapabilityError> {
        if self.commissioned.is_empty() {
            return Err(capability_unavailable(
                "no locally commissioned restricted execution profile is available",
            ));
        }

        let mut first_denial = None;
        for grant in &self.commissioned {
            match self.broker.authorize_launch(invocation, grant) {
                Ok(authority) => return Ok(authority),
                Err(error) => {
                    if first_denial.is_none() {
                        first_denial = Some(error);
                    }
                }
            }
        }

        match first_denial {
            Some(denial) => Err(denial),
            None => Err(capability_unavailable(
                "no locally commissioned restricted execution profile is available",
            )),
        }
    }
}

/// Shipped deny-by-default backend: no verified isolation backend is installed
/// yet, so every restricted launch fails closed without spawning.
#[derive(Debug, Default)]
pub struct DenyUnsupportedLauncher;

#[async_trait]
impl IsolatedLauncher for DenyUnsupportedLauncher {
    async fn launch(
        &self,
        _authority: &AuthorizedLaunch,
        _program: &str,
        _args: &[String],
        _pty: bool,
    ) -> Result<ProcessSession, CapabilityError> {
        Err(capability_unavailable(
            "no verified isolation backend is installed; restricted process execution is unavailable",
        ))
    }
}
