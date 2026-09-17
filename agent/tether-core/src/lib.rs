#![forbid(unsafe_code)]

mod envelope;
mod error;
mod ownership;
mod policy;
mod provider;
mod router;

pub use envelope::{
    Actor, ActorKind, InvocationEnvelope, ResponseMode, ResultEnvelope, ResultStatus, Timing,
    VerificationStatus,
};
pub use error::{CapabilityError, ErrorCode};
pub use ownership::ResourceOrigin;
pub use policy::{
    ApprovalScope, LocalPolicyBroker, LocalPolicyConfig, PolicyBroker, PolicyDecision,
    SideEffectClass, authorize_path,
};
pub use provider::{CapabilityProvider, ProviderResult};
pub use router::CapabilityRouter;

pub const CRATE_NAME: &str = "tether-core";
