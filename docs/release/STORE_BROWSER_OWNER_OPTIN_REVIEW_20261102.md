# Windows Store browser owner enrollment — isolated source review

Date: 2026-11-02. **NOT DEPLOYED; REVIEW / CI / REAL-DEVICE ACCEPTANCE REQUIRED.**

## Existing boundary that must not change

The device owner separately approves device registration in the existing authenticated relay. The local Store wizard uses a nonce in its loopback URL fragment; its API also requires the corresponding header and the exact same HTTP Origin on POSTs. The relay authenticates a device by its local credential; local AgentRuntime policy remains authoritative for filesystem, process, browser and desktop actions.

An installed browser extension is **not** automatically trusted by inclusion in an MSIX. Human-owned tabs and origins must remain private until the extension is loaded locally, explicitly paired with an owner-approved extension ID, and individual tabs/origins are granted.

## Changes in this review candidate

- `app/browser-owner.mjs`: validates exact extension ID format, the package-owned windowless browser launcher, standalone host and extension service-worker bundle. After an already-approved device identity passes the existing owner/SYSTEM-only DACL check, **a second explicit local consent** creates three owner-private browser files: the pinned extension ID, one local agent RPC token and a separate extension launch token. Files use exclusive create (`wx`), never overwrite, and are independently ACL-verified. Partial/invalid enrollment blocks browser access but preserves the device identity.
- `app/runtime-app.mjs`: adds authenticated same-origin `/api/browser/enroll`, `/api/browser/start` and `/api/browser/stop`. The browser host is started only from a deliberate owner action, via the packaged GUI subsystem `tetherplane-browserw.exe`, with the protected state directory supplied as a path (no token contents in argv or HTTP).
- `app/runtime-app.mjs` and `app/agent-autostart.mjs`: **conditionally** add `--browser-bridge 127.0.0.1:17657` and `--browser-bridge-token-file` pointing to the approved private token file. Invalid or absent enrollment never makes the core agent unstartable; it leaves browser capabilities unavailable. The logon supervisor re-evaluates enrollment before each restart.
- `setup.html` and `setup-client.js`: show manual owner steps after device pairing; never display local secret values or claim connectivity before independent `device.status` verification. This wizard does **not** silently enable a browser Run key, StartupTask, extension installation or grant.
- The new enrollment/denial test was executed locally on Windows. Adding a separate GitHub Actions workflow step requires `workflow` OAuth permission, which is not available; this review branch deliberately makes no workflow-file changes. Existing CI still runs its established quality suite, but the six new tests must not be claimed as CI-enforced.

## Local proof (not release acceptance)

Surface Windows 10 Pro, Node 24.20.0: six new tests passed (0 failures), covering no default browser, immutable protected files, partial/foreign enrollment rejection, missing browser payload denial without core outage, owner/origin confirmation, conditional flags and manual windowless host start/stop. Existing Store runtime + private-candidate + unpaired UI suite: 33 passed, 1 UI screenshot test skipped, 0 failed. A separate Store-sealed Rust-agent test initially could not execute locally because the isolated clone lacks `target/debug/tetherd.exe`; GitHub Windows CI explicitly builds that executable before executing the test.

The new cross-platform CI must independently compile and run the combined exact commit. No native signed Store installation, actual browser-extension consent/session, code-integrity/SAC trust, network fault, Windows 11 host or full four-device admission is yet proven.

## Open security / UX release gates

1. Owner-scoped **immediate revocation** of an already running browser pairing, including external autostart agents and their in-memory token; preventing silent re-enrollment or token reuse. Merely deleting a token file or stopping a wizard-owned process is insufficient proof.
2. Browser-host lifecycle after Windows logon and crash, with owner opt-in, no duplicate host, no terminal and no orphan child, across real MSIX package user isolation. Startup task remains disabled by default.
3. Complete manual extension pairing: real extension ID, launcher token transfer without disclosure to model/remote client, tab/origin grant, off-origin/redirect/frame denial, grant expiry, upload/sensitive-operation consent, and independent proof that browser.available only becomes true after authentication.
4. Test damaged/foreign browser-state DACL, symlink/hardlink, partial enrollment and Store signature mismatch on supported physical Windows 11 under normal application-control settings.
5. Microsoft Store publisher eligibility, Store-signed private audience installation, rollback, uninstallation and retained/cleared user data under explicit policy.

Until these are satisfied, treat this implementation as a **review-only integration candidate**, never as a browser-ready consumer release.
