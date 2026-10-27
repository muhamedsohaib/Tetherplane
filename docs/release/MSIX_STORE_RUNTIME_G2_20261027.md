# Tetherplane Store Runtime G2 — owner-controlled first-run prototype

**Status:** DEVELOPMENT CANDIDATE ONLY. Parent branch: validated MSIX feasibility PR #60. Do not publish or merge into protected main.

## Intended behavior
The manifest uses a **bundled Node.js Windows runtime** as its desktop application executable with an explicit start script and package-installation directory. The script starts a localhost-only, single-session pairing wizard. No executable, provider or OAuth client is installed system-wide and the package declares **no auto-start or service**.

When a human explicitly chooses an authorized relay WSS URL, new device ID and existing permitted filesystem directory, the wizard posts a SHA-256 hash of a newly generated device credential to the existing relay's unauthenticated \`/pair/start\` endpoint. It displays the returned code and requires the user to approve that code in their **existing authenticated owner Control Center**. The Store-preview app does not request or store the owner's OAuth token and does not call \`/pair/approve\`.

Only after the user states they approved does it write the new device credential into **separate per-user development state**, then launch the packaged native \`tetherd.exe\` with existing documented flags. The UI describes the result as **agent started, connection not independently verified** until a separate authenticated device.status succeeds. Repeat launches detect saved state; no replace/re-pair.

The Node Compact MCP adapter is included in the package with production dependencies for downstream integration, but functional external MCP setup is a separate release gate.

## Safety and lifecycle
- Local browser UI binds to \`127.0.0.1\` on a random port. A 256-bit session token is sent in the local browser URL fragment and then removed from browser history; POST calls require exact Origin, JSON and header token. No CORS grants, redirects, external scripts or remote browser access.
- All remote pairing requests require \`wss://...\` with exact \`/device\` path, converted to \`https://.../pair/start\`. No unsafe plaintext remote transport, token-in-URL or credential transmission.
- No existing Tetherplane Canary, OAuth client, credential, scheduled task or mesh permission is changed. Never auto-import an old device identity.
- All runtime state is stored under a new \`%LOCALAPPDATA%\\TetherplaneStoreDevOnly\` directory in this **development experiment**. Production must use approved Windows package identity LocalState and verify ACL/DPAPI before handling real customer secrets.
- Local process launch cannot establish remote approval alone. A separate authenticated relay/device.status result is required.
- StartupTask is **deliberately absent** until informed user opt-in and reboot recovery are implemented and independently tested.
- Production signing, Partner Center identity, Store certification, Smart App Control On acceptance, rollback and multi-device acceptance remain **NO-GO**.

## Independent validation
Run local Node tests:
\`node --test tests/release/msix-store-runtime.test.mjs\`

Hosted disposable Windows acceptance must compile tetherd, bundle a trusted native Node runtime and production Compact MCP adapter, validate the full MSIX payload, temporarily sign with a development-only certificate, install/remove on an isolated runner and record **only a data-only JSON report**. This is not equivalent to a clean authorized first-user connection trial.


## Packaged-app activation gate (October 27, 2026)
The first hosted Windows G2 run #40473813335 passed packaging, signed-runtime validation, pack/unpack byte integrity and disposable Add-Appx/Remove-Appx. It did **not** test Windows package AUMID activation.

The next bounded read-only-in-production gate uses the Windows `IApplicationActivationManager` API to activate only the installed *development package*, checks its returned PID against the exact installed Node executable, terminates that matching test process, then removes the ephemeral MSIX and certificates. It runs solely on a guarded GitHub-hosted Windows PR runner. Browser UX, actual owner-approved pairing, Smart App Control On and user auto-start remain unverified and prohibited from release.
