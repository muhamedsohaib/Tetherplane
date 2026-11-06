# Leno combined browser acceptance — 2026-11-06

## Failure observed
- Live production Leno Tetherplane agent remains authenticated and responsive, but `browser.status.capabilities.backend = cdp` and `ownership = tetherplane_only`. Active agent's `--browser-bridge` points to `127.0.0.1:17655`.
- A separate CDP-owned FalcoWin test tab may appear in `browser.pages`; it is not an authenticated human Edge tab.
- Local owner-pinned extension host listens on 127.0.0.1:17656 (pairing) and :17658 (authenticated WS) but no authenticated Edge connection is active, so :17657 is not currently listening.
- The Edge popup's owner-approved 5-minute grants are intentionally ephemeral; they expire and must not be treated as a global grant.
- Existing script `scripts/browser-mode-windows.ps1` targets the **obsolete** agent task and executable paths and is not a valid production cutover route for this Leno deployment.

## Combined solution
- `scripts/browser-unified-rpc-host.mjs`: loopback-only authenticated RPC router at port 17660. It queries the existing CDP bridge (:17655) and the owner-approved extension backend (:17657).
- A `cdp:...` page always uses CDP; a `tab:...` page always uses the authenticated extension. It **never falls back** to CDP when an Edge grant is denied, revoked, expired or disconnected. No raw human-owned tab appears in the merged page list.
- Default new tabs use CDP. Owner-approved site grants may explicitly request the authenticated extension backend; ordinary per-tab consent never expands to site-wide access.
- `scripts/probe-combined-browser.mjs` reads only backend capability and grant *counts* (not URLs, page contents, cookies, credentials, or token material).
- The reviewed existing agent binary is unchanged. A **side-by-side stdio** test confirmed it can connect to the combined router and still use CDP, while denying an unshared Edge tab.
- **12/12 unit tests passed** covering handshake authentication, backend routing, private-tab omission, disconnection, denial, and basic real TCP.
- This does **not** claim a successful production switch or personal Edge integration until owner consent and live acceptance are completed.

## Staged files on Leno
Under `%LOCALAPPDATA%\Tetherplane\release-candidates\BrowserCombined20261106`:
- `browser-unified-rpc-host.mjs` SHA-256 `1A415EBED89DB9D6CBF5DC75797387DD2D598120262303C98C63138E805D3490`
- `agent-args.combined.json` SHA-256 `D9037F65A1130354F3CEEFF6A21D0BBD7626A2231034BEF905707B1D08A66E66`
- `Probe-Combined-Browser-20261106.mjs` SHA-256 `80EE5D782BF2371F6920E8004FBD6AB7A1650A248737504A5C3031B0A0391A32`
- `Owner-Enable-Combined-Browser-20261106.ps1` SHA-256 `5A7B035ACCFE643948392EA55B9EDFEF2293E3B481214C5C699FC57D7F21DEAC`

The candidate agent argument array has all original 16 arguments with **only one value changed**, from `127.0.0.1:17655` to `127.0.0.1:17660`. Principal, relay URL, token file paths, device identity, and OAuth are not edited.

## LOCAL owner procedure (not executable through AI/remote control)

1. On **Leno**, sign in to Windows as Sohaib. In the actual Microsoft Edge profile, open the target authorized tab and the Tetherplane extension popup.
2. Under *Duration and permissions*, choose **10 minutes** for this controlled acceptance. Navigation and uploads may remain off. Click **Connect this tab** once. Do not share credentials.
3. From the local Windows PowerShell owner console:
   ```powershell
   $script = Join-Path $env:LOCALAPPDATA 'Tetherplane\release-candidates\BrowserCombined20261106\Owner-Enable-Combined-Browser-20261106.ps1'
   powershell.exe -NoProfile -File $script -Mode SelfTest
   powershell.exe -NoProfile -File $script -Mode Preflight
   ```
   The preflight must show `READY_LOCAL_OWNER_APPLY_REQUIRED` with `owner_tab_grant_visible: true`.
4. Then, **only after reviewing its effects**:
   ```powershell
   powershell.exe -NoProfile -File $script -Mode Apply
   ```
   Type `AUTHORIZE COMBINED EDGE BROWSER CUTOVER` at the local prompt. This registers two owner-interactive logon tasks (authenticated extension host + combined router, both Limited run level), starts the router, arms a **6-minute local rollback**, and changes the existing agent's scheduled task action to use the *staged* 16-argument configuration. It never rotates tokens, changes extension ID, copies cookies, or changes owner grants.
5. Once Apply reports `COMBINED_BROWSER_CANDIDATE_RUNNING_VERIFY_REMOTE_THEN_ACCEPT_LOCALLY`, **immediately return to ChatGPT**. I must verify `device.status`, `browser.status` backend `cdp_plus_owner_authorized_extension`, and `browser.pages` showing only explicitly authorized Edge tabs plus managed tabs. Check a harmless read-only snapshot of the approved page if safe; do not take any transactional actions.
6. **After independent remote verification and before the watchdog fires**, locally run:
   ```powershell
   powershell.exe -NoProfile -File $script -Mode Accept
   ```
   Type `ACCEPT COMBINED BROWSER VERIFIED`. Acceptance re-checks the grant and watchdog deadline before disarming rollback. If the window expires, do not force acceptance; inspect current state first.
7. A subsequent reboot and Windows sign-in must prove the two new user-logon tasks, browser router, and extension re-pairing all recover. Re-pair the selected tab if its grant has expired.

## Recovery
- The six-minute owner-authorized watchdog restores the original agent task action if the owner does not accept the trial. It also unregisters the two new owner-logon tasks after restoring the original agent.
- Manual rollback, from the local owner PowerShell, uses `powershell.exe -NoProfile -File $script -Mode Rollback` and approval phrase `ROLLBACK COMBINED EDGE BROWSER`. Independent remote CDP restoration must be verified afterwards.
- If a task mutation, custom timeout, or grant expiration prevents acceptance, **do not repeatedly run Apply**; report the task state, logs and current browser backend, without attempting approval bypasses.

## Security and product boundary
- Only the browser extension's owner-popup grants authorize a signed-in tab. Neither the router nor remote ChatGPT tooling can create a grant for an unshared tab.
- Never grant an entire authenticated Edge profile, export browser cookies, passwords or bearer tokens, or access unrelated tabs.
- The launch token and Tetherplane device token remain stored under their existing user-local ACLs. The router reuses the existing authenticated loopback bridge token without logging it.
- This is a private candidate, **not** a public product release, signed binary upgrade, or permissions migration.
