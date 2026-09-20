#![forbid(unsafe_code)]

mod batch;
mod budget;
mod envelope;
mod error;
mod handles;
mod ownership;
mod policy;
mod principal;
mod provider;
mod router;

pub use budget::{BudgetedItems, BudgetedText, ContinuationCursor, ResponseBudget};
pub use envelope::{
    Actor, ActorKind, InvocationEnvelope, ResponseMode, ResultEnvelope, ResultStatus, Timing,
    VerificationStatus,
};
pub use error::{CapabilityError, ErrorCode};
pub use handles::HandleRegistry;
pub use ownership::{ResourceKey, ResourceOrigin, TrustedOwnershipRegistry};
pub use policy::{
    ApprovalScope, LocalPolicyBroker, LocalPolicyConfig, PolicyBroker, PolicyDecision,
    SideEffectClass, authorize_path,
};
pub use principal::{PrincipalAuthentication, PrincipalProfile};
pub use provider::{CapabilityProvider, ProviderResult};
pub use router::CapabilityRouter;

pub const CRATE_NAME: &str = "tether-core";
