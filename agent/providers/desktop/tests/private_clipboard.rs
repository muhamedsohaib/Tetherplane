use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tether_core::{
    Actor, ActorKind, CapabilityError, CapabilityProvider, ErrorCode, InvocationEnvelope,
    ResourceKey, ResourceOrigin, ResponseMode, TrustedOwnershipRegistry,
};
use tether_desktop_provider::{
    DesktopAction, DesktopActionOutcome, DesktopBackend, DesktopNode, DesktopPattern,
    DesktopProvider, PrivateClipboard,
};

#[derive(Default)]
struct ClipboardBackend {
    action: Mutex<Option<DesktopAction>>,
}

impl DesktopBackend for ClipboardBackend {
    fn snapshot(&self) -> Result<Vec<DesktopNode>, CapabilityError> {
        Ok(vec![])
    }

    fn target(&self, reference: &str) -> Result<DesktopNode, CapabilityError> {
        Ok(DesktopNode {
            reference: reference.into(),
            parent_reference: None,
            role: "edit".into(),
            name: "Owned editor".into(),
            automation_id: Some("editor".into()),
            class_name: Some("Edit".into()),
            process_id: 700,
            enabled: true,
            focusable: true,
            focused: false,
            bounding_rectangle: None,
            patterns: vec![DesktopPattern::Value],
        })
    }

    fn perform(&self, action: DesktopAction) -> Result<DesktopActionOutcome, CapabilityError> {
        *self
            .action
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(action.clone());
        Ok(DesktopActionOutcome {
            target: self.target(&action.reference)?,
            verified: true,
            delta: json!({ "changed": true }),
        })
    }
}

fn invocation(capability: &str, arguments: Value) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: "00000000-0000-4000-8000-00000000e005".parse().unwrap(),
        device_id: Some("Leno".into()),
        principal_id: Some("model:test".into()),
        job_id: None,
        capability: capability.into(),
        arguments,
        actor: Actor {
            id: "clipboard-test".into(),
            kind: ActorKind::AiClient,
        },
        session_id: None,
        response_mode: ResponseMode::Compact,
        idempotency_key: None,
        preconditions: vec![],
        expectations: vec![],
    }
}

#[test]
fn private_clipboard_is_revisioned_and_bounded_without_os_clipboard_state() {
    let clipboard = PrivateClipboard::new();

    let first = clipboard
        .set(Some("hello".into()), vec!["C:\\tmp\\one.txt".into()])
        .unwrap();
    assert_eq!(first.revision, 1);
    assert_eq!(first.text.as_deref(), Some("hello"));
    assert_eq!(first.files, vec!["C:\\tmp\\one.txt"]);

    let current = clipboard.get();
    assert_eq!(current, first);

    let too_large = "x".repeat(1_048_577);
    let error = clipboard.set(Some(too_large), vec![]).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArguments);
}

#[tokio::test]
async fn provider_private_clipboard_set_and_get_never_touch_backend() {
    let ownership = Arc::new(TrustedOwnershipRegistry::new());
    let backend = Arc::new(ClipboardBackend::default());
    let clipboard = Arc::new(PrivateClipboard::new());
    let provider =
        DesktopProvider::with_clipboard(Arc::clone(&backend), ownership, Arc::clone(&clipboard));

    let set = provider
        .execute(&invocation(
            "desktop.private_clipboard_set",
            json!({
                "text": "private text",
                "files": ["C:\\tmp\\artifact.txt"]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(set.data["revision"], 1);

    let get = provider
        .execute(&invocation("desktop.private_clipboard_get", json!({})))
        .await
        .unwrap();
    assert_eq!(get.data["text"], "private text");
    assert_eq!(get.data["files"][0], "C:\\tmp\\artifact.txt");
    assert!(
        backend
            .action
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_none()
    );
}

#[tokio::test]
async fn set_value_can_explicitly_consume_private_clipboard_text_semantically() {
    let ownership = Arc::new(TrustedOwnershipRegistry::new());
    ownership.register(ResourceKey::Process(700), ResourceOrigin::Tetherplane);
    let backend = Arc::new(ClipboardBackend::default());
    let clipboard = Arc::new(PrivateClipboard::new());
    clipboard
        .set(Some("clipboard-to-value".into()), vec![])
        .unwrap();
    let provider = DesktopProvider::with_clipboard(Arc::clone(&backend), ownership, clipboard);

    provider
        .execute(&invocation(
            "desktop.act",
            json!({
                "reference": "owned_edit",
                "action": "set_value",
                "from_private_clipboard": true
            }),
        ))
        .await
        .unwrap();

    let performed = backend
        .action
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .unwrap();
    assert_eq!(performed.value.as_deref(), Some("clipboard-to-value"));
}

#[test]
fn private_clipboard_source_has_no_global_clipboard_calls() {
    let source = include_str!("../src/private_clipboard.rs");
    for forbidden in [
        "OpenClipboard",
        "SetClipboardData",
        "GetClipboardData",
        "uiautomation::clipboards",
        "Clipboard::",
    ] {
        assert!(
            !source.contains(forbidden),
            "private clipboard must not use global clipboard primitive: {forbidden}"
        );
    }
}
