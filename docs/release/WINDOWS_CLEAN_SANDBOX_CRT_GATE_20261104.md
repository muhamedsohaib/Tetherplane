# Windows 10 Sandbox native dependency failure — 2026-11-04

## Observed clean-guest failure (user-supplied, not a local build)

The owner ran the `Tetherplane-Surface-Sandbox-Native-CMD-Baseline` test inside Surface's existing Windows Sandbox on Windows 10, user `WDAGUtilityAccount`. No Surface host configuration was changed.

- First PowerShell-based kit: blocked **before executing** by guest execution policy (`PSSecurityException`). This is a distinct constraint from binary runtime loading.
- Replacement CMD-native kit: downloaded the historical public `v0.1.0` ZIP, verified the SHA-256, extracted it and staged the portable binary. Download plus hash **3590 ms**; this is **not** an end-to-end install, login or first-operation time.
- Guest displayed `tetherd.exe - System Error`: `VCRUNTIME140.dll was not found`.
- Test result: `FAILURE=NATIVE_DEVICE_STATUS_RESPONSE_MISSING`, `RESULT=BLOCKED_OR_FAILED`.
- Report indicates scratch cleanup passed and a disposable-state sentinel survived. Installer/uninstall, remote pairing, and full authentication remained **NOT_TESTED**.

## Independent source and artifact verification from Leno

- Official release `v0.1.0` package `Tetherplane-Windows-x64.zip` downloaded from GitHub into **only a disposable Leno temporary directory**, SHA-256 verified against the GitHub asset digest:
  `c909cdd78ac786ea2bcb4853841db9d52928c8ae54a99e3306c945aba1066e9c`.
- Extracted `bin/tetherd.exe` (7,227,392 bytes) SHA-256:
  `4f06b70ca4eefb2c1c5cfb70da71e1da45d02ece54d3f96b1220e16edcb2102a`.
- The new **non-executing** PE import inspection read the original agent import directory and found **22 DLL imports, including `vcruntime140.dll`**.
- The missing DLL is therefore a reproducible packaging/runtime dependency, rather than an inference from a generic status timeout. This does not prove there are no additional guest prerequisites.

## Isolated release-candidate correction (not published)

Branch: `fix/windows-portable-msvc-crt-20261104`, based on the clean toast feature worktree at `c601a7f05bbc89a307fb073709cd13097709d7b2`.

- Build Rust Windows release binaries using the supported `-C target-feature=+crt-static` configuration. Scope the flag to the release build and restore previous `RUSTFLAGS`.
- Add `scripts/windows/check-pe-runtime-imports.mjs` to inspect both ordinary and delay-loaded imports and refuse standalone executables importing `VCRUNTIME*.dll`, `MSVCP*.dll` or related dynamically linked MSVC libraries.
- Fail closed in `scripts/package-windows.ps1` **before** altering existing staging output. Ensure `-SkipBuild` does not silently package a stale incompatible agent.
- Gate the Windows CI release-binary build and installed-agent smoke, plus all native toast developer-beta CI executables.
- Fail `Build-TetherplaneToastBetaKit.ps1` on historical CI artifacts requiring missing MSVC runtime DLLs. The old diagnostic ZIP must not be relabeled as portable.

## Evidence

- Synthetic PE regression suite validates accepting standard Windows DLLs, rejecting `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`, `MSVCP140.dll`, delayed imports, corruption, and CLI exit codes.
- An independent test of the **old pinned toast CI binary** against the new builder returned `BETA_KIT_DYNAMIC_VC_RUNTIME_DEPENDENCY` and **did not create an output ZIP**.
- PowerShell syntax and Git whitespace verification required.
- **Windows CI compilation with `+crt-static` remains UNVERIFIED.** Source tests alone do not prove linking compatibility or that a new guest can run the new binary.
- **No new Windows Sandbox installation test has passed.** No host config, registry, authentication, startup task, Code Integrity, execution policy, device secrets, or protected running agents were modified.

## Operational and maintenance trade-off

Static CRT linkage removes a prerequisite but embeds CRT code, so security fixes to the CRT may require a new release; treat dependency updates and rebuild cadence as part of release maintenance. Microsoft generally recommends a centrally installed Visual C++ Redistributable for servicing, but such a prerequisite would add admin/setup friction and does not meet the present portable developer-beta objective. Do **not** copy Microsoft runtime DLLs into the ZIP without reviewing the relevant redistribution license and servicing obligations.

## Next release gate

1. Owner explicitly approves **pushing this isolated nonprotected branch** and a hosted Windows CI test. Do not merge or publish automatically.
2. CI compiles the candidate with static CRT and scans each actual PE import table. Confirm no missing native dependencies and build logs match the exact source SHA.
3. Copy the **new candidate artifact** (not public `v0.1.0`) into the already authorized Surface Windows 10 Sandbox. Preserve normal guest execution policy; prefer a native/CMD first-run path instead of a `.ps1` launch.
4. Record a real agent `device.status`, local MCP operations, denied access, teardown and fresh-guest repetition; measure all elapsed stages independently. Verify the complete onboarding path with permitted authentication before claiming the **30-second connection target**.
5. Keep protected `main` release guards, installed agent, Surface host, RTX and production OAuth untouched. Production or public release remains NO-GO until candidate-specific acceptance and explicit owner approval.

## Hosted Windows validation and packaging correction (2026-11-04)

- Pushed isolated commit `5b8349ac4418e1879954424eaec6184996b4c21d` to `fix/windows-portable-msvc-crt-20261104`. No merge, tag, publication, identity, host-security or installed-agent change.
- GitHub main CI [run 41794858763](https://github.com/muhamedsohaib/Tetherplane/actions/runs/41794858763) completed **SUCCESS** across independent release-policy, Ubuntu quality and Windows quality jobs.
- Hosted Windows `tetherd.exe`: `PE_RUNTIME_IMPORT_AUDIT` found 15 imported DLLs, **zero dynamic VC++ CRT imports**, `portableRuntimeCheck=PASS`.
- That same hosted Windows CI performed a separate packaged binary check, `SIX_TOOL_SMOKE_OK`, and completed disposable `WINDOWS_PACKAGE_SMOKE_OK` for package/install/uninstall.
- Toast [run 41794858757](https://github.com/muhamedsohaib/Tetherplane/actions/runs/41794858757) compiled all three native candidates and passed its runtime import checks, but the final test ZIP assembly failed at checksum verification. Its error referenced `verification\\ge\\assets\\windows\\icon-provenance.json`; the stage-relative string calculation was not robust to differing canonical directory representations.
- Small source correction: derive relative paths from a canonical `Get-Item().FullName` stage prefix; explicitly verify stage containment, refuse empty/parent-relative paths, and test the actual Windows path calculation. The corrected packager requires a fresh CI run.
- **Do not treat CI as clean-guest acceptance:** the Surface Windows 10 Sandbox originally lacked `VCRUNTIME140.dll` and must rerun with the exact corrected candidate before publishing or claiming under-30-second onboarding.

## Owner-operated Windows 10 Sandbox CRT canary — PASSED (reported 2026-11-04)

**Evidence origin:** Owner pasted the stdout report from the existing Surface Windows Sandbox. This is user-supplied test output, not a directly inspected log from the isolated guest. Do not claim independent collection via the Surface host agent.

- `TEST=TETHERPLANE_SURFACE_SANDBOX_PORTABLE_CRT_CANARY`
- `GUEST_ACCOUNT=WDAGUtilityAccount`
- `SOURCE_COMMIT=eaf2c8a2f63228812409233487d0f9acf7ecae07`
- `CI_RUN=41796216267`
- `CI_KIT_SHA256=VERIFIED`
- `PINNED_AGENT_SHA256=VERIFIED`
- `PORTABLE_NATIVE_STATUS=PASS`
- `HASH_VERIFY_TO_FIRST_LOCAL_STATUS_MS=470`
- `OUTSIDE_ALLOW_FILESYSTEM=DENIED_AS_EXPECTED`
- `RESULT=PASS_PORTABLE_CRT_ONLY_REMOTE_AUTH_UNTESTED`
- `PORTABLE_STAGE_CLEANUP=PASS`
- `Exit code: 0`
- `HOST_CONFIG=NOT_MODIFIED_BY_SCRIPT`
- `POWERSHELL_SCRIPTS=NOT_EXECUTED`
- `PUBLIC_RELEASE=NOT_CREATED`

**Conclusion:** The clean Windows 10 guest no longer reports the historical `VCRUNTIME140.dll` load failure when starting this exact CI-pinned portable test agent. Local status, one access-denial boundary and scratch cleanup passed. The `470 ms` starts at hash verification and ends at local `device.status`: it is **not** the download-to-install-to-OAuth-to-first-operation time.

**Unverified:** `FULL_INSTALLER=NOT_TESTED`, `REMOTE_AUTHENTICATION=NOT_TESTED`, `TOAST_UI=NOT_TESTED`; no real remote pairing, five-run onboarding distribution, Windows 11 clean-install acceptance or authenticated first-use elapsed measurement. Preserve the GitHub protected release lane and original four-device authorization boundary. Next gate: test the full candidate installer on a fresh authorized guest through explicit user authorization and the first successful remote MCP operation, with independent access-denial and rollback checks.
