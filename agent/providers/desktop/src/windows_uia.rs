use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread;
use std::time::Duration;

use serde_json::json;
use tether_core::{CapabilityError, ErrorCode};
use uiautomation::patterns::{
    UIExpandCollapsePattern, UIInvokePattern, UILegacyIAccessiblePattern, UISelectionItemPattern,
    UITogglePattern, UIValuePattern,
};
use uiautomation::types::{ControlType, ExpandCollapseState};
use uiautomation::{UIAutomation, UIElement, UITreeWalker};
use windows_win::raw::window::{send_message, send_push_button};
use windows_win::sys::{LPARAM, LRESULT, UINT, WM_GETTEXT, WM_GETTEXTLENGTH, WM_SETTEXT, WPARAM};
use winsafe::{EnumWindows, HWND, co};

use crate::windows_compat::{
    ElementCompatInput, MAX_NATIVE_READBACK_CHARS, NATIVE_MESSAGE_TIMEOUT_MS, NativeHwndMeta,
    NativeListParentMeta, NativeWindowKind, PlannedAction, SemanticControlType,
    check_focus_preserved, classify_native_window_class, infer_supported_patterns, plan_action,
    verify_select_readback, verify_set_value_readback,
};
use crate::{DesktopAction, DesktopActionOutcome, DesktopBackend, DesktopNode, DesktopRect};

const MAX_WINDOWS_SNAPSHOT_NODES: usize = 1_001;
const MAX_WINDOWS_SNAPSHOT_DEPTH: usize = 8;
const MAX_HWND_MAP_ENTRIES: usize = 16_384;

const LB_SETCURSEL: UINT = 0x0186;
const LB_GETCURSEL: UINT = 0x0188;
const LB_GETCOUNT: UINT = 0x018B;
const LB_ERR: LRESULT = -1;
const LBS_NOTIFY: u32 = 0x0001;
const WM_COMMAND: UINT = 0x0111;
const LBN_SELCHANGE: usize = 1;

static UIA_INIT_LOCK: Mutex<()> = Mutex::new(());

enum WorkerRequest {
    Snapshot(Sender<Result<Vec<DesktopNode>, CapabilityError>>),
    Target {
        reference: String,
        response: Sender<Result<DesktopNode, CapabilityError>>,
    },
    Perform {
        action: DesktopAction,
        response: Sender<Result<DesktopActionOutcome, CapabilityError>>,
    },
    Shutdown,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum ElementIdentity {
    RuntimeId {
        process_id: u32,
        runtime_id: Vec<i32>,
    },
    Structural {
        process_id: u32,
        parent_reference: Option<String>,
        native_hwnd: usize,
        sibling_index: usize,
        automation_id: String,
        class_name: String,
        control_type_id: i32,
    },
}

struct CachedElement {
    element: UIElement,
    node: DesktopNode,
    sibling_index: usize,
    list_parent_hwnd: Option<usize>,
}

struct ElementObservation<'a> {
    process_id: u32,
    parent_reference: Option<&'a str>,
    sibling_index: usize,
    native_hwnd_addr: usize,
    control_type: SemanticControlType,
    hwnd_meta: Option<NativeHwndMeta>,
    list_parent: Option<NativeListParentMeta>,
}

struct WalkFrame<'a> {
    parent_reference: Option<&'a str>,
    parent_list_meta: Option<&'a NativeHwndMeta>,
    depth: usize,
}

struct WorkerState {
    automation: UIAutomation,
    walker: UITreeWalker,
    references: HashMap<String, CachedElement>,
    stable_references: BTreeMap<ElementIdentity, String>,
    next_reference: u64,
}

impl WorkerState {
    fn new_with_transient_retry() -> Result<Self, CapabilityError> {
        const RETRY_DELAYS_MS: [u64; 2] = [25, 50];
        match Self::new() {
            Ok(state) => Ok(state),
            Err(first_error) => {
                for delay_ms in RETRY_DELAYS_MS {
                    thread::sleep(Duration::from_millis(delay_ms));
                    if let Ok(state) = Self::new() {
                        return Ok(state);
                    }
                }
                Err(first_error)
            }
        }
    }

    fn new() -> Result<Self, CapabilityError> {
        let automation = UIAutomation::new().map_err(|error| uia_provider_error(&error))?;
        let walker = automation
            .get_control_view_walker()
            .map_err(|error| uia_provider_error(&error))?;
        Ok(Self {
            automation,
            walker,
            references: HashMap::new(),
            stable_references: BTreeMap::new(),
            next_reference: 1,
        })
    }

    fn run(&mut self, requests: &Receiver<WorkerRequest>) {
        while let Ok(request) = requests.recv() {
            match request {
                WorkerRequest::Snapshot(response) => {
                    let _ = response.send(self.snapshot());
                }
                WorkerRequest::Target {
                    reference,
                    response,
                } => {
                    let _ = response.send(self.target(&reference));
                }
                WorkerRequest::Perform { action, response } => {
                    let _ = response.send(self.perform(&action));
                }
                WorkerRequest::Shutdown => break,
            }
        }
    }

    fn snapshot(&mut self) -> Result<Vec<DesktopNode>, CapabilityError> {
        let root = self
            .automation
            .get_root_element()
            .map_err(|error| uia_provider_error(&error))?;
        let walker = self.walker.clone();
        let hwnd_map = collect_hwnd_map();
        self.references.clear();

        let mut nodes = Vec::new();
        if let Ok(first) = walker.get_first_child(&root) {
            let frame = WalkFrame {
                parent_reference: None,
                parent_list_meta: None,
                depth: 0,
            };
            self.walk_siblings(&walker, first, &frame, &hwnd_map, &mut nodes);
        }
        Ok(nodes)
    }

    fn walk_siblings(
        &mut self,
        walker: &UITreeWalker,
        mut current: UIElement,
        frame: &WalkFrame<'_>,
        hwnd_map: &HashMap<usize, NativeHwndMeta>,
        nodes: &mut Vec<DesktopNode>,
    ) {
        let mut sibling_index = 0_usize;
        let mut list_item_index = 0_usize;

        loop {
            if nodes.len() >= MAX_WINDOWS_SNAPSHOT_NODES {
                return;
            }

            let mut current_reference = None;
            let mut child_list_meta = None;

            if let Ok(process_id) = current.get_process_id() {
                let native_hwnd_addr = element_native_hwnd(&current);
                let control_type = element_control_type(&current);
                let hwnd_meta = (native_hwnd_addr != 0)
                    .then(|| hwnd_map.get(&native_hwnd_addr).cloned())
                    .flatten();

                let list_parent = if let Some(parent_meta) = frame.parent_list_meta
                    && native_hwnd_addr == 0
                    && control_type != SemanticControlType::ScrollBar
                {
                    let idx = list_item_index;
                    list_item_index = list_item_index.saturating_add(1);
                    Some(NativeListParentMeta {
                        hwnd: parent_meta.clone(),
                        sibling_index: idx,
                        item_count: None,
                    })
                } else {
                    None
                };

                child_list_meta = hwnd_meta
                    .as_ref()
                    .filter(|meta| {
                        meta.process_id == process_id
                            && classify_native_window_class(&meta.class_name)
                                == NativeWindowKind::ListBox
                    })
                    .cloned();

                let observation = ElementObservation {
                    process_id,
                    parent_reference: frame.parent_reference,
                    sibling_index,
                    native_hwnd_addr,
                    control_type,
                    hwnd_meta,
                    list_parent,
                };
                let node = self.describe_element(&current, &observation);
                current_reference = Some(node.reference.clone());
                nodes.push(node);
            }

            if frame.depth < MAX_WINDOWS_SNAPSHOT_DEPTH
                && nodes.len() < MAX_WINDOWS_SNAPSHOT_NODES
                && let Ok(child) = walker.get_first_child(&current)
            {
                let child_frame = WalkFrame {
                    parent_reference: current_reference.as_deref(),
                    parent_list_meta: child_list_meta.as_ref(),
                    depth: frame.depth + 1,
                };
                self.walk_siblings(walker, child, &child_frame, hwnd_map, nodes);
            }

            if nodes.len() >= MAX_WINDOWS_SNAPSHOT_NODES {
                return;
            }

            sibling_index = sibling_index.saturating_add(1);
            match walker.get_next_sibling(&current) {
                Ok(next) => current = next,
                Err(_) => return,
            }
        }
    }

    fn describe_element(
        &mut self,
        element: &UIElement,
        obs: &ElementObservation<'_>,
    ) -> DesktopNode {
        let automation_id = element.get_automation_id().unwrap_or_default();
        let class_name = element.get_classname().unwrap_or_default();
        let name = element.get_name().unwrap_or_default();
        let role = element
            .get_localized_control_type()
            .unwrap_or_else(|_| "unknown".to_owned());

        let identity = element_identity(element, obs, &automation_id, &class_name);
        let reference = if let Some(existing) = self.stable_references.get(&identity) {
            existing.clone()
        } else {
            let fresh = self.allocate_reference();
            self.stable_references.insert(identity, fresh.clone());
            fresh
        };

        let enabled = element.is_enabled().unwrap_or(false);
        let focused = element.has_keyboard_focus().unwrap_or(false);
        let focusable = element.is_keyboard_focusable().unwrap_or(false);
        let needs_legacy = should_query_legacy_in_snapshot(obs);
        let (legacy_role, legacy_state) = if needs_legacy {
            read_legacy_role_and_state(element)
        } else {
            (None, None)
        };

        let compat_input = ElementCompatInput {
            process_id: obs.process_id,
            framework_id: element.get_framework_id().unwrap_or_default(),
            control_type: obs.control_type,
            enabled,
            focused,
            is_password: false,
            has_invoke_pattern: element.get_pattern::<UIInvokePattern>().is_ok(),
            has_value_pattern: element.get_pattern::<UIValuePattern>().is_ok(),
            value_is_readonly: None,
            has_selection_item_pattern: element.get_pattern::<UISelectionItemPattern>().is_ok(),
            has_toggle_pattern: element.get_pattern::<UITogglePattern>().is_ok(),
            has_expand_collapse_pattern: element.get_pattern::<UIExpandCollapsePattern>().is_ok(),
            legacy_role,
            legacy_state,
            native_hwnd: obs.hwnd_meta.clone(),
            list_parent: obs.list_parent.clone(),
        };

        let bounding_rectangle = element
            .get_bounding_rectangle()
            .ok()
            .map(|rect| DesktopRect {
                left: rect.get_left(),
                top: rect.get_top(),
                right: rect.get_right(),
                bottom: rect.get_bottom(),
            });

        let node = DesktopNode {
            reference: reference.clone(),
            parent_reference: obs.parent_reference.map(str::to_owned),
            role,
            name,
            automation_id: non_empty(automation_id),
            class_name: non_empty(class_name),
            process_id: obs.process_id,
            enabled,
            focusable,
            focused,
            bounding_rectangle,
            patterns: infer_supported_patterns(&compat_input),
        };

        let list_parent_hwnd = obs.list_parent.as_ref().map(|parent| parent.hwnd.addr);
        self.references.insert(
            reference,
            CachedElement {
                element: element.clone(),
                node: node.clone(),
                sibling_index: obs.sibling_index,
                list_parent_hwnd,
            },
        );
        node
    }

    fn target(&mut self, reference: &str) -> Result<DesktopNode, CapabilityError> {
        if let Ok(target) = self.refresh_target(reference) {
            return Ok(target);
        }

        self.snapshot()?;
        self.refresh_target(reference)
    }

    fn refresh_target(&mut self, reference: &str) -> Result<DesktopNode, CapabilityError> {
        let cached = self
            .references
            .get(reference)
            .ok_or_else(|| stale_reference(reference))?;
        let element = cached.element.clone();
        let parent_reference = cached.node.parent_reference.clone();
        let sibling_index = cached.sibling_index;
        let list_parent_hwnd = cached.list_parent_hwnd;

        let process_id = element
            .get_process_id()
            .map_err(|_| stale_reference(reference))?;
        let native_hwnd_addr = element_native_hwnd(&element);
        let control_type = element_control_type(&element);
        let hwnd_meta = lookup_hwnd_meta(native_hwnd_addr, process_id);
        let list_parent = if list_parent_hwnd.is_some() {
            resolve_live_list_parent(
                &self.automation,
                &self.walker,
                &element,
                process_id,
                list_parent_hwnd,
            )
        } else {
            None
        };

        let observation = ElementObservation {
            process_id,
            parent_reference: parent_reference.as_deref(),
            sibling_index,
            native_hwnd_addr,
            control_type,
            hwnd_meta,
            list_parent,
        };
        let refreshed = self.describe_element(&element, &observation);

        if refreshed.reference != reference {
            return Err(stale_reference(reference));
        }
        Ok(refreshed)
    }

    fn perform(&mut self, action: &DesktopAction) -> Result<DesktopActionOutcome, CapabilityError> {
        let before = self.target(&action.reference)?;
        let cached = self
            .references
            .get(&action.reference)
            .ok_or_else(|| stale_reference(&action.reference))?;
        let element = cached.element.clone();
        let cached_list_parent_hwnd = cached.list_parent_hwnd;

        let (verified, delta) = execute_semantic_action(
            &self.automation,
            &self.walker,
            &element,
            cached_list_parent_hwnd,
            action,
        )?;

        let target = self.refresh_target(&action.reference).unwrap_or(before);
        Ok(DesktopActionOutcome {
            target,
            verified,
            delta,
        })
    }

    fn allocate_reference(&mut self) -> String {
        let reference = format!("desk_{:016x}", self.next_reference);
        self.next_reference = self.next_reference.saturating_add(1);
        reference
    }
}

fn element_identity(
    element: &UIElement,
    obs: &ElementObservation<'_>,
    automation_id: &str,
    class_name: &str,
) -> ElementIdentity {
    match element.get_runtime_id() {
        Ok(runtime_id) if !runtime_id.is_empty() => ElementIdentity::RuntimeId {
            process_id: obs.process_id,
            runtime_id,
        },
        _ => ElementIdentity::Structural {
            process_id: obs.process_id,
            parent_reference: obs.parent_reference.map(str::to_owned),
            native_hwnd: obs.native_hwnd_addr,
            sibling_index: obs.sibling_index,
            automation_id: automation_id.to_owned(),
            class_name: class_name.to_owned(),
            control_type_id: obs.control_type.as_i32(),
        },
    }
}

fn should_query_legacy_in_snapshot(obs: &ElementObservation<'_>) -> bool {
    let is_native_button = obs.hwnd_meta.as_ref().is_some_and(|meta| {
        meta.process_id == obs.process_id
            && classify_native_window_class(&meta.class_name) == NativeWindowKind::Button
    });
    let is_native_list_item = obs.list_parent.is_some()
        && obs.hwnd_meta.is_none()
        && obs.control_type != SemanticControlType::ScrollBar;
    is_native_button || is_native_list_item
}

fn read_legacy_role_and_state(element: &UIElement) -> (Option<u32>, Option<u32>) {
    let Ok(legacy) = element.get_pattern::<UILegacyIAccessiblePattern>() else {
        return (None, None);
    };
    (legacy.get_role().ok(), legacy.get_state().ok())
}

fn element_native_hwnd(element: &UIElement) -> usize {
    let Ok(handle) = element.get_native_window_handle() else {
        return 0;
    };
    let raw: isize = handle.into();
    usize::from_ne_bytes(raw.to_ne_bytes())
}

fn element_control_type(element: &UIElement) -> SemanticControlType {
    element.get_control_type().map_or(
        SemanticControlType::Other(0),
        |control_type: ControlType| {
            SemanticControlType::from_uia_control_type_id(control_type as i32)
        },
    )
}

fn collect_hwnd_map() -> HashMap<usize, NativeHwndMeta> {
    let mut map = HashMap::new();
    let _ = EnumWindows(|top: HWND| -> bool {
        if map.len() >= MAX_HWND_MAP_ENTRIES {
            return true;
        }
        record_hwnd_meta(&top, &mut map);
        top.EnumChildWindows(|child: HWND| -> bool {
            if map.len() >= MAX_HWND_MAP_ENTRIES {
                return false;
            }
            record_hwnd_meta(&child, &mut map);
            true
        });
        true
    });
    map
}

fn record_hwnd_meta(hwnd: &HWND, map: &mut HashMap<usize, NativeHwndMeta>) {
    let addr = hwnd.ptr().expose_provenance();
    if addr == 0 {
        return;
    }
    map.entry(addr).or_insert_with(|| {
        let (_, process_id) = hwnd.GetWindowThreadProcessId();
        read_hwnd_meta(hwnd, addr, process_id)
    });
}

fn read_hwnd_meta(hwnd: &HWND, addr: usize, process_id: u32) -> NativeHwndMeta {
    let class_name = hwnd
        .RealGetWindowClass()
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| hwnd.GetClassName().ok())
        .unwrap_or_default();
    let style_bytes = hwnd.GetWindowLongPtr(co::GWLP::STYLE).to_le_bytes();
    let style = u32::from_le_bytes([
        style_bytes[0],
        style_bytes[1],
        style_bytes[2],
        style_bytes[3],
    ]);

    NativeHwndMeta {
        addr,
        process_id,
        class_name,
        style,
        valid_window: hwnd.IsWindow(),
        window_enabled: hwnd.IsWindowEnabled(),
    }
}

fn lookup_hwnd_meta(addr: usize, expected_pid: u32) -> Option<NativeHwndMeta> {
    if addr == 0 {
        return None;
    }
    with_verified_pid_hwnd(addr, expected_pid, |hwnd| {
        Ok(read_hwnd_meta(hwnd, addr, expected_pid))
    })
    .ok()
}

fn with_verified_pid_hwnd<T, F>(
    target_addr: usize,
    expected_pid: u32,
    mut op: F,
) -> Result<T, CapabilityError>
where
    F: FnMut(&HWND) -> Result<T, CapabilityError>,
{
    if target_addr == 0 {
        return Err(action_unverified("native window handle is null"));
    }

    let mut outcome: Option<Result<T, CapabilityError>> = None;
    let enum_res = EnumWindows(|top: HWND| -> bool {
        if outcome.is_some() {
            return true;
        }
        if top.ptr().expose_provenance() == target_addr {
            outcome = Some(run_verified_hwnd_op(&top, expected_pid, &mut op));
            return true;
        }

        top.EnumChildWindows(|child: HWND| -> bool {
            if outcome.is_some() {
                return false;
            }
            if child.ptr().expose_provenance() == target_addr {
                outcome = Some(run_verified_hwnd_op(&child, expected_pid, &mut op));
                return false;
            }
            true
        });
        true
    });

    if let Some(res) = outcome {
        res
    } else if let Err(error) = enum_res {
        Err(action_unverified(format!(
            "failed to verify native window handle ownership: {error}"
        )))
    } else {
        Err(action_unverified(
            "native window handle is no longer present in desktop hierarchy",
        ))
    }
}

fn run_verified_hwnd_op<T, F>(
    hwnd: &HWND,
    expected_pid: u32,
    op: &mut F,
) -> Result<T, CapabilityError>
where
    F: FnMut(&HWND) -> Result<T, CapabilityError>,
{
    let (_, pid) = hwnd.GetWindowThreadProcessId();
    if pid != expected_pid {
        return Err(action_unverified(
            "native window handle belongs to a different process",
        ));
    }
    if !hwnd.IsWindow() {
        return Err(action_unverified("native window handle is no longer valid"));
    }
    op(hwnd)
}

fn resolve_live_list_parent(
    automation: &UIAutomation,
    walker: &UITreeWalker,
    element: &UIElement,
    expected_pid: u32,
    expected_parent_hwnd: Option<usize>,
) -> Option<NativeListParentMeta> {
    let parent = walker.get_parent(element).ok()?;
    if parent.get_process_id().ok()? != expected_pid {
        return None;
    }

    let parent_addr = element_native_hwnd(&parent);
    if parent_addr == 0
        || expected_parent_hwnd.is_some_and(|expected_addr| expected_addr != parent_addr)
    {
        return None;
    }

    let parent_meta = lookup_hwnd_meta(parent_addr, expected_pid)?;
    if classify_native_window_class(&parent_meta.class_name) != NativeWindowKind::ListBox {
        return None;
    }

    let mut current = walker.get_first_child(&parent).ok()?;
    let mut item_index = 0_usize;
    for _ in 0..MAX_WINDOWS_SNAPSHOT_NODES {
        let cur_hwnd = element_native_hwnd(&current);
        let cur_type = element_control_type(&current);
        if automation
            .compare_elements(&current, element)
            .unwrap_or(false)
        {
            if cur_hwnd != 0 || cur_type == SemanticControlType::ScrollBar {
                return None;
            }
            return Some(NativeListParentMeta {
                hwnd: parent_meta,
                sibling_index: item_index,
                item_count: None,
            });
        }
        if cur_hwnd == 0 && cur_type != SemanticControlType::ScrollBar {
            item_index = item_index.saturating_add(1);
        }
        current = walker.get_next_sibling(&current).ok()?;
    }

    None
}

fn build_live_compat_input(
    automation: &UIAutomation,
    walker: &UITreeWalker,
    element: &UIElement,
    process_id: u32,
    cached_list_parent_hwnd: Option<usize>,
) -> (ElementCompatInput, Option<UIValuePattern>) {
    let value_pattern = element.get_pattern::<UIValuePattern>().ok();
    let value_is_readonly = value_pattern
        .as_ref()
        .and_then(|pattern| pattern.is_readonly().ok());
    let (legacy_role, legacy_state) = read_legacy_role_and_state(element);
    let native_hwnd = lookup_hwnd_meta(element_native_hwnd(element), process_id);
    let mut list_parent = if native_hwnd.is_none() {
        resolve_live_list_parent(
            automation,
            walker,
            element,
            process_id,
            cached_list_parent_hwnd,
        )
    } else {
        None
    };
    if let Some(ref mut meta) = list_parent {
        meta.item_count = lb_get_count(meta.hwnd.addr, process_id);
    }

    let input = ElementCompatInput {
        process_id,
        framework_id: element.get_framework_id().unwrap_or_default(),
        control_type: element_control_type(element),
        enabled: element.is_enabled().unwrap_or(false),
        focused: element.has_keyboard_focus().unwrap_or(false),
        is_password: element.is_password().unwrap_or(false),
        has_invoke_pattern: element.get_pattern::<UIInvokePattern>().is_ok(),
        has_value_pattern: value_pattern.is_some(),
        value_is_readonly,
        has_selection_item_pattern: element.get_pattern::<UISelectionItemPattern>().is_ok(),
        has_toggle_pattern: element.get_pattern::<UITogglePattern>().is_ok(),
        has_expand_collapse_pattern: element.get_pattern::<UIExpandCollapsePattern>().is_ok(),
        legacy_role,
        legacy_state,
        native_hwnd,
        list_parent,
    };
    (input, value_pattern)
}

fn foreground_process_id() -> Option<u32> {
    HWND::GetForegroundWindow().and_then(|hwnd| {
        let (_, process_id) = hwnd.GetWindowThreadProcessId();
        (process_id != 0).then_some(process_id)
    })
}

fn execute_semantic_action(
    automation: &UIAutomation,
    walker: &UITreeWalker,
    element: &UIElement,
    cached_list_parent_hwnd: Option<usize>,
    action: &DesktopAction,
) -> Result<(bool, serde_json::Value), CapabilityError> {
    let process_id = element
        .get_process_id()
        .map_err(|_| stale_reference(&action.reference))?;
    let (input, value_pattern) = build_live_compat_input(
        automation,
        walker,
        element,
        process_id,
        cached_list_parent_hwnd,
    );
    let planned = plan_action(&input, action)?;

    let fg_before = foreground_process_id();
    let target_was_foreground = fg_before == Some(process_id);

    let outcome = dispatch_planned_action(
        element,
        process_id,
        planned,
        value_pattern.as_ref(),
        target_was_foreground,
        fg_before,
    )?;

    check_focus_preserved(
        process_id,
        target_was_foreground,
        fg_before,
        foreground_process_id(),
    )?;

    Ok(outcome)
}

fn dispatch_planned_action(
    element: &UIElement,
    process_id: u32,
    planned: PlannedAction,
    value_pattern: Option<&UIValuePattern>,
    target_was_foreground: bool,
    fg_before: Option<u32>,
) -> Result<(bool, serde_json::Value), CapabilityError> {
    match planned {
        PlannedAction::NativeEditSetText { hwnd_addr, value } => {
            wm_set_text(hwnd_addr, process_id, &value)?;
            check_focus_preserved(
                process_id,
                target_was_foreground,
                fg_before,
                foreground_process_id(),
            )?;
            let observed = wm_get_text(hwnd_addr, process_id)?
                .or_else(|| value_pattern.and_then(|pattern| pattern.get_value().ok()));
            verify_set_value_readback(&value, observed.as_deref(), "native_window_message")?;
            Ok((
                true,
                json!({
                    "action": "set_value",
                    "value_persisted": true,
                    "transport": "native_window_message",
                }),
            ))
        }
        PlannedAction::NativeButtonClick { hwnd_addr } => {
            native_button_click(hwnd_addr, process_id)?;
            Ok((
                false,
                json!({
                    "action": "invoke",
                    "transport": "native_button_message",
                }),
            ))
        }
        PlannedAction::NativeListBoxSelect {
            parent_hwnd_addr,
            index,
        } => {
            let observed_index = lb_set_cur_sel(parent_hwnd_addr, process_id, index)?;
            verify_select_readback(index, observed_index)?;
            Ok((
                true,
                json!({
                    "action": "select",
                    "selected": true,
                    "transport": "native_listbox_message",
                }),
            ))
        }
        PlannedAction::UiaValuePattern {
            value,
            background_unfocused,
        } => execute_uia_value_pattern(element, value_pattern, &value, background_unfocused),
        PlannedAction::UiaInvokePattern {
            background_unfocused,
        } => execute_uia_invoke_pattern(element, background_unfocused),
        PlannedAction::UiaSelectionItemPattern {
            background_unfocused,
        } => execute_uia_select_pattern(element, background_unfocused),
        PlannedAction::UiaTogglePattern => execute_toggle(element),
        PlannedAction::UiaExpandPattern => execute_expand(element),
        PlannedAction::UiaCollapsePattern => execute_collapse(element),
    }
}

fn execute_uia_value_pattern(
    element: &UIElement,
    value_pattern: Option<&UIValuePattern>,
    value: &str,
    background_unfocused: bool,
) -> Result<(bool, serde_json::Value), CapabilityError> {
    let pattern = value_pattern
        .ok_or_else(|| action_unverified("UI Automation ValuePattern is unavailable"))?;
    if !background_unfocused && !element.has_keyboard_focus().unwrap_or(false) {
        return Err(action_unverified(
            "background-safe value mutation aborted because control lost focus",
        ));
    }
    pattern
        .set_value(value)
        .map_err(|error| uia_action_error(&error))?;
    let transport = if background_unfocused {
        "uia_value_pattern_background"
    } else {
        "uia_value_pattern_already_focused"
    };
    let observed = pattern.get_value().ok();
    verify_set_value_readback(value, observed.as_deref(), transport)?;
    Ok((
        true,
        json!({
            "action": "set_value",
            "value_persisted": true,
            "transport": transport,
        }),
    ))
}

fn execute_uia_invoke_pattern(
    element: &UIElement,
    background_unfocused: bool,
) -> Result<(bool, serde_json::Value), CapabilityError> {
    let pattern = element
        .get_pattern::<UIInvokePattern>()
        .map_err(|error| uia_action_error(&error))?;
    if !background_unfocused && !element.has_keyboard_focus().unwrap_or(false) {
        return Err(action_unverified(
            "background-safe invoke aborted because control lost focus",
        ));
    }
    pattern.invoke().map_err(|error| uia_action_error(&error))?;
    let transport = if background_unfocused {
        "uia_invoke_pattern_background"
    } else {
        "uia_invoke_pattern_already_focused"
    };
    Ok((
        false,
        json!({
            "action": "invoke",
            "transport": transport,
        }),
    ))
}

fn execute_uia_select_pattern(
    element: &UIElement,
    background_unfocused: bool,
) -> Result<(bool, serde_json::Value), CapabilityError> {
    let pattern = element
        .get_pattern::<UISelectionItemPattern>()
        .map_err(|error| uia_action_error(&error))?;
    if !background_unfocused && !element.has_keyboard_focus().unwrap_or(false) {
        return Err(action_unverified(
            "background-safe selection aborted because control lost focus",
        ));
    }
    pattern.select().map_err(|error| uia_action_error(&error))?;
    if !pattern.is_selected().unwrap_or(false) {
        return Err(action_unverified(
            "desktop UIA selection could not be verified by post-action readback",
        ));
    }
    let transport = if background_unfocused {
        "uia_selection_pattern_background"
    } else {
        "uia_selection_pattern_already_focused"
    };
    Ok((
        true,
        json!({
            "action": "select",
            "selected": true,
            "transport": transport,
        }),
    ))
}

fn wm_set_text(hwnd_addr: usize, expected_pid: u32, value: &str) -> Result<(), CapabilityError> {
    with_verified_pid_hwnd(hwnd_addr, expected_pid, |hwnd| {
        let utf16: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        let lparam = LPARAM::from_ne_bytes(utf16.as_ptr().expose_provenance().to_ne_bytes());
        let result = send_message(
            hwnd.ptr(),
            WM_SETTEXT,
            0,
            lparam,
            Some(NATIVE_MESSAGE_TIMEOUT_MS),
        )
        .map_err(|error| {
            action_unverified(format!(
                "background-safe native value mutation failed: {error}"
            ))
        })?;
        drop(utf16);
        if result == 0 {
            return Err(action_unverified(
                "background-safe native value mutation was rejected by window",
            ));
        }
        Ok(())
    })
}

fn wm_get_text(hwnd_addr: usize, expected_pid: u32) -> Result<Option<String>, CapabilityError> {
    with_verified_pid_hwnd(hwnd_addr, expected_pid, |hwnd| {
        let len_result = send_message(
            hwnd.ptr(),
            WM_GETTEXTLENGTH,
            0,
            0,
            Some(NATIVE_MESSAGE_TIMEOUT_MS),
        )
        .map_err(|error| {
            action_unverified(format!(
                "background-safe native text length query failed: {error}"
            ))
        })?;
        let Ok(len) = usize::try_from(len_result) else {
            return Ok(None);
        };
        if len == 0 {
            return Ok(Some(String::new()));
        }
        if len > MAX_NATIVE_READBACK_CHARS {
            return Err(action_unverified(format!(
                "native control text length {len} exceeds readback bound {MAX_NATIVE_READBACK_CHARS}"
            )));
        }
        let buf_len: WPARAM = len + 1;
        let mut buffer = vec![0_u16; buf_len];
        let lparam = LPARAM::from_ne_bytes(buffer.as_mut_ptr().expose_provenance().to_ne_bytes());
        let copied_result = send_message(
            hwnd.ptr(),
            WM_GETTEXT,
            buf_len,
            lparam,
            Some(NATIVE_MESSAGE_TIMEOUT_MS),
        )
        .map_err(|error| {
            action_unverified(format!(
                "background-safe native text readback failed: {error}"
            ))
        })?;
        let Ok(copied) = usize::try_from(copied_result) else {
            return Ok(None);
        };
        let valid_len = copied.min(len);
        Ok(String::from_utf16(&buffer[..valid_len]).ok())
    })
}

fn native_button_click(hwnd_addr: usize, expected_pid: u32) -> Result<(), CapabilityError> {
    with_verified_pid_hwnd(hwnd_addr, expected_pid, |hwnd| {
        send_push_button(hwnd.ptr(), Some(NATIVE_MESSAGE_TIMEOUT_MS)).map_err(|error| {
            action_unverified(format!("background-safe native invoke failed: {error}"))
        })?;
        Ok(())
    })
}

fn lb_get_count(hwnd_addr: usize, expected_pid: u32) -> Option<usize> {
    with_verified_pid_hwnd(hwnd_addr, expected_pid, |hwnd| {
        let count_res = send_message(
            hwnd.ptr(),
            LB_GETCOUNT,
            0,
            0,
            Some(NATIVE_MESSAGE_TIMEOUT_MS),
        )
        .map_err(|error| {
            action_unverified(format!(
                "background-safe native list count query failed: {error}"
            ))
        })?;
        Ok(usize::try_from(count_res).ok())
    })
    .ok()
    .flatten()
}

fn lb_set_cur_sel(
    hwnd_addr: usize,
    expected_pid: u32,
    index: usize,
) -> Result<LRESULT, CapabilityError> {
    with_verified_pid_hwnd(hwnd_addr, expected_pid, |hwnd| {
        let selected_before = send_message(
            hwnd.ptr(),
            LB_GETCURSEL,
            0,
            0,
            Some(NATIVE_MESSAGE_TIMEOUT_MS),
        )
        .map_err(|error| action_unverified(format!("native selection pre-read failed: {error}")))?;
        let result = send_message(
            hwnd.ptr(),
            LB_SETCURSEL,
            index,
            0,
            Some(NATIVE_MESSAGE_TIMEOUT_MS),
        )
        .map_err(|error| {
            action_unverified(format!("background-safe native selection failed: {error}"))
        })?;
        if result == LB_ERR {
            return Err(action_unverified(
                "background-safe native selection was rejected by the list control",
            ));
        }
        let selected_after = send_message(
            hwnd.ptr(),
            LB_GETCURSEL,
            0,
            0,
            Some(NATIVE_MESSAGE_TIMEOUT_MS),
        )
        .map_err(|error| action_unverified(format!("native selection readback failed: {error}")))?;
        verify_select_readback(index, selected_after)?;

        // LB_SETCURSEL changes the native index but deliberately does NOT
        // dispatch LBN_SELCHANGE. WinForms therefore retains the old managed
        // SelectedItem unless its parent receives WM_COMMAND. Notify only
        // for a changed single-select ListBox with LBS_NOTIFY, and only its
        // same-process parent. No physical focus, cursor or clipboard input.
        let (_, pid) = hwnd.GetWindowThreadProcessId();
        let style_bytes = hwnd.GetWindowLongPtr(co::GWLP::STYLE).to_le_bytes();
        let style = u32::from_le_bytes(
            style_bytes[..4]
                .try_into()
                .map_err(|_| action_unverified("invalid native ListBox style bytes"))?,
        );
        if selected_before != selected_after && (style & LBS_NOTIFY) != 0 {
            let parent = hwnd.GetParent().map_err(|error| {
                action_unverified(format!("native ListBox parent unavailable: {error}"))
            })?;
            let (_, parent_pid) = parent.GetWindowThreadProcessId();
            if pid != expected_pid || parent_pid != expected_pid || !parent.IsWindow() {
                return Err(action_unverified(
                    "native ListBox parent is not a valid same-process window",
                ));
            }
            let control_id = hwnd.GetDlgCtrlID().map_err(|error| {
                action_unverified(format!("native ListBox control ID unavailable: {error}"))
            })?;
            let command = usize::from(control_id) | (LBN_SELCHANGE << 16);
            let list_hwnd_lparam =
                LPARAM::from_ne_bytes(hwnd.ptr().expose_provenance().to_ne_bytes());
            send_message(
                parent.ptr(),
                WM_COMMAND,
                command,
                list_hwnd_lparam,
                Some(NATIVE_MESSAGE_TIMEOUT_MS),
            )
            .map_err(|error| {
                action_unverified(format!(
                    "native ListBox selection notification failed: {error}"
                ))
            })?;
            let final_index = send_message(
                hwnd.ptr(),
                LB_GETCURSEL,
                0,
                0,
                Some(NATIVE_MESSAGE_TIMEOUT_MS),
            )
            .map_err(|error| {
                action_unverified(format!(
                    "native selection post-notification read failed: {error}"
                ))
            })?;
            verify_select_readback(index, final_index)?;
            return Ok(final_index);
        }
        Ok(selected_after)
    })
}

fn execute_toggle(element: &UIElement) -> Result<(bool, serde_json::Value), CapabilityError> {
    let pattern = element
        .get_pattern::<UITogglePattern>()
        .map_err(|error| uia_action_error(&error))?;
    let prior = pattern.get_toggle_state().ok();
    pattern.toggle().map_err(|error| uia_action_error(&error))?;
    let current = pattern.get_toggle_state().ok();
    let changed = prior.is_some() && current.is_some() && prior != current;
    Ok((
        changed,
        json!({
            "action": "toggle",
            "state_changed": changed,
        }),
    ))
}

fn execute_expand(element: &UIElement) -> Result<(bool, serde_json::Value), CapabilityError> {
    let pattern = element
        .get_pattern::<UIExpandCollapsePattern>()
        .map_err(|error| uia_action_error(&error))?;
    pattern.expand().map_err(|error| uia_action_error(&error))?;
    let state = pattern.get_state().ok();
    let expanded = matches!(
        state,
        Some(ExpandCollapseState::Expanded | ExpandCollapseState::PartiallyExpanded)
    );
    Ok((
        expanded,
        json!({
            "action": "expand",
            "expanded": expanded,
        }),
    ))
}

fn execute_collapse(element: &UIElement) -> Result<(bool, serde_json::Value), CapabilityError> {
    let pattern = element
        .get_pattern::<UIExpandCollapsePattern>()
        .map_err(|error| uia_action_error(&error))?;
    pattern
        .collapse()
        .map_err(|error| uia_action_error(&error))?;
    let state = pattern.get_state().ok();
    let collapsed = matches!(state, Some(ExpandCollapseState::Collapsed));
    Ok((
        collapsed,
        json!({
            "action": "collapse",
            "collapsed": collapsed,
        }),
    ))
}

pub struct WindowsUiaBackend {
    requests: Mutex<Sender<WorkerRequest>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl WindowsUiaBackend {
    /// Starts a dedicated Windows UI Automation worker thread.
    ///
    /// # Errors
    ///
    /// Returns a provider error if UI Automation cannot initialize on the worker thread.
    pub fn new() -> Result<Self, CapabilityError> {
        let (request_tx, request_rx) = channel::<WorkerRequest>();
        let (init_tx, init_rx) = channel::<Result<(), CapabilityError>>();

        let worker = thread::Builder::new()
            .name("tetherplane-windows-uia".into())
            .spawn(move || {
                let init_result = {
                    let _guard = UIA_INIT_LOCK
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    WorkerState::new_with_transient_retry()
                };
                match init_result {
                    Ok(mut state) => {
                        let _ = init_tx.send(Ok(()));
                        state.run(&request_rx);
                        let _guard = UIA_INIT_LOCK
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        drop(state);
                    }
                    Err(error) => {
                        let _ = init_tx.send(Err(error));
                    }
                }
            })
            .map_err(|error| {
                provider_failure(format!(
                    "failed to start Windows UI Automation worker: {error}"
                ))
            })?;

        match init_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                requests: Mutex::new(request_tx),
                worker: Some(worker),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(_) => {
                let _ = worker.join();
                Err(provider_failure(
                    "Windows UI Automation worker exited during startup",
                ))
            }
        }
    }

    fn sender(&self) -> std::sync::MutexGuard<'_, Sender<WorkerRequest>> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl DesktopBackend for WindowsUiaBackend {
    fn snapshot(&self) -> Result<Vec<DesktopNode>, CapabilityError> {
        let (response_tx, response_rx) = channel();
        self.sender()
            .send(WorkerRequest::Snapshot(response_tx))
            .map_err(|_| disconnected_worker())?;
        response_rx.recv().map_err(|_| disconnected_worker())?
    }

    fn target(&self, reference: &str) -> Result<DesktopNode, CapabilityError> {
        let (response_tx, response_rx) = channel();
        self.sender()
            .send(WorkerRequest::Target {
                reference: reference.to_owned(),
                response: response_tx,
            })
            .map_err(|_| disconnected_worker())?;
        response_rx.recv().map_err(|_| disconnected_worker())?
    }

    fn perform(&self, action: DesktopAction) -> Result<DesktopActionOutcome, CapabilityError> {
        let (response_tx, response_rx) = channel();
        self.sender()
            .send(WorkerRequest::Perform {
                action,
                response: response_tx,
            })
            .map_err(|_| disconnected_worker())?;
        response_rx.recv().map_err(|_| disconnected_worker())?
    }
}

impl Drop for WindowsUiaBackend {
    fn drop(&mut self) {
        {
            let sender = self
                .requests
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let _ = sender.send(WorkerRequest::Shutdown);
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn uia_provider_error(error: &uiautomation::Error) -> CapabilityError {
    provider_failure(format!("Windows UI Automation provider error: {error}"))
}

fn uia_action_error(error: &uiautomation::Error) -> CapabilityError {
    action_unverified(format!(
        "Windows UI Automation semantic action failed: {error}"
    ))
}

fn action_unverified(message: impl Into<String>) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ActionUnverified,
        message: message.into(),
        recovery_hint: Some("take a fresh desktop snapshot and retry semantically".into()),
        details: serde_json::json!({}),
    }
}

fn stale_reference(reference: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::StaleReference,
        message: "desktop semantic reference is stale or unavailable".into(),
        recovery_hint: Some("take a new desktop snapshot".into()),
        details: json!({ "reference": reference }),
    }
}

fn disconnected_worker() -> CapabilityError {
    CapabilityError {
        code: ErrorCode::Disconnected,
        message: "Windows UI Automation worker is disconnected".into(),
        recovery_hint: Some("restart the local Tetherplane agent".into()),
        details: serde_json::json!({}),
    }
}

fn provider_failure(message: impl Into<String>) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ProviderFailure,
        message: message.into(),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}
