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
    for (name, source) in [
        ("windows_uia.rs", include_str!("../src/windows_uia.rs")),
        (
            "windows_compat.rs",
            include_str!("../src/windows_compat.rs"),
        ),
    ] {
        for forbidden in [
            "uiautomation::inputs",
            "uiautomation::clipboards",
            ".send_keys(",
            ".send_text(",
            ".set_focus(",
            "Keyboard::",
            "Mouse::",
            "Clipboard::",
            "send_set_text(",
            "send_get_text(",
            "send_sys_command(",
            "SendInput",
            "SetForegroundWindow",
            "AttachThreadInput",
            "OpenClipboard",
            "SetClipboardData",
        ] {
            assert!(
                !source.contains(forbidden),
                "{name} must not contain physical/global input or unbounded message primitive: {forbidden}"
            );
        }
        let compact: String = source.chars().filter(|c| !c.is_whitespace()).collect();
        for callee in ["send_message(", "send_push_button("] {
            let mut rest = compact.as_str();
            while let Some(pos) = rest.find(callee) {
                let after = &rest[pos + callee.len()..];
                let mut depth = 1_usize;
                let mut end = None;
                for (idx, ch) in after.char_indices() {
                    match ch {
                        '(' => depth += 1,
                        ')' => {
                            depth -= 1;
                            if depth == 0 {
                                end = Some(idx);
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                let args = &after[..end.expect("balanced send call parentheses")];
                assert!(
                    args.trim_end_matches(',')
                        .ends_with(",Some(NATIVE_MESSAGE_TIMEOUT_MS)"),
                    "{name} call to {callee} must pass explicit bounded timeout: {args}"
                );
                rest = &after[end.unwrap() + 1..];
            }
        }
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
