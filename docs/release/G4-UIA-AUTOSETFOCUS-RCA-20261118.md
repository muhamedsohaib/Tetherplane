# G4 incident RCA — Microsoft UI Automation automatic focus

**Date:** 2026-11-18 UTC
**Status:** verified API behavior, strong root-cause hypothesis; device-level fix UNVERIFIED
**Source / prior interactive guest:** `725f0eb92182af96b03482b0822ed7ac4e707fb5`
**Related PR:** [Draft #153](https://github.com/muhamedsohaib/Tetherplane/pull/153) (targets `experiment/g4-sandbox-kit-20261118`; do not merge).
**Location of original TAP:** `SOHAIB-SURFACE:C:\Users\Sohaib\TetherplaneWorkspace\G4-AutoHarness\G4-725f0eb-20261118\reports\G4-Result-725f0eb.txt`

## Direct real-device observation

The latest isolated Windows Sandbox G4 acceptance completed **2/3** tests with **0 skipped** and **teardown PASS / zero fixture processes**.

* WinForms + WPF nonvisible fixture constructors: PASS.
* WinForms coexistence including preserved human foreground, clipboard and cursor: PASS.
* WPF owned edit `desktop.act(set_value)`: FAIL with `action_unverified`, message `semantic desktop action altered foreground focus in background_only mode`.
* OS foreground changed from human PID **2856**, HWND **197204**, to owned PID **3632**, HWND **262716**.
* Owned WPF value nevertheless changed from `Owned-initial` to `owned-semantic-value`. Human window lost focus. Thus the post-dispatch check caught the breach **after a mutation and foreground transfer already occurred**.
* WPF readiness, independent OS foreground corroboration and state heartbeat had passed before this action. There was no cursor delta; system clipboard remained unchanged.
* Raw `G4_COEXISTENCE_TELEMETRY` line is valid JSON; raw `G4_FIXTURE_FAILURE_CONTEXT` nested error line has invalid JSON escaping and should be repaired separately.

## Primary API explanation — Microsoft

Microsoft [IUIAutomation2::put_AutoSetFocus](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-put_autosetfocus) explicitly states:

> By default, most UI Automation methods that perform an action on an element, such as IUIAutomationInvokePattern::Invoke and IUIAutomationValuePattern::SetValue, set focus to the element before performing the action.

Microsoft supports setting **AutoSetFocus = FALSE** to disable that UIA automatic focus behavior (Windows 8 and newer).

Tetherplane's `agent/providers/desktop/src/windows_uia.rs` uses `UIAutomation::new()` followed by `UIValuePattern::set_value(value)` in `execute_uia_value_pattern`. There is **no explicit AutoSetFocus=false** configuration before this call. It then calls `check_focus_preserved` after dispatch, too late to avoid a focus-stealing side effect.

The dependency `uiautomation = 0.25.1` does not expose an AutoSetFocus setter on its safe public `UIAutomation` API. Upstream `UIAutomation::new_direct` uses `CUIAutomation` (not `CUIAutomation8`), according to the crate source. The Windows COM `IUIAutomation2::SetAutoSetFocus(false)` entry point exists on a suitable `CUIAutomation8` client, but the generated Rust binding requires `unsafe`. The Tetherplane workspace denies unsafe Rust, `scripts/check-no-unsafe.py` rejects authored unsafe under `agent/`, and the desktop crate preserves `#![forbid(unsafe_code)]` / project safety requirements.

**Confidence:** High that default UIA focus caused this specific observed activation. The effect of correctly setting AutoSetFocus=false *in the same client's COM instance* is a **testable hypothesis**; not yet proven in the disposable guest. Do not claim G4 PASS from this document.

## Independent Surface host compatibility check

Read-only Windows host checks via the existing authorized Surface connection on 2026-11-18 UTC:
- OS reported Windows NT 10.0.19045.0 (Surface host).
- `CUIAutomation8` CLSID `{E22AD333-B25F-460C-83D0-0581107395C9}` exists in both HKCR and HKLM Classes registration.
- A noninteractive `Activator.CreateInstance(Type.GetTypeFromCLSID(...))` succeeded and the resulting COM object was immediately released: **CUIAUTOMATION8_COM_ACTIVATION=PASS**.
- UIAutomationCore.dll version reported `7.2.19041.320`.
- This checks **COM class availability on the host only**; it does not establish that `IUIAutomation2::SetAutoSetFocus(false)` has been invoked in the Rust worker, and does not establish real-guest nofocus action behavior.

## Smallest safe engineering direction for Hydrogen

1. Maintain **Draft PR #153** in the isolated branch. Do not modify production Tetherplane agents or OAuth/permissions.
2. Introduce/obtain a **reviewed safe Rust UIA client constructor** that:
    * Creates the Windows `CUIAutomation8` COM client, obtains `IUIAutomation2`, sets `AutoSetFocus=false` and **checks the result**, **before obtaining any UIA elements or executing patterns**.
    * Adapts the same configured COM client to the existing `uiautomation::UIAutomation` wrapper and keeps it for the worker's lifetime; no separate-process toggle and no per-operation race.
    * Fails closed with a typed capability/error if CUIAutomation8 or the setting is unavailable; do **not** silently fall back to current `UIAutomation::new()` for background UIA mutations.
    * Preserves existing source-rights/licensing and workspace unsafe-code restrictions. If an upstream safe wrapper or small audited external FFI dependency is required, treat that API/dependency decision as a material review boundary; do not bypass `#![forbid(unsafe_code)]`.
3. Add a Windows regression which asserts the **same client** used for operations reports `AutoSetFocus==false` and fails initialization otherwise. Preserve the current foreground, cursor, clipboard, ownership and denial assertions.
4. Build portable kit and run the exact WPF guest scenario; require text readback with human OS foreground unchanged **at every step**. Verify WPF `InvokePattern` and `SelectionItemPattern` independently, because Microsoft's default auto-focus applies to many action patterns.
5. **Important limitation:** disabling UIA's automatic focus cannot stop a hostile/custom provider from explicitly activating itself inside its own event handler. For unverified application/provider combinations, a strict "never take human focus" promise is not generally provable by a postcondition; reject the background action **before mutation** unless the transport/provider is demonstrably safe. Do not silently restore focus afterward.
6. Repair malformed error-context JSON formatting and preserve both raw TAP and normalized telemetry.

## Required evidence

A fresh isolated Windows Sandbox acceptance on the pinned repaired source:

* 3 tests / 3 PASS / 0 FAIL / 0 SKIP.
* `G4_LOCAL_COMPACT_MCP_EXIT=0` and `G4_FIXTURE_TEARDOWN=PASS count=0`.
* WPF state/foreground: owned remains unfocused; human PID/HWND stays foreground through every action.
* Cursor/clipboard unchanged; negative authorization/owner checks pass.
* No merges, production installs, device restarts, credential changes or permission changes.

**Recommendation:** First demonstrate `AutoSetFocus=false` with a test-only minimal COM client or reviewed safe wrapper, **not** by adding temporary focus-restoration, synthetic input, or weakened assertions to the desktop provider.
