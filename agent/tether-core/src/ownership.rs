use std::collections::BTreeMap;
use std::sync::RwLock;

use serde_json::Value;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourceOrigin {
    Human,
    Tetherplane,
    HumanOrExternal,
}

impl ResourceOrigin {
    #[must_use]
    pub fn from_arguments(arguments: &Value) -> Option<Self> {
        match arguments.get("origin")?.as_str()? {
            "human" => Some(Self::Human),
            "tetherplane" => Some(Self::Tetherplane),
            "human_or_external" => Some(Self::HumanOrExternal),
            _ => None,
        }
    }

    #[must_use]
    pub fn is_human_origin(self) -> bool {
        matches!(self, Self::Human | Self::HumanOrExternal)
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ResourceKey {
    Process(u32),
    DesktopWindow(String),
    DesktopElement(String),
}

#[derive(Debug, Default)]
pub struct TrustedOwnershipRegistry {
    origins: RwLock<BTreeMap<ResourceKey, ResourceOrigin>>,
}

impl TrustedOwnershipRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &self,
        resource: ResourceKey,
        origin: ResourceOrigin,
    ) -> Option<ResourceOrigin> {
        self.origins
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(resource, origin)
    }

    #[must_use]
    pub fn origin(&self, resource: &ResourceKey) -> Option<ResourceOrigin> {
        self.origins
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(resource)
            .copied()
    }

    #[must_use]
    pub fn is_tetherplane_owned(&self, resource: &ResourceKey) -> bool {
        self.origin(resource) == Some(ResourceOrigin::Tetherplane)
    }

    pub fn unregister(&self, resource: &ResourceKey) -> Option<ResourceOrigin> {
        self.origins
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(resource)
    }
}
