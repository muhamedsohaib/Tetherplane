#![forbid(unsafe_code)]

mod envelope;
mod error;
mod provider;
mod router;

pub use envelope::{
    Actor, ActorKind, InvocationEnvelope, ResponseMode, ResultEnvelope, ResultStatus, Timing,
    VerificationStatus,
};
pub use error::{CapabilityError, ErrorCode};
pub use provider::{CapabilityProvider, ProviderResult};
pub use router::CapabilityRouter;

pub const CRATE_NAME: &str = "tether-core";
