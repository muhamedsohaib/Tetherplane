#![cfg(windows)]

use tether_desktop_provider::{DesktopBackend, WindowsUiaBackend};

#[test]
fn windows_uia_worker_starts_and_returns_a_bounded_semantic_snapshot() {
    let backend = WindowsUiaBackend::new().expect("Windows UI Automation worker should initialize");
    let nodes = backend
        .snapshot()
        .expect("Windows UI Automation snapshot should succeed");

    assert!(nodes.len() <= 1_001);
    assert!(nodes.iter().all(|node| node.reference.starts_with("desk_")));
    assert!(nodes.iter().all(|node| !node.role.is_empty()));
}

#[test]
fn semantic_windows_backend_contains_no_physical_input_or_global_clipboard_calls() {
    let source = include_str!("../src/windows_uia.rs");

    for forbidden in [
        "uiautomation::inputs",
        "uiautomation::clipboards",
        ".send_keys(",
        ".send_text(",
        ".set_focus(",
        "Keyboard::",
        "Mouse::",
        "Clipboard::",
    ] {
        assert!(
            !source.contains(forbidden),
            "semantic Windows backend must not contain physical/global input primitive: {forbidden}"
        );
    }
}

#[test]
fn windows_uia_concurrent_worker_initializations_and_reinit_succeed() {
    use std::sync::{Arc, Barrier};
    use std::thread;

    const THREAD_COUNT: usize = 4;
    let barrier = Arc::new(Barrier::new(THREAD_COUNT));
    let mut handles = Vec::with_capacity(THREAD_COUNT);

    for _ in 0..THREAD_COUNT {
        let gate = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            gate.wait();
            let backend = WindowsUiaBackend::new()
                .expect("concurrent Windows UI Automation worker should initialize");
            let nodes = backend
                .snapshot()
                .expect("concurrent Windows UI Automation snapshot should succeed");
            assert!(nodes.len() <= 1_001);
        }));
    }

    for handle in handles {
        handle
            .join()
            .expect("concurrent UIA initialization worker thread must not panic");
    }

    let reinitialized =
        WindowsUiaBackend::new().expect("sequential UIA reinitialization after drop should work");
    let nodes = reinitialized
        .snapshot()
        .expect("reinitialized UIA snapshot should succeed");
    assert!(nodes.len() <= 1_001);
}
