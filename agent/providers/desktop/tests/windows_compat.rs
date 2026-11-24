use tether_core::ErrorCode;
use tether_desktop_provider::windows_compat::{
    BS_AUTOCHECKBOX, BS_AUTORADIOBUTTON, BS_CHECKBOX, BS_DEFPUSHBUTTON, BS_GROUPBOX, BS_OWNERDRAW,
    BS_PUSHBUTTON, BS_RADIOBUTTON, BS_SPLITBUTTON, ES_READONLY, ElementCompatInput,
    LBS_EXTENDEDSEL, LBS_MULTIPLESEL, LBS_NOSEL, MAX_NATIVE_TEXT_CHARS, MSAA_ROLE_CHECKBUTTON,
    MSAA_ROLE_GROUPING, MSAA_ROLE_LISTITEM, MSAA_ROLE_PUSHBUTTON, MSAA_ROLE_RADIOBUTTON,
    MSAA_STATE_READONLY, MSAA_STATE_UNAVAILABLE, NativeHwndMeta, NativeListParentMeta,
    NativeWindowKind, PlannedAction, SemanticControlType, WS_DISABLED, check_focus_preserved,
    check_semantic_dispatch_precondition, classify_native_window_class, finish_semantic_dispatch,
    infer_supported_patterns, is_background_safe_uia_framework, plan_action, verify_select_readback,
    verify_set_value_readback,
};
use tether_desktop_provider::{DesktopAction, DesktopActionKind, DesktopPattern};

fn base_input(process_id: u32) -> ElementCompatInput {
    ElementCompatInput {
        process_id,
        framework_id: "WinForm".into(),
        control_type: SemanticControlType::Pane,
        enabled: true,
        focused: false,
        is_password: false,
        has_invoke_pattern: false,
        has_value_pattern: false,
        value_is_readonly: None,
        has_selection_item_pattern: false,
        has_toggle_pattern: false,
        has_expand_collapse_pattern: false,
        legacy_role: None,
        legacy_state: None,
        native_hwnd: None,
        list_parent: None,
    }
}

fn hwnd(process_id: u32, class_name: &str, style: u32) -> NativeHwndMeta {
    NativeHwndMeta {
        addr: 0x1234_5678,
        process_id,
        class_name: class_name.into(),
        style,
        valid_window: true,
        window_enabled: true,
    }
}

#[test]
fn sandbox_winforms_patternless_edit_exposed_as_pane_infers_value_and_plans_native_write() {
    let mut input = base_input(4242);
    input.control_type = SemanticControlType::Pane;
    input.native_hwnd = Some(hwnd(4242, "WindowsForms10.EDIT.app.0.141b42a_r7_ad1", 0));

    assert_eq!(
        infer_supported_patterns(&input),
        vec![DesktopPattern::Value]
    );

    let plan = plan_action(
        &input,
        &DesktopAction {
            reference: "desk_0001".into(),
            kind: DesktopActionKind::SetValue,
            value: Some("sandbox-ok".into()),
        },
    )
    .expect("verified WinForms EDIT exposed as Pane must plan native WM_SETTEXT");

    assert_eq!(
        plan,
        PlannedAction::NativeEditSetText {
            hwnd_addr: 0x1234_5678,
            value: "sandbox-ok".into(),
        }
    );
}

#[test]
fn winforms_edit_with_uia_value_pattern_prefers_background_native_write() {
    let mut input = base_input(4242);
    input.control_type = SemanticControlType::Edit;
    input.has_value_pattern = true;
    input.native_hwnd = Some(hwnd(4242, "WindowsForms10.EDIT.app.0.141b42a_r7_ad1", 0));

    assert_eq!(
        infer_supported_patterns(&input),
        vec![DesktopPattern::Value]
    );

    let plan = plan_action(
        &input,
        &DesktopAction {
            reference: "desk_0001".into(),
            kind: DesktopActionKind::SetValue,
            value: Some("hello".into()),
        },
    )
    .expect("native path should be chosen first when verified HWND exists");

    assert_eq!(
        plan,
        PlannedAction::NativeEditSetText {
            hwnd_addr: 0x1234_5678,
            value: "hello".into(),
        }
    );
}

#[test]
fn sandbox_winforms_patternless_pushbuttons_infer_invoke_even_with_ownerdraw() {
    for style in [
        BS_PUSHBUTTON,
        BS_DEFPUSHBUTTON,
        BS_OWNERDRAW,
        BS_SPLITBUTTON,
    ] {
        let mut input = base_input(4242);
        input.control_type = SemanticControlType::Pane;
        input.legacy_role = Some(MSAA_ROLE_PUSHBUTTON);
        input.native_hwnd = Some(hwnd(
            4242,
            "WindowsForms10.BUTTON.app.0.141b42a_r7_ad1",
            style,
        ));

        assert_eq!(
            infer_supported_patterns(&input),
            vec![DesktopPattern::Invoke],
            "style {style:#x} should infer Invoke"
        );

        let plan = plan_action(
            &input,
            &DesktopAction {
                reference: "desk_0002".into(),
                kind: DesktopActionKind::Invoke,
                value: None,
            },
        )
        .expect("verified WinForms button exposed as Pane should plan BM_CLICK");

        assert_eq!(
            plan,
            PlannedAction::NativeButtonClick {
                hwnd_addr: 0x1234_5678,
            }
        );
    }
}

#[test]
fn checkbox_radiobutton_and_groupbox_never_promote_to_native_pushbutton_invoke() {
    let disallowed = [
        (SemanticControlType::CheckBox, BS_CHECKBOX, None),
        (
            SemanticControlType::CheckBox,
            BS_AUTOCHECKBOX,
            Some(MSAA_ROLE_CHECKBUTTON),
        ),
        (SemanticControlType::Pane, BS_AUTOCHECKBOX, None),
        (
            SemanticControlType::Pane,
            BS_OWNERDRAW,
            Some(MSAA_ROLE_CHECKBUTTON),
        ),
        (
            SemanticControlType::RadioButton,
            BS_RADIOBUTTON,
            Some(MSAA_ROLE_RADIOBUTTON),
        ),
        (SemanticControlType::Pane, BS_AUTORADIOBUTTON, None),
        (
            SemanticControlType::Pane,
            BS_OWNERDRAW,
            Some(MSAA_ROLE_RADIOBUTTON),
        ),
        (
            SemanticControlType::Group,
            BS_GROUPBOX,
            Some(MSAA_ROLE_GROUPING),
        ),
        (SemanticControlType::Pane, BS_GROUPBOX, None),
        (
            SemanticControlType::Pane,
            BS_OWNERDRAW,
            Some(MSAA_ROLE_GROUPING),
        ),
    ];

    for (control_type, style, legacy_role) in disallowed {
        let mut input = base_input(4242);
        input.control_type = control_type;
        input.legacy_role = legacy_role;
        input.native_hwnd = Some(hwnd(
            4242,
            "WindowsForms10.BUTTON.app.0.141b42a_r7_ad1",
            style,
        ));

        assert!(
            !infer_supported_patterns(&input).contains(&DesktopPattern::Invoke),
            "non-pushbutton ({control_type:?}, style={style:#x}, role={legacy_role:?}) must not infer Invoke"
        );

        let err = plan_action(
            &input,
            &DesktopAction {
                reference: "desk_0003".into(),
                kind: DesktopActionKind::Invoke,
                value: None,
            },
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::CapabilityUnavailable);
    }

    // Even if a CheckBox exposes TogglePattern, it must not promote to Invoke without UIInvokePattern
    let mut toggled = base_input(4242);
    toggled.control_type = SemanticControlType::Pane;
    toggled.has_toggle_pattern = true;
    toggled.native_hwnd = Some(hwnd(
        4242,
        "WindowsForms10.BUTTON.app.0.141b42a_r7_ad1",
        BS_OWNERDRAW,
    ));
    assert_eq!(
        infer_supported_patterns(&toggled),
        vec![DesktopPattern::Toggle]
    );
}

#[test]
fn generic_panes_forms_labels_and_unknown_classes_fail_closed_without_pseudo_support() {
    for class_name in [
        "WindowsForms10.Window.8.app.0.141b42a_r7_ad1",
        "WindowsForms10.STATIC.app.0.141b42a_r7_ad1",
        "Static",
        "CustomContainerClass",
    ] {
        let mut input = base_input(4242);
        input.control_type = SemanticControlType::Pane;
        input.native_hwnd = Some(hwnd(4242, class_name, 0));

        assert!(
            infer_supported_patterns(&input).is_empty(),
            "class {class_name} must expose zero inferred patterns"
        );

        for (kind, value) in [
            (DesktopActionKind::SetValue, Some("text".to_owned())),
            (DesktopActionKind::Invoke, None),
            (DesktopActionKind::Select, None),
        ] {
            let err = plan_action(
                &input,
                &DesktopAction {
                    reference: "desk_0004".into(),
                    kind,
                    value,
                },
            )
            .unwrap_err();
            assert_eq!(err.code, ErrorCode::CapabilityUnavailable);
        }
    }

    assert_eq!(
        classify_native_window_class("WindowsForms10.Window.8.app.0.141b42a_r7_ad1"),
        NativeWindowKind::ContainerOrStatic
    );
    assert_eq!(
        classify_native_window_class("WindowsForms10.STATIC.app.0.141b42a_r7_ad1"),
        NativeWindowKind::ContainerOrStatic
    );
}

#[test]
fn hwnd_pid_mismatch_is_rejected_for_both_inference_and_native_dispatch() {
    let mut input = base_input(4242);
    input.control_type = SemanticControlType::Pane;
    input.native_hwnd = Some(hwnd(9999, "WindowsForms10.EDIT.app.0.141b42a_r7_ad1", 0));

    assert_eq!(infer_supported_patterns(&input), []);

    let err = plan_action(
        &input,
        &DesktopAction {
            reference: "desk_0005".into(),
            kind: DesktopActionKind::SetValue,
            value: Some("blocked".into()),
        },
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::CapabilityUnavailable);
}

#[test]
fn disabled_and_invalid_windows_fail_closed_with_action_unverified() {
    let mut edit = base_input(4242);
    edit.native_hwnd = Some(hwnd(4242, "WindowsForms10.EDIT.app.0.141b42a_r7_ad1", 0));

    // UIA disabled
    let mut uia_disabled = edit.clone();
    uia_disabled.enabled = false;
    assert_eq!(
        plan_action(
            &uia_disabled,
            &DesktopAction {
                reference: "desk_0006".into(),
                kind: DesktopActionKind::SetValue,
                value: Some("x".into()),
            },
        )
        .unwrap_err()
        .code,
        ErrorCode::ActionUnverified
    );

    // WS_DISABLED on HWND even if UIA claims enabled
    let mut ws_disabled = edit.clone();
    ws_disabled.native_hwnd.as_mut().unwrap().style = WS_DISABLED;
    assert_eq!(
        plan_action(
            &ws_disabled,
            &DesktopAction {
                reference: "desk_0006".into(),
                kind: DesktopActionKind::SetValue,
                value: Some("x".into()),
            },
        )
        .unwrap_err()
        .code,
        ErrorCode::ActionUnverified
    );

    // HWND IsWindowEnabled == false
    let mut win_disabled = edit.clone();
    win_disabled.native_hwnd.as_mut().unwrap().window_enabled = false;
    assert_eq!(
        plan_action(
            &win_disabled,
            &DesktopAction {
                reference: "desk_0006".into(),
                kind: DesktopActionKind::SetValue,
                value: Some("x".into()),
            },
        )
        .unwrap_err()
        .code,
        ErrorCode::ActionUnverified
    );

    // MSAA STATE_SYSTEM_UNAVAILABLE
    let mut msaa_unavail = edit;
    msaa_unavail.legacy_state = Some(MSAA_STATE_UNAVAILABLE);
    assert_eq!(
        plan_action(
            &msaa_unavail,
            &DesktopAction {
                reference: "desk_0006".into(),
                kind: DesktopActionKind::SetValue,
                value: Some("x".into()),
            },
        )
        .unwrap_err()
        .code,
        ErrorCode::ActionUnverified
    );
}

#[test]
fn readonly_edit_rejects_set_value_with_permission_denied_before_dispatch() {
    let mut edit = base_input(4242);
    edit.native_hwnd = Some(hwnd(
        4242,
        "WindowsForms10.EDIT.app.0.141b42a_r7_ad1",
        ES_READONLY,
    ));
    assert_eq!(
        plan_action(
            &edit,
            &DesktopAction {
                reference: "desk_0007".into(),
                kind: DesktopActionKind::SetValue,
                value: Some("blocked".into()),
            },
        )
        .unwrap_err()
        .code,
        ErrorCode::PermissionDenied
    );

    let mut uia_ro = base_input(4242);
    uia_ro.framework_id = "WPF".into();
    uia_ro.control_type = SemanticControlType::Edit;
    uia_ro.has_value_pattern = true;
    uia_ro.value_is_readonly = Some(true);
    assert_eq!(
        plan_action(
            &uia_ro,
            &DesktopAction {
                reference: "desk_0008".into(),
                kind: DesktopActionKind::SetValue,
                value: Some("blocked".into()),
            },
        )
        .unwrap_err()
        .code,
        ErrorCode::PermissionDenied
    );

    let mut msaa_ro = base_input(4242);
    msaa_ro.native_hwnd = Some(hwnd(4242, "WindowsForms10.EDIT.app.0.141b42a_r7_ad1", 0));
    msaa_ro.legacy_state = Some(MSAA_STATE_READONLY);
    assert_eq!(
        plan_action(
            &msaa_ro,
            &DesktopAction {
                reference: "desk_0009".into(),
                kind: DesktopActionKind::SetValue,
                value: Some("blocked".into()),
            },
        )
        .unwrap_err()
        .code,
        ErrorCode::PermissionDenied
    );
}

#[test]
fn native_text_payload_rejects_nul_bytes_and_oversized_strings_but_allows_empty() {
    let mut edit = base_input(4242);
    edit.native_hwnd = Some(hwnd(4242, "WindowsForms10.EDIT.app.0.141b42a_r7_ad1", 0));

    let empty = plan_action(
        &edit,
        &DesktopAction {
            reference: "desk_0010".into(),
            kind: DesktopActionKind::SetValue,
            value: Some(String::new()),
        },
    )
    .expect("empty string clears Edit cleanly");
    assert_eq!(
        empty,
        PlannedAction::NativeEditSetText {
            hwnd_addr: 0x1234_5678,
            value: String::new(),
        }
    );

    let nul_err = plan_action(
        &edit,
        &DesktopAction {
            reference: "desk_0010".into(),
            kind: DesktopActionKind::SetValue,
            value: Some("abc\0def".into()),
        },
    )
    .unwrap_err();
    assert_eq!(nul_err.code, ErrorCode::InvalidArguments);

    let over_err = plan_action(
        &edit,
        &DesktopAction {
            reference: "desk_0010".into(),
            kind: DesktopActionKind::SetValue,
            value: Some("a".repeat(MAX_NATIVE_TEXT_CHARS + 1)),
        },
    )
    .unwrap_err();
    assert_eq!(over_err.code, ErrorCode::InvalidArguments);
}

#[test]
fn native_listbox_select_works_only_for_valid_single_select_child_items() {
    let mut item = base_input(4242);
    item.control_type = SemanticControlType::Pane;
    item.legacy_role = Some(MSAA_ROLE_LISTITEM);
    item.list_parent = Some(NativeListParentMeta {
        hwnd: hwnd(4242, "WindowsForms10.LISTBOX.app.0.141b42a_r7_ad1", 0),
        sibling_index: 1,
        item_count: Some(2),
    });

    assert_eq!(
        infer_supported_patterns(&item),
        vec![DesktopPattern::Selection]
    );
    let plan = plan_action(
        &item,
        &DesktopAction {
            reference: "desk_0011".into(),
            kind: DesktopActionKind::Select,
            value: None,
        },
    )
    .expect("single-select ListBox item without pattern should plan LB_SETCURSEL");
    assert_eq!(
        plan,
        PlannedAction::NativeListBoxSelect {
            parent_hwnd_addr: 0x1234_5678,
            index: 1,
        }
    );

    // Multi-select / extended-select / no-sel ListBoxes must NEVER promote
    for forbidden_style in [LBS_MULTIPLESEL, LBS_EXTENDEDSEL, LBS_NOSEL] {
        let mut restricted = item.clone();
        restricted.list_parent.as_mut().unwrap().hwnd.style = forbidden_style;
        assert!(
            infer_supported_patterns(&restricted).is_empty(),
            "listbox style {forbidden_style:#x} must not promote to single-select"
        );
    }

    // ScrollBar inside a ListBox or element with its own HWND must NEVER become a list item
    let mut scrollbar = item.clone();
    scrollbar.control_type = SemanticControlType::ScrollBar;
    scrollbar.legacy_role = None;
    assert_eq!(infer_supported_patterns(&scrollbar), []);

    let mut container = base_input(4242);
    container.control_type = SemanticControlType::Pane;
    container.native_hwnd = Some(hwnd(4242, "WindowsForms10.LISTBOX.app.0.141b42a_r7_ad1", 0));
    assert_eq!(infer_supported_patterns(&container), []);
}

#[test]
fn unfocused_wpf_and_xaml_controls_use_background_safe_uia_while_untrusted_unfocused_fail() {
    assert!(is_background_safe_uia_framework("WPF"));
    assert!(is_background_safe_uia_framework("XAML"));
    assert!(!is_background_safe_uia_framework("WinForm"));
    assert!(!is_background_safe_uia_framework(""));

    // Unfocused WPF TextBox (no child HWND)
    let mut wpf_edit = base_input(5151);
    wpf_edit.framework_id = "WPF".into();
    wpf_edit.control_type = SemanticControlType::Edit;
    wpf_edit.has_value_pattern = true;
    assert_eq!(
        plan_action(
            &wpf_edit,
            &DesktopAction {
                reference: "desk_0012".into(),
                kind: DesktopActionKind::SetValue,
                value: Some("wpf-bg-ok".into()),
            },
        )
        .expect("unfocused WPF Edit with ValuePattern must be allowed in background"),
        PlannedAction::UiaValuePattern {
            value: "wpf-bg-ok".into(),
            background_unfocused: true,
        }
    );

    // Unfocused WPF Button
    let mut wpf_btn = base_input(5151);
    wpf_btn.framework_id = "WPF".into();
    wpf_btn.control_type = SemanticControlType::Button;
    wpf_btn.has_invoke_pattern = true;
    assert_eq!(
        plan_action(
            &wpf_btn,
            &DesktopAction {
                reference: "desk_0013".into(),
                kind: DesktopActionKind::Invoke,
                value: None,
            },
        )
        .expect("unfocused WPF Button with InvokePattern must be allowed in background"),
        PlannedAction::UiaInvokePattern {
            background_unfocused: true,
        }
    );

    // Unfocused WPF ListBoxItem
    let mut wpf_item = base_input(5151);
    wpf_item.framework_id = "WPF".into();
    wpf_item.control_type = SemanticControlType::ListItem;
    wpf_item.has_selection_item_pattern = true;
    assert_eq!(
        plan_action(
            &wpf_item,
            &DesktopAction {
                reference: "desk_0014".into(),
                kind: DesktopActionKind::Select,
                value: None,
            },
        )
        .expect("unfocused WPF ListItem with SelectionItemPattern must be allowed in background"),
        PlannedAction::UiaSelectionItemPattern {
            background_unfocused: true,
        }
    );

    // Unfocused unknown framework without native HWND must stay rejected
    let mut unknown_edit = wpf_edit;
    unknown_edit.framework_id = "UnknownCustomFramework".into();
    assert_eq!(
        plan_action(
            &unknown_edit,
            &DesktopAction {
                reference: "desk_0015".into(),
                kind: DesktopActionKind::SetValue,
                value: Some("nope".into()),
            },
        )
        .unwrap_err()
        .code,
        ErrorCode::ActionUnverified
    );
}

#[test]
fn post_action_readback_and_focus_preservation_guards_reject_silent_failures() {
    verify_set_value_readback("expected", Some("expected"), "native_window_message")
        .expect("matching readback verifies");
    verify_set_value_readback("", Some(""), "native_window_message")
        .expect("empty readback matches empty expected text");

    assert_eq!(
        verify_set_value_readback("expected", Some("different"), "native_window_message")
            .unwrap_err()
            .code,
        ErrorCode::ActionUnverified
    );
    assert_eq!(
        verify_set_value_readback("expected", None, "native_window_message")
            .unwrap_err()
            .code,
        ErrorCode::ActionUnverified
    );

    verify_select_readback(1, 1).expect("matching list selection verifies");
    assert_eq!(
        verify_select_readback(1, 0).unwrap_err().code,
        ErrorCode::ActionUnverified
    );
    assert_eq!(
        verify_select_readback(1, -1).unwrap_err().code,
        ErrorCode::ActionUnverified
    );

    check_focus_preserved(4242, false, Some(9001), Some(9001))
        .expect("human foreground window stayed focused");
    assert_eq!(
        check_focus_preserved(4242, false, Some(9001), Some(4242))
            .unwrap_err()
            .code,
        ErrorCode::ActionUnverified
    );
}

#[test]
fn split_button_and_unknown_ownerdraw_and_password_behave_safely() {
    // Button with UIA InvokePattern without native HWND on WinForms focused vs unfocused
    let mut uia_focused = base_input(4242);
    uia_focused.control_type = SemanticControlType::Button;
    uia_focused.has_invoke_pattern = true;
    uia_focused.focused = true;
    assert_eq!(
        plan_action(
            &uia_focused,
            &DesktopAction {
                reference: "desk_0016".into(),
                kind: DesktopActionKind::Invoke,
                value: None,
            },
        )
        .expect("focused WinForms UIA button should succeed"),
        PlannedAction::UiaInvokePattern {
            background_unfocused: false,
        }
    );

    // Unconfirmed BS_OWNERDRAW on Pane with legacy_role=None fails closed (cannot guess PushButton)
    let mut ownerdraw_unknown = base_input(4242);
    ownerdraw_unknown.control_type = SemanticControlType::Pane;
    ownerdraw_unknown.native_hwnd = Some(hwnd(
        4242,
        "WindowsForms10.BUTTON.app.0.141b42a_r7_ad1",
        BS_OWNERDRAW,
    ));
    assert_eq!(infer_supported_patterns(&ownerdraw_unknown), []);

    // Password box rejects SetValue with PermissionDenied
    let mut pw = base_input(4242);
    pw.is_password = true;
    pw.native_hwnd = Some(hwnd(4242, "WindowsForms10.EDIT.app.0.141b42a_r7_ad1", 0));
    assert_eq!(
        plan_action(
            &pw,
            &DesktopAction {
                reference: "desk_0017".into(),
                kind: DesktopActionKind::SetValue,
                value: Some("secret".into()),
            },
        )
        .unwrap_err()
        .code,
        ErrorCode::PermissionDenied
    );
}

fn check_bounded_send_calls(name: &str, source: &str) {
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

#[test]
fn windows_compat_and_uia_contain_no_physical_input_clipboard_or_unbounded_send_calls() {
    let uia_source = include_str!("../src/windows_uia.rs");
    let compat_source = include_str!("../src/windows_compat.rs");

    for (name, source) in [
        ("windows_uia.rs", uia_source),
        ("windows_compat.rs", compat_source),
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
                "{name} must not contain forbidden physical/clipboard/unbounded pattern: {forbidden}"
            );
        }
        check_bounded_send_calls(name, source);
    }
}

#[test]
fn unaccepted_focus_sensitive_patterns_fail_before_background_dispatch() {
    for planned in [
        PlannedAction::UiaTogglePattern,
        PlannedAction::UiaExpandPattern,
        PlannedAction::UiaCollapsePattern,
    ] {
        for (foreground, focused) in [(false, false), (false, true), (true, false)] {
            let error = check_semantic_dispatch_precondition(&planned, foreground, focused)
                .expect_err("unaccepted focus-sensitive pattern must not dispatch");
            assert_eq!(error.code, ErrorCode::CapabilityUnavailable);
            assert_eq!(error.details["dispatch_started"], false);
        }
        check_semantic_dispatch_precondition(&planned, true, true)
            .expect("already focused target is not newly activated by this precondition");
    }
    check_semantic_dispatch_precondition(
        &PlannedAction::UiaValuePattern {
            value: "fixture".into(),
            background_unfocused: true,
        },
        false,
        false,
    )
    .expect("existing accepted-path planning is not changed by the targeted containment");
}

#[test]
fn failed_dispatch_does_not_skip_foreground_verification() {
    let failure = || tether_core::CapabilityError {
        code: ErrorCode::ActionUnverified,
        message: "provider response was lost".into(),
        recovery_hint: None,
        details: serde_json::json!({}),
    };

    let err =
        finish_semantic_dispatch::<()>(Err(failure()), 4242, false, Some(9001), Some(4242))
            .unwrap_err();
    assert_eq!(err.code, ErrorCode::ActionUnverified);
    assert!(err.message.contains("altered foreground focus"));
    assert_eq!(err.details["dispatch_returned_error"], true);
    assert_eq!(err.details["outcome_uncertain"], true);
    assert!(err.recovery_hint.unwrap().contains("do not automatically replay"));

    let err =
        finish_semantic_dispatch::<()>(Err(failure()), 4242, false, Some(9001), Some(9001))
            .unwrap_err();
    assert_eq!(err.message, "provider response was lost");

    let err =
        finish_semantic_dispatch(Ok(()), 4242, false, Some(9001), Some(4242)).unwrap_err();
    assert_eq!(err.details["dispatch_returned_error"], false);
    assert_eq!(err.details["outcome_uncertain"], true);

    assert_eq!(
        finish_semantic_dispatch(Ok(7), 4242, false, Some(9001), Some(9001)).unwrap(),
        7
    );
}
