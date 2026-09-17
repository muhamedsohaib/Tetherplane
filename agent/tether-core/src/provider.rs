use async_trait::async_trait;
use serde_json::Value;

use crate::{CapabilityError, InvocationEnvelope, VerificationStatus};

#[derive(Debug)]
pub struct ProviderResult {
    pub data: Value,
    pub delta: Option<Value>,
    pub verification: VerificationStatus,
}

#[async_trait]
pub trait CapabilityProvider: Send + Sync {
    fn namespace(&self) -> &'static str;

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError>;
}
