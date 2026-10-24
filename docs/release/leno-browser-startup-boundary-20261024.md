# Leno browser-extension dependency: isolated core-startup correction

Date: 2026-10-24. **Draft source/test only; do not install, merge, sign, promote, or restart protected services based on this document.**

## Real-device evidence (observed, not inferred)

- Leno's Tailscale peer was online, but `device.status(Leno)` returned `disconnected`.
- Existing `Tetherplane Leno Canary` task was Ready and exited with result 1 after a direct native launch. The executable and existing arguments/credential/principal/browser-token files were present; binary SHA-256 was `905737D3B0F4897D71C5E78294866AD202AC09F45E4A069B0028F703DE8DBD50`, Authenticode `NotSigned`.
- The `Tetherplane Browser Bridge` PowerShell supervisor was Running, and one owned Node.js process listened on localhost ports 17656 (pairing) and 17658 (extension WebSocket). The agent-facing bridge RPC port 17657 had **no listener**.
- The authenticated browser-host source starts the RPC listener only after an extension WebSocket session is authorized, and removes it on disconnect.
- Owner paired the *existing* browser extension; the RPC listener appeared. Owner started **only** the existing Leno Canary task. One `tetherd.exe` launched under Task Scheduler, PID 20396, with no duplicate child.
- Independently authenticated ChatGPT `device.status(Leno)` and `device.capabilities(Leno)` passed; `browser.status(Leno)` confirmed `extension_authenticated_profile` in `background_only` mode. The out-of-root metadata check `filesystem.info(C:\\Windows\\explorer.exe)` returned `permission_denied`. Surface and VAULTER stayed responsive.
- Read-only Task Scheduler inspection showed both the Browser Bridge and Canary use logon triggers; installed canary restart count is 3 at 1-minute intervals (native installer source specifies 99). The matching SHA on Surface does **not** establish signed package or source provenance.
- Existing rollback tasks and identities were untouched; rollback task NextRunTime values were empty during inspection. RTX remains uninitialized/disconnected in the connector.

## Confirmed failure boundary and remaining uncertainty

The previous agent implementation performs browser RPC handshake **before** constructing the core runtime or registering its WSS device transport; failure exits the process. With the extension unpaired at Windows logon, an otherwise healthy agent can exhaust its few restarts. The exact fatal stderr for the 11:42 launch was not preserved, so this is a source-supported mechanism matching the observations, **not proof of the historical root cause**.

## Minimal draft-only improvement

- Validate the configured browser endpoint is loopback-only and require an existing browser-token-file argument when the bridge option is used.
- Construct the browser provider without waiting for the extension. Let the independently scoped core agent register immediately.
- Compute **browser** availability via a fresh, bounded **authenticated** handshake on each `device.capabilities` call. Return unavailable / empty operations if offline or denied, not stale positive capabilities.
- Every browser operation continues to send the existing token and pass the existing local capability authorization. No changes to OAuth, DCR, device credentials, grant scopes, relay, task registration, or Tailscale.
- Tests simulate an absent bridge, subsequent authenticated bridge readiness with operation-scope filtering, offline-after-online, rejected browser credentials, and non-loopback rejection.

## Acceptance gates still open

This source is not installed on Leno or any of the four devices. Require exact-head Windows+Ubuntu CI, independent security review of dynamic discovery behavior, a **trusted signed** clean Windows canary, first-boot offline-extension trial proving core status remains authenticated, reconnect without agent restart, browser denial before pairing, test of distinct user-session/browser combinations, state-preserving rollback, and independent four-device acceptance. Do not automatically replay mutations with uncertain outcomes. **Production NO-GO.**
