#![forbid(unsafe_code)]

mod envelope;
mod error;

pub use envelope::{
    Actor, ActorKind, InvocationEnvelope, ResponseMode, ResultEnvelope, ResultStatus, Timing,
    VerificationStatus,
};
pub use error::{CapabilityError, ErrorCode};

pub const CRATE_NAME: &str = "tether-core";
