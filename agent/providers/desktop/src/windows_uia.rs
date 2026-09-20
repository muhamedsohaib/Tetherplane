use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread;

use serde_json::json;
use tether_core::{CapabilityError, ErrorCode};
use uiautomation::patterns::{
    UIExpandCollapsePattern, UIInvokePattern, UISelectionItemPattern, UITogglePattern,
    UIValuePattern,
};
use uiautomation::types::ExpandCollapseState;
use uiautomation::{UIAutomation, UIElement, UITreeWalker};

use crate::{
    DesktopAction, DesktopActionKind, DesktopActionOutcome, DesktopBackend, DesktopNode,
    DesktopPattern, DesktopRect,
};

const MAX_WINDOWS_SNAPSHOT_NODES: usize = 1_001;
const MAX_WINDOWS_SNAPSHOT_DEPTH: usize = 8;

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
struct ElementIdentity {
    process_id: u32,
    parent_reference: Option<String>,
    automation_id: String,
    class_name: String,
    name: String,
    role: String,
}

struct CachedElement {
    element: UIElement,
    node: DesktopNode,
}

struct WorkerState {
    automation: UIAutomation,
    walker: UITreeWalker,
    references: HashMap<String, CachedElement>,
    stable_references: BTreeMap<ElementIdentity, String>,
    next_reference: u64,
}

impl WorkerState {
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
        self.references.clear();

        let mut nodes = Vec::new();
        if let Ok(first) = walker.get_first_child(&root) {
            self.walk_siblings(&walker, first, None, 0, &mut nodes);
        }
        Ok(nodes)
    }

    fn walk_siblings(
        &mut self,
        walker: &UITreeWalker,
        mut current: UIElement,
        parent_reference: Option<&str>,
        depth: usize,
        nodes: &mut Vec<DesktopNode>,
    ) {
        loop {
            if nodes.len() >= MAX_WINDOWS_SNAPSHOT_NODES {
                return;
            }

            let described = self.describe_element(&current, parent_reference);
            let current_reference = described.as_ref().map(|node| node.reference.clone());
            if let Some(node) = described {
                nodes.push(node);
            }

            if depth < MAX_WINDOWS_SNAPSHOT_DEPTH
                && nodes.len() < MAX_WINDOWS_SNAPSHOT_NODES
                && let Ok(child) = walker.get_first_child(&current)
            {
                self.walk_siblings(
                    walker,
                    child,
                    current_reference.as_deref(),
                    depth + 1,
                    nodes,
                );
            }

            if nodes.len() >= MAX_WINDOWS_SNAPSHOT_NODES {
                return;
            }

            match walker.get_next_sibling(&current) {
                Ok(next) => current = next,
                Err(_) => return,
            }
        }
    }

    fn describe_element(
        &mut self,
        element: &UIElement,
        parent_reference: Option<&str>,
    ) -> Option<DesktopNode> {
        let process_id = element.get_process_id().ok()?;
        let automation_id = element.get_automation_id().unwrap_or_default();
        let class_name = element.get_classname().unwrap_or_default();
        let name = element.get_name().unwrap_or_default();
        let role = element
            .get_localized_control_type()
            .unwrap_or_else(|_| "unknown".to_owned());

        let identity = ElementIdentity {
            process_id,
            parent_reference: parent_reference.map(str::to_owned),
            automation_id: automation_id.clone(),
            class_name: class_name.clone(),
            name: name.clone(),
            role: role.clone(),
        };
        let reference = if let Some(reference) = self.stable_references.get(&identity) {
            reference.clone()
        } else {
            let reference = self.allocate_reference();
            self.stable_references.insert(identity, reference.clone());
            reference
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
            parent_reference: parent_reference.map(str::to_owned),
            role,
            name,
            automation_id: non_empty(automation_id),
            class_name: non_empty(class_name),
            process_id,
            enabled: element.is_enabled().unwrap_or(false),
            focusable: element.is_keyboard_focusable().unwrap_or(false),
            focused: element.has_keyboard_focus().unwrap_or(false),
            bounding_rectangle,
            patterns: supported_patterns(element),
        };

        self.references.insert(
            reference,
            CachedElement {
                element: element.clone(),
                node: node.clone(),
            },
        );
        Some(node)
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

        element
            .get_process_id()
            .map_err(|_| stale_reference(reference))?;

        let refreshed = self
            .describe_element(&element, parent_reference.as_deref())
            .ok_or_else(|| stale_reference(reference))?;

        if refreshed.reference != reference {
            return Err(stale_reference(reference));
        }
        Ok(refreshed)
    }

    fn perform(&mut self, action: &DesktopAction) -> Result<DesktopActionOutcome, CapabilityError> {
        let before = self.target(&action.reference)?;
        let element = self
            .references
            .get(&action.reference)
            .ok_or_else(|| stale_reference(&action.reference))?
            .element
            .clone();

        let (verified, delta) = execute_semantic_action(&element, action)?;

        let target = self.target(&action.reference).unwrap_or(before);
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

fn execute_semantic_action(
    element: &UIElement,
    action: &DesktopAction,
) -> Result<(bool, serde_json::Value), CapabilityError> {
    match action.kind {
        DesktopActionKind::Invoke => execute_invoke(element),
        DesktopActionKind::SetValue => execute_set_value(element, action),
        DesktopActionKind::Select => execute_select(element),
        DesktopActionKind::Toggle => execute_toggle(element),
        DesktopActionKind::Expand => execute_expand(element),
        DesktopActionKind::Collapse => execute_collapse(element),
    }
}

fn execute_invoke(element: &UIElement) -> Result<(bool, serde_json::Value), CapabilityError> {
    let pattern = element
        .get_pattern::<UIInvokePattern>()
        .map_err(|error| uia_action_error(&error))?;

    if try_background_native_invoke(element)? {
        return Ok((
            false,
            json!({
                "action": "invoke",
                "transport": "native_button_message",
            }),
        ));
    }

    if !element.has_keyboard_focus().unwrap_or(false) {
        return Err(CapabilityError {
            code: ErrorCode::ActionUnverified,
            message:
                "background-safe invoke is unavailable for this unfocused control".into(),
            recovery_hint: Some(
                "use a provider-native background invocation path or an explicitly authorized foreground lease"
                    .into(),
            ),
            details: serde_json::json!({}),
        });
    }

    pattern.invoke().map_err(|error| uia_action_error(&error))?;
    Ok((
        false,
        json!({
            "action": "invoke",
            "transport": "uia_invoke_pattern_already_focused",
        }),
    ))
}

fn try_background_native_invoke(element: &UIElement) -> Result<bool, CapabilityError> {
    let role = element.get_localized_control_type().unwrap_or_default();
    if !role.eq_ignore_ascii_case("button") {
        return Ok(false);
    }

    let handle = match element.get_native_window_handle() {
        Ok(handle) => handle,
        Err(_) => return Ok(false),
    };
    let raw: isize = handle.into();
    if raw == 0 {
        return Ok(false);
    }

    let hwnd = raw as windows_win::sys::HWND;
    windows_win::raw::window::send_push_button(hwnd, Some(1_000)).map_err(|error| {
        CapabilityError {
            code: ErrorCode::ActionUnverified,
            message: format!("background-safe native invoke failed: {error}"),
            recovery_hint: Some("take a fresh desktop snapshot and retry semantically".into()),
            details: serde_json::json!({}),
        }
    })?;
    Ok(true)
}

fn execute_set_value(
    element: &UIElement,
    action: &DesktopAction,
) -> Result<(bool, serde_json::Value), CapabilityError> {
    let value = action
        .value
        .as_deref()
        .ok_or_else(|| invalid_arguments("set_value requires value"))?;
    let pattern = element
        .get_pattern::<UIValuePattern>()
        .map_err(|error| uia_action_error(&error))?;

    if pattern.is_readonly().unwrap_or(false) {
        return Err(CapabilityError {
            code: ErrorCode::PermissionDenied,
            message: "desktop value target is read-only".into(),
            recovery_hint: None,
            details: serde_json::json!({}),
        });
    }

    if try_background_native_set_value(element, value)? {
        let persisted = pattern.get_value().is_ok_and(|current| current == value);
        return Ok((
            persisted,
            json!({
                "action": "set_value",
                "value_persisted": persisted,
                "transport": "native_window_message",
            }),
        ));
    }

    if !element.has_keyboard_focus().unwrap_or(false) {
        return Err(CapabilityError {
            code: ErrorCode::ActionUnverified,
            message:
                "background-safe value mutation is unavailable for this unfocused control".into(),
            recovery_hint: Some(
                "use a provider-native background mutation path or an explicitly authorized foreground lease"
                    .into(),
            ),
            details: serde_json::json!({}),
        });
    }

    pattern
        .set_value(value)
        .map_err(|error| uia_action_error(&error))?;
    let persisted = pattern.get_value().is_ok_and(|current| current == value);
    Ok((
        persisted,
        json!({
            "action": "set_value",
            "value_persisted": persisted,
            "transport": "uia_value_pattern_already_focused",
        }),
    ))
}

fn try_background_native_set_value(
    element: &UIElement,
    value: &str,
) -> Result<bool, CapabilityError> {
    let handle = match element.get_native_window_handle() {
        Ok(handle) => handle,
        Err(_) => return Ok(false),
    };
    let raw: isize = handle.into();
    if raw == 0 {
        return Ok(false);
    }

    let hwnd = raw as windows_win::sys::HWND;
    if windows_win::raw::window::send_set_text(hwnd, value) {
        Ok(true)
    } else {
        Err(CapabilityError {
            code: ErrorCode::ActionUnverified,
            message: "background-safe native value mutation failed".into(),
            recovery_hint: Some("take a fresh desktop snapshot and retry semantically".into()),
            details: serde_json::json!({}),
        })
    }
}

fn execute_select(element: &UIElement) -> Result<(bool, serde_json::Value), CapabilityError> {
    let pattern = element
        .get_pattern::<UISelectionItemPattern>()
        .map_err(|error| uia_action_error(&error))?;
    pattern.select().map_err(|error| uia_action_error(&error))?;
    let selected = pattern.is_selected().unwrap_or(false);
    Ok((
        selected,
        json!({
            "action": "select",
            "selected": selected,
        }),
    ))
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

        thread::Builder::new()
            .name("tetherplane-windows-uia".into())
            .spawn(move || match WorkerState::new() {
                Ok(mut state) => {
                    let _ = init_tx.send(Ok(()));
                    state.run(&request_rx);
                }
                Err(error) => {
                    let _ = init_tx.send(Err(error));
                }
            })
            .map_err(|error| {
                provider_failure(format!(
                    "failed to start Windows UI Automation worker: {error}"
                ))
            })?;

        init_rx.recv().map_err(|_| {
            provider_failure("Windows UI Automation worker exited during startup")
        })??;

        Ok(Self {
            requests: Mutex::new(request_tx),
        })
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
        if let Ok(sender) = self.requests.lock() {
            let _ = sender.send(WorkerRequest::Shutdown);
        }
    }
}

fn supported_patterns(element: &UIElement) -> Vec<DesktopPattern> {
    let mut patterns = Vec::with_capacity(5);
    if element.get_pattern::<UIInvokePattern>().is_ok() {
        patterns.push(DesktopPattern::Invoke);
    }
    if element.get_pattern::<UIValuePattern>().is_ok() {
        patterns.push(DesktopPattern::Value);
    }
    if element.get_pattern::<UISelectionItemPattern>().is_ok() {
        patterns.push(DesktopPattern::Selection);
    }
    if element.get_pattern::<UITogglePattern>().is_ok() {
        patterns.push(DesktopPattern::Toggle);
    }
    if element.get_pattern::<UIExpandCollapsePattern>().is_ok() {
        patterns.push(DesktopPattern::ExpandCollapse);
    }
    patterns
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn uia_provider_error(error: &uiautomation::Error) -> CapabilityError {
    provider_failure(format!("Windows UI Automation provider error: {error}"))
}

fn uia_action_error(error: &uiautomation::Error) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ActionUnverified,
        message: format!("Windows UI Automation semantic action failed: {error}"),
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

fn invalid_arguments(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
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
