# Review-only WebView2 adapter boundary

This is a design acceptance contract, **not** an implemented production adapter. Keep all changes in isolated drafts until authorization, isolation and real-device evidence pass. Do not alter the working four-device architecture or live agent.

## Reuse the existing interfaces; do not expose arbitrary CDP

The current browser bridge has a typed policy/action layer. In particular:

- browser/bridge/src/action.ts defines BrowserBridgeBackend with observe, perform and waitForSettled.
- browser/bridge/src/cdp-backend.ts defines CdpControl: createTarget, listTargets, closeTarget, navigateTarget, frames, observeFrame, performFrame, uploadFile, downloads, diagnostics and close.
- CdpBrowserBackend maintains a private set of Tetherplane-owned target IDs and never enumerates human-owned pages.
- cdp-lab-service.ts grants only local fixture actions; this is intentionally not a production authorization model.

Windows WebView2 exposes **page-level** CoreWebView2.CallDevToolsProtocolMethodAsync within a WinForms/COM message loop. It does NOT automatically supply the browser-wide Target session semantics that CdpControl requires.

The minimal safe next implementation is a **Windows-only isolated WebView2 host adapter** behind the existing browser action/policy layer, or a deliberately limited backend implementing BrowserBridgeBackend if CdpControl cannot be met without dangerous assumptions. Do not silently imitate unsupported CDP methods.

### Candidate mapping (not yet verified)

| Current contract | Windows WebView2 candidate | Acceptance gate |
| --- | --- | --- |
| createTarget | Allocate a dedicated WebView2 controller and random owned page ID | No attachment to human tabs; background never steals focus |
| listTargets | Return only in-process owned controllers | Reject synthetic/stale/foreign page IDs |
| closeTarget | Dispose owned controller and isolate per-profile lifecycle | No retained HWND/process/profile resource |
| navigateTarget | CoreWebView2.Navigate under per-origin/action authorization | Redirects, popups and all subresources cannot escape grant |
| frames / observeFrame | Frame-scoped DOM observation and semantic revision | Prove document/frame identifiers cannot be spoofed or reused |
| performFrame | Typed click/fill/select/check with snapshot token validation | Browser input acts only on owned, authorized document |
| uploadFile / downloads | Explicit capability unavailable until reviewed | Do not advertise or permit direct filesystem access |
| diagnostics | Structured, redacted events | Never leak cookies, tokens, passwords or page secrets |
| close | Bounded shutdown of owned host and controller | Test broker termination, recovery and on-disk rollback |

**Important existing interface hazard:** CdpBrowserBackend.capabilities() currently advertises upload/download/diagnostics unconditionally. Do not reuse it with a partially implemented WebView2 adapter without a tested capability-negotiation change; otherwise agents may be promised unsafe or unavailable operations.

## IPC and authority design

- Prefer a **single purpose, parent-bound, authenticated local IPC** from the existing Tetherplane browser broker to a dedicated Windows STA host. No public listener, and never forward raw CDP or generic JavaScript to remote principals.
- Agent requests must remain constrained to typed browser operations enforced by the existing principal/authorization/verification layers.
- Only the owner may explicitly initiate a temporary visible-login state; credentials/MFA stay within the WebView2 controller. Re-enter zero-opacity background mode only after the owner approves handoff.
- Each site/account/action grant is time-limited, revocable and enforced **before** all browser mutations and navigation. A revoked grant terminates further browser/network activity.
- Treat user-owned tabs, nonowned windows, local shell/filesystem and unrelated devices as outside the browser principal's authority.

## Test-first security gate (must be red before a production adapter)

1. Opening, observing and closing a disposable **owned** local page works; foreign IDs are denied and never listed.
2. Reject off-origin top-level navigation, redirects, nested frames, cross-origin fetch/WebSocket/worker/WebRTC, popup/download requests and unauthorized file uploads **before network I/O**. A navigation event alone is insufficient; use independently observed egress plus OS-level containment when necessary.
3. Enforce source/document revision freshness: a stale semantic action must fail and must not click/fill a different page.
4. A separate local untrusted process cannot invoke the host IPC or attach to its page; attempt IPC spoofing, race, replay, and revocation.
5. During authorized concurrent human interaction, the background browser never moves the cursor, changes clipboard, activates a window, switches a human-owned tab or opens a visible prompt.
6. Crashes, network loss, denied grants and browser shutdown never kill Tetherplane's authenticated core or leave test browser processes. Record cleanup time and rollback.
7. Prove clean onboarding without a full .NET SDK, elevated privileges or browser replacement, and independently repeat the required four-device acceptance.

Do not mistake a synthetic local HTML success or full CI green for signed-in browser isolation. This design cannot be merged into the released browser provider until these gates pass.
