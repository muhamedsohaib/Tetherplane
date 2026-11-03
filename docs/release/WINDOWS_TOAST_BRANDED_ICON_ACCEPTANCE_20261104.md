# Branded Windows toast — developer-beta acceptance checkpoint

Date: 2026-11-04
Scope: unpackaged, explicitly opt-in **GitHub developer beta**. No code signing, MSIX or Microsoft Store requirements.

## Verified on Leno (read-only agent; disposable per-user notification)

- Exact owner-supplied images verified against original conversation uploads:
  - `black-on-white.jpg` SHA-256 `c7489fd386a9585d1b52a4fe76b6f5e7765f3fc508c4b7f5fcff58b8a986bbf5`
  - `white-on-black.jpg` SHA-256 `c964d071774f67ec83b85207e5ff2511e441f3676b5d92893cffe974a74d0e12`
- Nine PNG-backed ICO resolutions per variant: 16, 20, 24, 32, 40, 48, 64, 128, 256. Rebuilding with `Build-TetherplaneIcons.ps1` in a unique disposable directory reproduced the exact SHA-256 values:
  - black-on-white ICO `48ecaa5c905e4de0e87cb86c45edc4a92c8692c77e08d06225bff46f95191c46`
  - white-on-black ICO `b084d81ea23677778a5d4ee6fa4e2ed532a7b24a56a3ff2f41a6947712cad8af`
- Node source/asset contract tests: `node --test tests/release/windows-toast-icons.test.mjs` — 3/3 passed before the SHA pin regression enhancement. `node --test tests/release/windows-notification-event-source.test.mjs` — 11/11 passed.
- The default developer-beta shortcut was registered in **the same user session as Explorer**, using `ARCUSLabs.Tetherplane.DevBeta`; `IconLocation` matched the approved black-on-white ICO; a second identical Register call was idempotent.
- Synthetic WinRT ToastGeneric notification sent from that user session and uniquely tagged; `ToastNotificationManager.History.GetHistory` contained exactly one matching notification. This establishes Windows accepted/stored the event, **not** human-visible popup or pixel-level icon rendering.
- Registration with a deliberately altered disposable ICO was denied with `BETA_TOAST_ICON_HASH_MISMATCH`; registration with the approved ICO succeeded. The approved original files were not modified.
- The temporary per-user shortcut and disposable test executable were removed. The zero-byte executable was a **non-executed shortcut target** for registration-only testing; it was not the native Rust notification sender.
- Read-only `Test-LenoPrivateAgentCanaryReadiness.ps1`: current protected Leno agent baseline passed; task Running, exactly one matching process, installed hash verified, protected arguments-file contents not read. Independent rollback and secondary control path **not** verified; `SafeToReplaceLiveAgent=false`.
- Current Tetherplane status: Leno, RTX and VAULTER responded to authenticated `device.status`; Surface returned `disconnected`. No live agent/service/credential/policy changes.

## Not yet verified / release gates

1. **Native Rust sender**: run a pinned, legitimate `tetherplane-toast-smoke.exe --smoke --developer-beta` with registered AUMID; independently verify Windows history and branded icon display in Notification Center. The synthetic PowerShell dispatch is insufficient for native-binary acceptance.
2. **Real event feed and authorization**: prove events are sourced from a real authenticated owner/relay feed, do not leak secrets, and cannot approve actions; repeat denied authentication and unauthorized capability cases with fresh binaries and the intended release candidate.
3. **Clean-machine onboarding**: repeat from a fresh authorized Windows machine, without manual credentials or antivirus-policy bypasses. Measure setup time, verify allowed command and denial, connection stability and clean rollback.
4. **Four-device acceptance and recovery**: restore Surface; independently test reconnection, logoff/restart where authorized, stale session classification and agent rollback/recovery. Do not replace Leno's protected agent without separate authorization and a proven alternate control path.
5. **Shipping provenance**: build the actual developer-beta binaries in reproducible CI, verify artifact and source SHA-256, and exercise extracted ZIP end-to-end. The current icon assets/tests alone do not prove installer/distribution readiness.
6. **Visual confirmation**: Windows notification history and shortcut `IconLocation` are verified; a human-visible popup and rendered app icon remain unobserved.
7. **Scope differentiation**: notification-center branding does **not** provide a persistent system-tray icon; that is separate optional beta UX work.

**Current release assessment: NO-GO for full public Tetherplane developer beta** until the minimum connectivity, authorization, onboarding and native acceptance gates are independently met. No code signing/MSIX/Store requirement. No branch pushed, merged, tagged or released by this task.
