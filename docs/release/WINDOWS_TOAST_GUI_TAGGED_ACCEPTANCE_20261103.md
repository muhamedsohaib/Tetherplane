# Windows toast developer beta — GUI acceptance evidence (2026-11-03)

**Scope:** isolated loopback GUI acceptance only. No installed-agent replacement, restart, persistent session, OAuth/DCR modification, release, merge, or Windows security change.

## Exact provenance

- Source branch: `feature/windows-toast-notifications-design-20261103`
- Tested source commit: `72684903830c77c375d9a276bbbc4fc08ca9d5d8`
- Windows Toast Beta workflow: https://github.com/muhamedsohaib/Tetherplane/actions/runs/41627544060 — success
- Repository CI: https://github.com/muhamedsohaib/Tetherplane/actions/runs/41627543999 — success (Windows, Ubuntu, release policy)
- Hosted workflow artifact `tetherplane-toast-beta-windows-x64`, ID `13227335847`; embedded evidence identifies the same source commit.
- SHA-256, individually recomputed against downloaded CI bytes **both outside and on Leno**:
  - `tetherplane-toast-smoke.exe`: `4241803763EA02E131C600B7B8978F8FEB02428725F541488EFE2597580EC935`
  - `tetherd.exe` (console): `12AF514E0139B35008DBA2F511A99B5C44BB3CF389B2C43D86CE5170ED6BC60D`
  - `tetherd-agentw-beta.exe` (GUI): `A2ADC280C3F9D2491077BF4FBFFA0EADD3056BBFD38E6535D7E88AFE4FA14C8F`
- Executable PE subsystems independently identified as GUI for the beta candidate and console for `tetherd.exe`.

## Executed synthetic test

The exact CI GUI bytes were copied to a disposable `tetherd.exe` basename required by `Test-TetherplaneToastEventBeta.ps1`; the kit's real synthetic loopback fixture, a disposable device ID `TP_BETA_TEST`, and disposable synthetic JSON arguments file were used. Neither the active agent arguments file nor its credentials were read.

- Reject case: HTTP 401; notification history `30 -> 30`; `BETA_401_NO_NOTIFICATION_VERIFIED`.
- Accepted WebSocket case: test confirmed handshake and tagged `tb-cn` and `tb-uk` event counters each increasing by one; `BETA_LOOPBACK_END_TO_END_VERIFIED`.
- The test script's immediate global history count read `30 -> 31`, but an **independent later Windows WinRT history read** returned **32** entries, including one `tb-cn-488-1a1a154d0ec-0` and one `tb-uk-488-1a1a154d5ff-1`, both in group `tetherplane-beta`, both reporting readable Content. The immediate total-count discrepancy is consistent with asynchronous arrival. Unique tags/groups are the authoritative event check; total-count equivalence is not assumed.
- Temporary registration was removed, no synthetic `tetherd`/relay processes remained, and this run's temporary beta download/extraction directory was removed. Two **pre-existing** older synthetic evidence directories were intentionally retained.
- **NOT TESTED:** visual popup appearance by a human; this run establishes Windows Notification Center history, not human-observed display.

## Protected November 1 Leno baseline after test

- Live process `tetherd-agentw.exe`, PID `15296`; installed SHA-256 `411E0F07F32CA3E6CF69A5CA53F3995E268946DF419600BF0C807D737D00895C` (matches the preexisting read-only readiness expected hash).
- Scheduled task `Tetherplane Private Agent NoConsole 20261101`: Running; last run 2026-11-01 22:15:29 +04:00.
- Independent `device.status` after test: agent version `0.1.0`, authenticated, alive, responsive, ready, background-only.
- No protected task, production executable, argument file, session, or OAuth/DCR setting was modified.

## Gate for real-device automatic notifications

**NO-GO for protected replacement.** Two legacy rollback scheduled tasks exist, but neither is independently proven to restore the November 1 executable, identity, settings and connectivity. The secondary Remote Desktop Commander path for Leno was offline. Synthetic GUI success cannot establish production recovery or real authenticated automatic alerts. Rehearse an exact-November-1 rollback through an independently verified control path and obtain explicit owner approval before any protected change. Do not assume Surface, Vaulter or RTX are proven by this Leno test.

**Next smallest intervention:** establish an independent Leno recovery/control channel and a non-disruptive exact-version rollback rehearsal before proposing a one-device notification integration.