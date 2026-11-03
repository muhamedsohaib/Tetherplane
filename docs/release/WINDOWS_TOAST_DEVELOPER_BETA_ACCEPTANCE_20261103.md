# Tetherplane Windows Notification Developer Beta — Acceptance Record

Date: 2026-11-03 (Asia/Dubai)
Status: **LOCAL DEVELOPER-BETA ACCEPTED** on Leno; **NOT** a released/signed Windows application or a validated four-device deployment.

## Exact source and CI artifact

- Repository: `https://github.com/muhamedsohaib/Tetherplane`
- Draft branch: `feature/windows-toast-notifications-design-20261103`
- Accepted application-source commit: `acd461495a9ae9c7108f3ccb5c7ae4a2963fa64c`
- Focused Windows CI: `https://github.com/muhamedsohaib/Tetherplane/actions/runs/41611922395` — **success**
- Build artifact: `tetherplane-toast-beta-windows-x64` (7-day retention; private CI artifact, not a public release).
- `tetherplane-toast-smoke.exe` SHA-256: `65FB0203DF5A585C0BC95C29F7EB65C3C3F4421FC421E2ADAB2D8A2307DEB243`.
- `tetherd.exe` opt-in beta SHA-256: `36170A11BEB146EE271A015358EE86644F4A88E1A6C5D452519E7E60521BAEED`.
- Both hashes on Leno independently matched the CI build-evidence file.

## Test evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| Windows notification Rust unit suite | PASS | 18 tests on beta feature during hosted Windows CI |
| Authenticated WebSocket 101 test | PASS | Windows hosted isolated integration test |
| HTTP 401 authorization-denial test | PASS | Windows hosted isolated integration test |
| Strict Rust clippy / rustfmt | PASS | Focused Windows workflow on accepted commit |
| Source/feature boundary contracts | PASS | 4 Node source-regression tests |
| Native Rust `--smoke --developer-beta` on Leno | PASS | Windows toast history count 1 → 2, expected dispatch result |
| Mock relay HTTP 401 on Leno | PASS | history 2 → 2, server rejection and agent's HTTP 401 observed |
| Mock relay WebSocket 101 on Leno | PASS | history 2 → 3, `TP_BETA_TEST connected` XML independently read |
| Second mock relay HTTP 401 on Leno | PASS | history 3 → 3, no notification |
| Mock relay connection and teardown on Leno | PASS | history 3 → 5, exactly one additional `TP_BETA_TEST connected` and one `TP_BETA_TEST status unknown` recorded |
| Temporary per-user shortcut cleanup | PASS | `BETA_TOAST_SHORTCUT_REMOVED` after each local acceptance |
| Human observation of popup | UNKNOWN | Windows history is authoritative for stored notification, not visual popup |
| Existing Leno/VAULTER/Surface/RTX agents replaced | NO | All tests used an isolated beta binary with synthetic loopback host only |

## Security and behavioral contract

1. No Store identity, MSIX, install-time startup, extra OAuth client, protected merge, security-policy modification, or privilege escalation.
2. Default `tetherd` remains unchanged: notification consumer is compiled only behind feature `developer-beta-notification-feed` and started only by explicit `--dev-beta-local-toasts` in relay mode.
3. Notification source is an **in-process, bounded event channel**; there is **no external IPC listener**, so no newly exposed command or authentication surface.
4. Device-connected event originates after the existing successful device WebSocket upgrade. HTTP 401/403 has no session-success event.
5. Local transport loss emits `status unknown`, never a false relay-confirmed `offline`; allowlist, dedupe, staleness and replay checks are enforced in `NotificationPolicy`.
6. Toasts are text-only, do not focus windows or automate desktop UI, and have no approval buttons.
7. Credentials in all acceptance fixtures are fixed public synthetic strings, used only against loopback `127.0.0.1` — no production Tetherplane credential or customer data is used.
8. The developer-beta AUMID `ARCUSLabs.Tetherplane.DevBeta` is a Windows presentation label, not a Tetherplane authorization principal.

## Reproducing locally on a Windows user session

Download the exact GitHub Actions artifact from the recorded run. Verify the two SHA-256 checksums above against the `toast-beta-build-evidence.txt` file. From this repository worktree, run the following (no admin privileges required):

```powershell
.\scripts\windows\Test-TetherplaneToastBeta.ps1 -ToastExecutable 'PATH_TO\tetherplane-toast-smoke.exe' -ExpectedSha256 '65FB0203DF5A585C0BC95C29F7EB65C3C3F4421FC421E2ADAB2D8A2307DEB243'
.\scripts\windows\Test-TetherplaneToastEventBeta.ps1 -ToastExecutable 'PATH_TO\tetherplane-toast-smoke.exe' -AgentExecutable 'PATH_TO\tetherd.exe'
```

Both scripts default to temporary per-user registration and remove it after acceptance. The event test uses a disposable fake loopback relay and separately spawned beta `tetherd.exe`. It must **not** be used as a second live agent for the same production device ID.

To register the smoke-test entry explicitly (opt-in):

```powershell
.\scripts\windows\Register-TetherplaneToastBeta.ps1 -Operation Register -Executable 'PATH_TO\tetherplane-toast-smoke.exe'
# Roll back:
.\scripts\windows\Register-TetherplaneToastBeta.ps1 -Operation Unregister
```

The startup command `--dev-beta-local-toasts` is **only** for a separately authorized, user-session developer beta agent and must not silently modify existing agent startup arguments or replace any running Tetherplane agent.

## Remaining boundaries

**Not yet proven:** live owner-account multi-device presence, pairing and approval event ingestion, owner-review activation, four-device recovery, a signed distributable, true clean-device install, and human-visible popup presentation. The local beta provides independently verified notification transport only. Do not elevate this to Store or general distribution readiness without those gates.

Leno Rust compiler code-integrity restrictions remain unchanged. Vaulter's existing Rust GNU/LLVM import-library limitations also remain unchanged; official Windows CI provides the supported reproducible build lane.

## Portable beta kit — complete, independently extracted and re-tested on Leno

- ZIP (Leno Downloads): `C:\Users\Sohaib\Downloads\Tetherplane-Toast-Developer-Beta-acd4614-20261103.zip`.
- ZIP SHA-256: `03D859400CE6A7B36557A762CD4EC3B156DF79851A72F445E8E7FEC3F09A5661`.
- ZIP size: **3,032,270 bytes**. After expansion into a new temporary directory, **11 files** were verified, including both executables with SHA-256 matches to the signed-in GitHub Actions build evidence.
- Included: `README.txt`, `TEST TOAST.cmd`, `TEST CONNECTION TOAST.cmd`, `bin\tetherplane-toast-smoke.exe`, `bin\tetherd.exe`, the per-user registration helper, both acceptance scripts, `windows-toast-loopback-relay.mjs`, `docs\ACCEPTANCE.md`, and CI build evidence.
- Independent extracted-kit execution: `Test-TetherplaneToastBeta.ps1` produced `TOAST_DISPATCH_ACCEPTED_VISIBILITY_UNVERIFIED`; Notification Center history **5 → 6**.
- Independent extracted-kit event test: HTTP 401 history **6 → 6** (no new notification), followed by authenticated test WebSocket 101 history **6 → 8**, exactly **1 new `TP_BETA_TEST connected`** and **1 new `TP_BETA_TEST status unknown`**.
- Temporary per-user shortcut and extracted staging directory were removed by the test and verified absent. A normal, unrelated installed Tetherplane device agent was not stopped or replaced. Stored historical beta notification entries remain in Windows Notification Center.
- Core repository CI for `acd461495a9ae9c7108f3ccb5c7ae4a2963fa64c`: run `41611922217` **completed successfully** with release-policy, Ubuntu quality, and Windows quality jobs all green. Focused beta build CI `41611922395` also **completed successfully**.
- This ZIP is a **local developer-beta test artifact**, neither a signed production executable nor a one-click installation of a persistent real-device notification service. Do not mistake synthetic loopback acceptance or stored toast history for four-device reliability or a human-confirmed visible popup.
