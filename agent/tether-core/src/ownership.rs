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
