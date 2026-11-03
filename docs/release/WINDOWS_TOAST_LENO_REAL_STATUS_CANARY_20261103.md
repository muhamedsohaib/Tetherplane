# Leno real-device Windows toast canary — 2026-11-03

**Outcome:** Real authenticated device-status **snapshot delivery passed** on Leno. Continuous agent-originated notifications remain **unverified**. This is an **unpackaged developer beta**, not a production app or replacement for the currently installed private agent.

## Actual verified observations

- The existing Tetherplane `device.status(Leno)` request returned `agent_liveness.state=ready`, `transport=authenticated`, `responsiveness=responsive`, `agent_version=0.1.0`, `policy_mode=background_only`.
- Verified snapshot time supplied immediately following that authorized request: **2026-11-03T10:33:56.087Z** (14:33:56 UAE).
- Without launching or restarting a device agent, `scripts/windows/Test-LenoVerifiedStatusToastCanary.ps1` registered a temporary **per-user** `ARCUSLabs.Tetherplane.DevBeta` Start-menu shortcut to the SHA-256-verified beta toast executable, and used Windows WinRT to show a single text-only notification titled **`Tetherplane / Leno - verified snapshot`**.
- Notification Center history independently confirmed **one entry** matching `Tag=status-1793702036-6ce8d72d` and `Group=tetherplane-verified-snapshot`, with explicit text **`One-time check, not continuous monitoring.`**
- The shortcut and new canary scratch directory were removed. An independent subsequent `device.status(Leno)` remained authenticated, ready and responsive. The installed private agent was **not stopped, reconfigured or replaced**. There was no Windows Code Integrity, UAC, OAuth, credential, scheduled-task, or Store/MSIX change.
- Negative test cases rejected a deliberately incorrect kit checksum and status evidence older than 90 seconds **before** any beta shortcut was created.
- Beta kit source: `C:\Users\Sohaib\Downloads\Tetherplane-Toast-Developer-Beta-bcf18e4-20261103.zip`, SHA-256 `F0160E1D261D8D5F59A1383DE56E09C9540DBE832D2C67EB844E73F6B5C07AB8`, built by GitHub Actions run `41617500886`, commit `bcf18e428e26c7501331d0503b9aa5b3bfca8753`. Core repository CI run `41617500964` also passed for this predecessor commit.

**Evidence limitation:** The notification content originated from a **manual authorized Tetherplane MCP query**, not a locally authenticated, continuously subscribed device-event stream. The canary script accepts status parameters provided by the operator. Its `SOURCE` label is not a cryptographic assertion of data provenance. Notification Center history establishes stored delivery, not visual confirmation of a popup.

## Observed installed agent boundary

- Active Leno process: `tetherd-agentw.exe` (GUI/no-console; installed 2026-11-01); original SHA-256 `411E0F07F32CA3E6CF69A5CA53F3995E268946DF419600BF0C807D737D00895C`.
- Task `Tetherplane Private Agent NoConsole 20261101`: **Running**, `RunLevel=Highest`, interactive logon; task invokes `tetherd-agentw.exe --arguments-file [protected path]`.
- Task `Tetherplane Emergency Relay`: **Running**. This proves task state only, **not independent recovery acceptance**.
- Existing Leno rollback tasks are from **2026-10-23**, preceding the private November 1 agent. They have **not** been demonstrated to restore the current deployment. Leno's Remote Desktop Commander route is offline; therefore no independent second control path was established.
- The task's current arguments-file has **JSON array** shape, with option names including `--relay-url`, `--device-id`, `--device-credential-file`, `--allow`, `--principal-profile`, `--state-dir`. Only format, flag names and file metadata were inspected locally. File contents, values, paths and credentials were **not printed, copied or placed into the repository**.
- Existing Windows beta `tetherd.exe` from commit `bcf18e4` **rejected** a disposable `--arguments-file` fixture with exit **2** and `unknown tetherd argument: --arguments-file`. It is therefore **not drop-in compatible** with the running task.

## Smallest safe implementation in this draft

The draft-only `developer-beta-notification-feed` Windows Cargo feature now includes a **bounded JSON-array arguments-file compatibility loader** for the existing private launcher contract, with **synthetic** tests. It rejects nested files, non-absolute paths, reparse points, oversize content, malformed input, duplicated security-sensitive options, and arbitrary CLI override arguments. The optional `--dev-beta-local-toasts` switch must be explicitly supplied. Unknown argument values are no longer echoed in error messages.

This code was **not** used against the live private agent config, installed, started under the live identity, or merged. It must pass hosted Windows compilation, lint, regression and explicit synthetic CLI tests before it is considered a viable candidate.

## Remaining canary/release gates

1. Hosted Windows CI must validate the new argument-file loader, alongside the existing 101/401 tests, strict lint, and native toast tests.
2. Confirm parity with the **GUI-subsystem no-console** launcher (`tetherd-agentw.exe`), not just the console `tetherd.exe`. Verify flag semantics without copying or revealing the live credential file.
3. Independently test a rollback path that actually restores the **November 1** private agent and authenticated relay connection. A scheduled task merely marked Ready is not sufficient.
4. Only then prepare a tightly bounded, explicit-owner-opt-in real-agent canary, with a known maintenance window and zero duplicate agents. Preserve current identity, authorization boundaries, device architecture and startup configuration until all preconditions are verified.
5. Confirm actual live connection/change alerts, unknown/reconnect, denied authorizations, Windows history and human-visible presentation, then test VAULTER, Surface and RTX separately. No Store certification is required for this developer-beta stage.

**Disposition:** Do not change the running Leno task or launch another agent using its device identity. Real status-to-toast snapshot passed; continuous authenticated event-to-toast canary is **NO-GO** pending source compatibility and independently verified rollback.
