use std::collections::BTreeSet;

use serde_json::json;
use tether_core::{CapabilityError, ErrorCode};

use crate::{DesktopAction, DesktopActionKind, DesktopPattern};

pub const MAX_NATIVE_TEXT_CHARS: usize = 32_767;
pub const MAX_NATIVE_READBACK_CHARS: usize = 65_536;
pub const NATIVE_MESSAGE_TIMEOUT_MS: u32 = 1_000;

pub const WS_DISABLED: u32 = 0x0800_0000;
pub const ES_READONLY: u32 = 0x0800;

pub const BS_TYPEMASK: u32 = 0x0000_000F;
pub const BS_PUSHBUTTON: u32 = 0x0000_0000;
pub const BS_DEFPUSHBUTTON: u32 = 0x0000_0001;
pub const BS_CHECKBOX: u32 = 0x0000_0002;
pub const BS_AUTOCHECKBOX: u32 = 0x0000_0003;
pub const BS_RADIOBUTTON: u32 = 0x0000_0004;
pub const BS_3STATE: u32 = 0x0000_0005;
pub const BS_AUTO3STATE: u32 = 0x0000_0006;
pub const BS_GROUPBOX: u32 = 0x0000_0007;
pub const BS_USERBUTTON: u32 = 0x0000_0008;
pub const BS_AUTORADIOBUTTON: u32 = 0x0000_0009;
pub const BS_PUSHBOX: u32 = 0x0000_000A;
pub const BS_OWNERDRAW: u32 = 0x0000_000B;
pub const BS_SPLITBUTTON: u32 = 0x0000_000C;
pub const BS_DEFSPLITBUTTON: u32 = 0x0000_000D;

pub const LBS_MULTIPLESEL: u32 = 0x0008;
pub const LBS_EXTENDEDSEL: u32 = 0x0800;
pub const LBS_NOSEL: u32 = 0x4000;

pub const MSAA_ROLE_GROUPING: u32 = 0x14;
pub const MSAA_ROLE_LISTITEM: u32 = 0x22;
pub const MSAA_ROLE_PUSHBUTTON: u32 = 0x2B;
pub const MSAA_ROLE_CHECKBUTTON: u32 = 0x2C;
pub const MSAA_ROLE_RADIOBUTTON: u32 = 0x2D;
pub const MSAA_ROLE_SPLITBUTTON: u32 = 0x3E;

pub const MSAA_STATE_UNAVAILABLE: u32 = 0x0000_0001;
pub const MSAA_STATE_READONLY: u32 = 0x0000_0040;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SemanticControlType {
    Button,
    CheckBox,
    ComboBox,
    Custom,
    Document,
    Edit,
    Group,
    List,
    ListItem,
    Pane,
    RadioButton,
    ScrollBar,
    SplitButton,
    Text,
    TitleBar,
    Window,
    Other(i32),
}

impl SemanticControlType {
    #[must_use]
    pub const fn from_uia_control_type_id(id: i32) -> Self {
        match id {
            50_000 => Self::Button,
            50_002 => Self::CheckBox,
            50_003 => Self::ComboBox,
            50_004 => Self::Edit,
            50_007 => Self::ListItem,
            50_008 => Self::List,
            50_013 => Self::RadioButton,
            50_014 => Self::ScrollBar,
            50_020 => Self::Text,
            50_025 => Self::Custom,
            50_026 => Self::Group,
            50_030 => Self::Document,
            50_031 => Self::SplitButton,
            50_032 => Self::Window,
            50_033 => Self::Pane,
            50_037 => Self::TitleBar,
            other => Self::Other(other),
        }
    }

    #[must_use]
    pub const fn as_i32(self) -> i32 {
        match self {
            Self::Button => 50_000,
            Self::CheckBox => 50_002,
            Self::ComboBox => 50_003,
            Self::Edit => 50_004,
            Self::ListItem => 50_007,
            Self::List => 50_008,
            Self::RadioButton => 50_013,
            Self::ScrollBar => 50_014,
            Self::Text => 50_020,
            Self::Custom => 50_025,
            Self::Group => 50_026,
            Self::Document => 50_030,
            Self::SplitButton => 50_031,
            Self::Window => 50_032,
            Self::Pane => 50_033,
            Self::TitleBar => 50_037,
            Self::Other(id) => id,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeWindowKind {
    Edit,
    Button,
    ListBox,
    ComboBox,
    ContainerOrStatic,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeHwndMeta {
    pub addr: usize,
    pub process_id: u32,
    pub class_name: String,
    pub style: u32,
    pub valid_window: bool,
    pub window_enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeListParentMeta {
    pub hwnd: NativeHwndMeta,
    pub sibling_index: usize,
    pub item_count: Option<usize>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(clippy::struct_excessive_bools)]
pub struct ElementCompatInput {
    pub process_id: u32,
    pub framework_id: String,
    pub control_type: SemanticControlType,
    pub enabled: bool,
    pub focused: bool,
    pub is_password: bool,
    pub has_invoke_pattern: bool,
    pub has_value_pattern: bool,
    pub value_is_readonly: Option<bool>,
    pub has_selection_item_pattern: bool,
    pub has_toggle_pattern: bool,
    pub has_expand_collapse_pattern: bool,
    pub legacy_role: Option<u32>,
    pub legacy_state: Option<u32>,
    pub native_hwnd: Option<NativeHwndMeta>,
    pub list_parent: Option<NativeListParentMeta>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlannedAction {
    NativeEditSetText {
        hwnd_addr: usize,
        value: String,
    },
    NativeButtonClick {
        hwnd_addr: usize,
    },
    NativeListBoxSelect {
        parent_hwnd_addr: usize,
        index: usize,
    },
    UiaValuePattern {
        value: String,
        background_unfocused: bool,
    },
    UiaInvokePattern {
        background_unfocused: bool,
    },
    UiaSelectionItemPattern {
        background_unfocused: bool,
    },
    UiaTogglePattern,
    UiaExpandPattern,
    UiaCollapsePattern,
}

#[must_use]
pub fn classify_native_window_class(class_name: &str) -> NativeWindowKind {
    let lower = class_name.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return NativeWindowKind::Unknown;
    }

    if lower == "edit" || lower.starts_with("windowsforms10.edit.") {
        NativeWindowKind::Edit
    } else if lower == "button" || lower.starts_with("windowsforms10.button.") {
        NativeWindowKind::Button
    } else if lower == "listbox"
        || lower == "combolbox"
        || lower.starts_with("windowsforms10.listbox.")
    {
        NativeWindowKind::ListBox
    } else if lower == "combobox" || lower.starts_with("windowsforms10.combobox.") {
        NativeWindowKind::ComboBox
    } else if lower == "static"
        || lower.starts_with("windowsforms10.static.")
        || lower.starts_with("windowsforms10.window.")
    {
        NativeWindowKind::ContainerOrStatic
    } else {
        NativeWindowKind::Unknown
    }
}

#[must_use]
pub fn is_background_safe_uia_framework(framework_id: &str) -> bool {
    matches!(
        framework_id.trim().to_ascii_uppercase().as_str(),
        "WPF" | "XAML"
    )
}

#[must_use]
pub fn is_native_pushbutton_style(style: u32) -> bool {
    let button_type = style & BS_TYPEMASK;
    matches!(
        button_type,
        BS_PUSHBUTTON | BS_DEFPUSHBUTTON | BS_PUSHBOX | BS_SPLITBUTTON | BS_DEFSPLITBUTTON
    )
}

#[must_use]
pub fn is_native_non_pushbutton_style(style: u32) -> bool {
    let button_type = style & BS_TYPEMASK;
    matches!(
        button_type,
        BS_CHECKBOX
            | BS_AUTOCHECKBOX
            | BS_RADIOBUTTON
            | BS_3STATE
            | BS_AUTO3STATE
            | BS_GROUPBOX
            | BS_AUTORADIOBUTTON
    )
}

fn verified_own_hwnd(input: &ElementCompatInput) -> Option<&NativeHwndMeta> {
    input
        .native_hwnd
        .as_ref()
        .filter(|meta| meta.addr != 0 && meta.process_id == input.process_id)
}

fn is_verified_native_edit(input: &ElementCompatInput) -> Option<&NativeHwndMeta> {
    if matches!(
        input.control_type,
        SemanticControlType::Button
            | SemanticControlType::CheckBox
            | SemanticControlType::RadioButton
            | SemanticControlType::Group
            | SemanticControlType::List
            | SemanticControlType::ListItem
            | SemanticControlType::ScrollBar
            | SemanticControlType::TitleBar
            | SemanticControlType::Window
    ) {
        return None;
    }

    let meta = verified_own_hwnd(input)?;
    (classify_native_window_class(&meta.class_name) == NativeWindowKind::Edit).then_some(meta)
}

fn is_verified_native_pushbutton(input: &ElementCompatInput) -> Option<&NativeHwndMeta> {
    if input.has_toggle_pattern {
        return None;
    }
    if matches!(
        input.control_type,
        SemanticControlType::CheckBox
            | SemanticControlType::RadioButton
            | SemanticControlType::Group
            | SemanticControlType::Edit
            | SemanticControlType::Document
            | SemanticControlType::List
            | SemanticControlType::ListItem
            | SemanticControlType::ScrollBar
            | SemanticControlType::TitleBar
            | SemanticControlType::Window
            | SemanticControlType::Text
    ) {
        return None;
    }
    if matches!(
        input.legacy_role,
        Some(MSAA_ROLE_CHECKBUTTON | MSAA_ROLE_RADIOBUTTON | MSAA_ROLE_GROUPING)
    ) {
        return None;
    }

    let meta = verified_own_hwnd(input)?;
    if classify_native_window_class(&meta.class_name) != NativeWindowKind::Button {
        return None;
    }

    if is_native_non_pushbutton_style(meta.style) {
        return None;
    }

    let button_type = meta.style & BS_TYPEMASK;
    if is_native_pushbutton_style(meta.style) {
        return Some(meta);
    }

    if matches!(button_type, BS_OWNERDRAW | BS_USERBUTTON)
        && (matches!(
            input.control_type,
            SemanticControlType::Button | SemanticControlType::SplitButton
        ) || matches!(
            input.legacy_role,
            Some(MSAA_ROLE_PUSHBUTTON | MSAA_ROLE_SPLITBUTTON)
        ))
    {
        return Some(meta);
    }

    None
}

fn verified_native_list_item(input: &ElementCompatInput) -> Option<&NativeListParentMeta> {
    if input.native_hwnd.is_some() {
        return None;
    }
    if !matches!(
        input.control_type,
        SemanticControlType::ListItem
            | SemanticControlType::Pane
            | SemanticControlType::Custom
            | SemanticControlType::Other(_)
    ) {
        return None;
    }
    let has_item_identity = input.control_type == SemanticControlType::ListItem
        || input.legacy_role == Some(MSAA_ROLE_LISTITEM);
    if !has_item_identity {
        return None;
    }

    let parent = input.list_parent.as_ref()?;
    if parent.hwnd.addr == 0 || parent.hwnd.process_id != input.process_id {
        return None;
    }
    if classify_native_window_class(&parent.hwnd.class_name) != NativeWindowKind::ListBox {
        return None;
    }
    if (parent.hwnd.style & (LBS_MULTIPLESEL | LBS_EXTENDEDSEL | LBS_NOSEL)) != 0 {
        return None;
    }

    Some(parent)
}

#[must_use]
pub fn infer_supported_patterns(input: &ElementCompatInput) -> Vec<DesktopPattern> {
    let mut patterns = Vec::with_capacity(5);
    let mut seen = BTreeSet::new();

    let mut push = |pattern: DesktopPattern| {
        let key = match pattern {
            DesktopPattern::Invoke => 0_u8,
            DesktopPattern::Value => 1_u8,
            DesktopPattern::Selection => 2_u8,
            DesktopPattern::Toggle => 3_u8,
            DesktopPattern::ExpandCollapse => 4_u8,
        };
        if seen.insert(key) {
            patterns.push(pattern);
        }
    };

    if input.has_invoke_pattern || is_verified_native_pushbutton(input).is_some() {
        push(DesktopPattern::Invoke);
    }
    if input.control_type != SemanticControlType::TitleBar
        && (input.has_value_pattern || is_verified_native_edit(input).is_some())
    {
        push(DesktopPattern::Value);
    }
    let native_list_item_ready = verified_native_list_item(input)
        .is_some_and(|parent| parent.item_count.is_none_or(|c| parent.sibling_index < c));
    if input.has_selection_item_pattern || native_list_item_ready {
        push(DesktopPattern::Selection);
    }
    if input.has_toggle_pattern {
        push(DesktopPattern::Toggle);
    }
    if input.has_expand_collapse_pattern {
        push(DesktopPattern::ExpandCollapse);
    }

    patterns
}

/// Resolves an already-authorized `DesktopAction` into a concrete background-safe transport plan.
///
/// # Errors
///
/// - `InvalidArguments` for missing, NUL-containing, or oversized text payloads.
/// - `CapabilityUnavailable` when the control neither exposes the requested pattern nor qualifies
///   for a verified native Win32 fallback on the same owning process.
/// - `ActionUnverified` when the control/HWND is invalid, disabled, out-of-range, or unfocused on
///   a framework that cannot safely execute without foreground focus.
/// - `PermissionDenied` when attempting `SetValue` on a read-only or password control.
pub fn plan_action(
    input: &ElementCompatInput,
    action: &DesktopAction,
) -> Result<PlannedAction, CapabilityError> {
    match action.kind {
        DesktopActionKind::SetValue => plan_set_value(input, action),
        DesktopActionKind::Invoke => plan_invoke(input, action),
        DesktopActionKind::Select => plan_select(input, action),
        DesktopActionKind::Toggle => {
            if !input.has_toggle_pattern {
                return Err(capability_unavailable(
                    &action.reference,
                    DesktopPattern::Toggle,
                ));
            }
            ensure_uia_enabled(input)?;
            Ok(PlannedAction::UiaTogglePattern)
        }
        DesktopActionKind::Expand => {
            if !input.has_expand_collapse_pattern {
                return Err(capability_unavailable(
                    &action.reference,
                    DesktopPattern::ExpandCollapse,
                ));
            }
            ensure_uia_enabled(input)?;
            Ok(PlannedAction::UiaExpandPattern)
        }
        DesktopActionKind::Collapse => {
            if !input.has_expand_collapse_pattern {
                return Err(capability_unavailable(
                    &action.reference,
                    DesktopPattern::ExpandCollapse,
                ));
            }
            ensure_uia_enabled(input)?;
            Ok(PlannedAction::UiaCollapsePattern)
        }
    }
}

fn plan_set_value(
    input: &ElementCompatInput,
    action: &DesktopAction,
) -> Result<PlannedAction, CapabilityError> {
    let value = action
        .value
        .as_deref()
        .ok_or_else(|| invalid_arguments("set_value requires value"))?;
    if value.contains('\0') {
        return Err(invalid_arguments(
            "desktop set_value payload must not contain NUL bytes",
        ));
    }
    if input.control_type == SemanticControlType::TitleBar {
        return Err(capability_unavailable(
            &action.reference,
            DesktopPattern::Value,
        ));
    }

    if let Some(meta) = is_verified_native_edit(input) {
        if value.encode_utf16().count() > MAX_NATIVE_TEXT_CHARS {
            return Err(invalid_arguments(&format!(
                "desktop set_value native payload exceeds {MAX_NATIVE_TEXT_CHARS} UTF-16 code units"
            )));
        }
        ensure_uia_enabled(input)?;
        ensure_hwnd_ready(meta)?;
        if input.is_password {
            return Err(permission_denied(
                "desktop value target is password-protected",
            ));
        }
        if is_readonly(input, Some(meta)) {
            return Err(permission_denied("desktop value target is read-only"));
        }
        return Ok(PlannedAction::NativeEditSetText {
            hwnd_addr: meta.addr,
            value: value.to_owned(),
        });
    }

    if !input.has_value_pattern {
        return Err(capability_unavailable(
            &action.reference,
            DesktopPattern::Value,
        ));
    }

    ensure_uia_enabled(input)?;
    if input.is_password {
        return Err(permission_denied(
            "desktop value target is password-protected",
        ));
    }
    if is_readonly(input, None) {
        return Err(permission_denied("desktop value target is read-only"));
    }

    let background_unfocused = ensure_background_uia_eligible(
        input,
        "background-safe value mutation is unavailable for this unfocused control",
    )?;

    Ok(PlannedAction::UiaValuePattern {
        value: value.to_owned(),
        background_unfocused,
    })
}

fn plan_invoke(
    input: &ElementCompatInput,
    action: &DesktopAction,
) -> Result<PlannedAction, CapabilityError> {
    if let Some(meta) = is_verified_native_pushbutton(input) {
        ensure_uia_enabled(input)?;
        ensure_hwnd_ready(meta)?;
        return Ok(PlannedAction::NativeButtonClick {
            hwnd_addr: meta.addr,
        });
    }

    if !input.has_invoke_pattern {
        return Err(capability_unavailable(
            &action.reference,
            DesktopPattern::Invoke,
        ));
    }

    ensure_uia_enabled(input)?;
    let background_unfocused = ensure_background_uia_eligible(
        input,
        "background-safe invoke is unavailable for this unfocused control",
    )?;

    Ok(PlannedAction::UiaInvokePattern {
        background_unfocused,
    })
}

fn plan_select(
    input: &ElementCompatInput,
    action: &DesktopAction,
) -> Result<PlannedAction, CapabilityError> {
    if let Some(parent) = verified_native_list_item(input) {
        ensure_uia_enabled(input)?;
        ensure_hwnd_ready(&parent.hwnd)?;
        if let Some(count) = parent.item_count
            && parent.sibling_index >= count
        {
            return Err(action_unverified(
                "list item index is out of range for native ListBox item count",
            ));
        }
        return Ok(PlannedAction::NativeListBoxSelect {
            parent_hwnd_addr: parent.hwnd.addr,
            index: parent.sibling_index,
        });
    }

    if !input.has_selection_item_pattern {
        return Err(capability_unavailable(
            &action.reference,
            DesktopPattern::Selection,
        ));
    }

    ensure_uia_enabled(input)?;
    let background_unfocused = ensure_background_uia_eligible(
        input,
        "background-safe selection is unavailable for this unfocused control",
    )?;

    Ok(PlannedAction::UiaSelectionItemPattern {
        background_unfocused,
    })
}

fn ensure_uia_enabled(input: &ElementCompatInput) -> Result<(), CapabilityError> {
    if !input.enabled {
        return Err(action_unverified("desktop target is disabled in UIA"));
    }
    if input
        .legacy_state
        .is_some_and(|state| (state & MSAA_STATE_UNAVAILABLE) != 0)
    {
        return Err(action_unverified(
            "desktop target reports unavailable legacy state",
        ));
    }
    Ok(())
}

fn ensure_hwnd_ready(meta: &NativeHwndMeta) -> Result<(), CapabilityError> {
    if !meta.valid_window {
        return Err(action_unverified("native window handle is no longer valid"));
    }
    if !meta.window_enabled || (meta.style & WS_DISABLED) != 0 {
        return Err(action_unverified("native window control is disabled"));
    }
    Ok(())
}

fn is_readonly(input: &ElementCompatInput, native_edit: Option<&NativeHwndMeta>) -> bool {
    if input.value_is_readonly == Some(true) {
        return true;
    }
    if input
        .legacy_state
        .is_some_and(|state| (state & MSAA_STATE_READONLY) != 0)
    {
        return true;
    }
    native_edit.is_some_and(|meta| (meta.style & ES_READONLY) != 0)
}

fn ensure_background_uia_eligible(
    input: &ElementCompatInput,
    unfocused_message: &str,
) -> Result<bool, CapabilityError> {
    if input.focused {
        return Ok(false);
    }
    if is_background_safe_uia_framework(&input.framework_id) {
        return Ok(true);
    }
    Err(CapabilityError {
        code: ErrorCode::ActionUnverified,
        message: unfocused_message.to_owned(),
        recovery_hint: Some(
            "use a provider-native background mutation path or an explicitly authorized foreground lease"
                .into(),
        ),
        details: json!({
            "framework_id": input.framework_id,
            "control_type": input.control_type.as_i32(),
        }),
    })
}

/// Verifies post-action `set_value` readback against the expected string.
///
/// # Errors
///
/// Returns `ActionUnverified` if readback failed or does not match `expected`.
pub fn verify_set_value_readback(
    expected: &str,
    observed: Option<&str>,
    transport: &str,
) -> Result<(), CapabilityError> {
    match observed {
        Some(actual) if actual == expected => Ok(()),
        Some(_) => Err(CapabilityError {
            code: ErrorCode::ActionUnverified,
            message: "desktop value mutation could not be verified by post-action readback".into(),
            recovery_hint: Some("take a fresh desktop snapshot and verify target state".into()),
            details: json!({ "transport": transport, "reason": "readback_mismatch" }),
        }),
        None => Err(CapabilityError {
            code: ErrorCode::ActionUnverified,
            message: "desktop value readback returned no verifiable state".into(),
            recovery_hint: Some("take a fresh desktop snapshot and verify target state".into()),
            details: json!({ "transport": transport, "reason": "readback_unavailable" }),
        }),
    }
}

/// Verifies post-action `LB_GETCURSEL` readback against the expected zero-based index.
///
/// # Errors
///
/// Returns `ActionUnverified` when selection index mismatches or equals `LB_ERR` (`-1`).
pub fn verify_select_readback(
    expected_index: usize,
    observed_index: isize,
) -> Result<(), CapabilityError> {
    if observed_index >= 0 && isize::try_from(expected_index).ok() == Some(observed_index) {
        return Ok(());
    }
    Err(CapabilityError {
        code: ErrorCode::ActionUnverified,
        message: "desktop selection could not be verified by post-action readback".into(),
        recovery_hint: Some("take a fresh desktop snapshot and verify selected item".into()),
        details: json!({
            "expected_index": expected_index,
            "observed_index": observed_index,
        }),
    })
}

/// Verifies that background desktop interaction did not transfer OS foreground focus to `target_pid`.
///
/// # Errors
///
/// Returns `ActionUnverified` if `target_was_foreground` is `false` and the foreground process after
/// the action became `target_pid`.
pub fn check_focus_preserved(
    target_pid: u32,
    target_was_foreground: bool,
    foreground_pid_before: Option<u32>,
    foreground_pid_after: Option<u32>,
) -> Result<(), CapabilityError> {
    if !target_was_foreground && foreground_pid_after == Some(target_pid) {
        return Err(CapabilityError {
            code: ErrorCode::ActionUnverified,
            message: "semantic desktop action altered foreground focus in background_only mode"
                .into(),
            recovery_hint: Some(
                "restore human window focus and avoid actions that activate background windows"
                    .into(),
            ),
            details: json!({
                "target_process_id": target_pid,
                "foreground_pid_before": foreground_pid_before,
                "foreground_pid_after": foreground_pid_after,
            }),
        });
    }
    Ok(())
}

fn capability_unavailable(reference: &str, required: DesktopPattern) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::CapabilityUnavailable,
        message: "desktop target does not support requested semantic action".into(),
        recovery_hint: Some("take a fresh snapshot and inspect supported patterns".into()),
        details: json!({
            "reference": reference,
            "required_pattern": required,
        }),
    }
}

fn action_unverified(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ActionUnverified,
        message: message.to_owned(),
        recovery_hint: Some("take a fresh desktop snapshot and retry semantically".into()),
        details: json!({}),
    }
}

fn permission_denied(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::PermissionDenied,
        message: message.to_owned(),
        recovery_hint: None,
        details: json!({}),
    }
}

fn invalid_arguments(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
        details: json!({}),
    }
}
