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

impl PrincipalProfile {
    /// Reject a browser-only launch that still carries a shell, filesystem,
    /// batch, desktop, search, or future unknown capability.
    ///
    /// This is an opt-in, local admission check, not owner approval or an
    /// operating-system sandbox. It does not make a TCP CDP debugger safe
    /// for saved website sessions.
    pub fn validate_browser_only(
        &self,
        launched_device_id: Option<&str>,
    ) -> Result<(), &'static str> {
        const BROWSER_ONLY: &[&str] = &[
            "device.status",
            "device.capabilities",
            "browser.status",
            "browser.pages",
            "browser.create_tab",
            "browser.snapshot",
            "browser.navigate",
            "browser.act",
            "browser.wait",
            "browser.close",
        ];

        if self.principal_id.trim().is_empty() {
            return Err("browser-only principal requires an identity");
        }
        if self.allowed_devices.len() != 1 {
            return Err("browser-only principal must be scoped to exactly one device");
        }
        if let Some(device_id) = launched_device_id
            && !self.allowed_devices.contains(device_id)
        {
            return Err("browser-only principal must be scoped to this device");
        }
        if !self.allowed_directories.is_empty() {
            return Err("browser-only principal must not authorize filesystem roots");
        }
        if !self.allowed_capabilities.contains("device.status")
            || !self.allowed_capabilities.contains("device.capabilities")
            || !self
                .allowed_capabilities
                .iter()
                .any(|capability| capability.starts_with("browser."))
        {
            return Err("browser-only principal requires device status and browser capabilities");
        }
        if self
            .allowed_capabilities
            .iter()
            .any(|capability| !BROWSER_ONLY.contains(&capability.as_str()))
        {
            return Err("browser-only principal includes a non-browser capability");
        }
        Ok(())
    }
}
