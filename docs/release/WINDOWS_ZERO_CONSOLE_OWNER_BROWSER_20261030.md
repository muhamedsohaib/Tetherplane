# Windows zero-console owner-browser release gate (2026-10-30)

Status: DRAFT / REVIEW ONLY / RELEASE NO-GO. This branch is stacked on the
private Windows/MSIX candidate at `f2532b5efb43fd326cfb61227b28d80a49cc8946`. It does not install, sign, publish,
change OAuth/DCR, change scopes, migrate existing tasks or alter any of the four
real devices.

## Independently observed incident

Leno's approved native direct-task canary used `tetherd.exe` (Windows console
subsystem) under an interactive elevated task and therefore displayed a console.
The legacy developer browser installer added
`HKCU\\...\\Run\\TetherplaneAuthenticatedBrowserHost` pointing to
`powershell.exe -WindowStyle Hidden -File browser-extension-host-supervisor.ps1`.
On 2026-10-30 that registered background supervisor created a persistent blank
Windows Terminal even though its `-WindowStyle Hidden` flag was present.
The owner-observed consoles were individually hidden without stopping either
the authenticated device core or the browser host, but both were transient
display-only interventions, not a distributable fix.

The same live canary briefly failed when its configured browser bridge was absent.
Removing ONLY browser startup arguments from the existing protected native
canary restored device connectivity. Real Leno authenticated status, battery
transition and logon-triggered reboot reconnection then passed. The browser
capability remained unavailable to that native agent, which is not a complete
product release.

## Intended production architecture

- `bin/tetherd.exe` remains the console CLI/stdio binary for developer and MCP
  flows. Removing it would break existing clients.
- `bin/tetherd-agentw.exe` is the GUI-subsystem Windows background agent;
  the native least-privilege Scheduled Task owns it directly. No PowerShell
  process or Terminal is required. Core relay/OAuth authorization is unchanged.
- `bin/tetherplane-browserw.exe` is an owner-session GUI-subsystem **browser
  companion**, not another device agent. It launches the already reviewed
  `browser/host.mjs` with Windows `CREATE_NO_WINDOW` for Node. It requires
  existing owner token files and pinned extension ID; it cannot create them
  or attach to human tabs. Optional per-user autorun is **opt-in** from
  `tetherplane-browser-setup.ps1 -EnableBackgroundStartup`.
- The old developer browser installer is changed to register only the native
  GUI browser launcher and refuses overwriting any existing legacy HKCU Run
  value. No automated replacement of the Leno legacy entry is authorized.
- A browser host that sees its native launcher disappear requests orderly
  shutdown of the already-owned loopback sockets, avoiding a persistent orphan
  when its parent is stopped. Bounded restart backoff and bounded-size logs
  replace the previous PowerShell infinite loop.

## Tests / exact release gate

Windows CI must build and inspect **all three** native executables, preserve
console-subsystem CLI (PE 3), require GUI-subsystem agent and browser launcher
(PE 2), and verify installed SHA-256 matches packaged bytes. The actual
packaged browser launcher is exercised with disposable synthetic owner files,
random localhost ports and no browser pairing. It must fail closed on missing
owner enrollment, keep browser RPC closed before pairing, show no process
window, preserve token bytes, and tear down its Node child on parent exit.
The source contract rejects PowerShell browser autorun.

CI Windows desktop checks are **not** an interactive real-user desktop proof.
Before production release, run a signed build on an authorized clean Windows
machine with a logged-in user, and visually verify no foreground console at
enrollment, startup, repeated reconnection, battery transition, sign-in and
reboot. Include browser consent and denial, cancellation/no-orphan, uninstall,
rollback, authenticated four-device status and negative scope tests. The
optional browser host must fail closed without taking the authenticated device
core offline. No blind migration of user-owned registry, schedules or tokens.

No public release, Store submission or production migration is approved by
this draft.
