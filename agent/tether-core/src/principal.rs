use std::collections::BTreeSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalAuthentication {
    LocalProcessBinding,
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
