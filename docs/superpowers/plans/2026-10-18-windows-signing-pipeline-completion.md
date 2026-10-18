# Windows signing pipeline completion

> **For agentic workers:** Use `superpowers:executing-plans` with TDD and an independent final review. Preserve the recovered work at `630b3093666d6a172151590e0ec5950a47dcbff9`.

**Goal:** Produce independently verified, provider-neutral Windows signed candidates and a safe managed-file upgrade path, without changing Windows security or live device state.

**Architecture:** A clean hosted builder prepares a fixed executable/script signing request. A separately provisioned and approved signing runner invokes an externally installed, hash-pinned provider adapter. A new hosted Windows verifier validates every signature, creates final manifests and ZIPs after signing, and exercises the received kit. The local installer enforces caller-supplied trust requirements and preserves installation state during upgrades.

**Tech Stack:** PowerShell 5.1 and 7, Pester 3.4/4.10.1, Windows Authenticode/SignTool, GitHub Actions, existing Rust and pnpm gates.

**Spec:** `docs/superpowers/specs/2026-09-17-tetherplane-design.md`; user continuation dated 2026-10-18; predecessor `2026-10-18-windows-public-trust-signing.md`.

## Global constraints

- Exactly six tools: `device`, `files`, `process`, `browser`, `desktop`, `batch`.
- `background_only`; local agent remains the final policy authority.
- No Smart App Control bypass, certificate-root import, key export, signing credential in GitHub, purchase, enrollment, relay/OAuth change, live task restart, merge or release publication.
- Preserve the deliberately unsigned development workflow and distinguish its artifacts from signed candidates.
- Production verification requires external publisher and certificate pins; artifact metadata cannot supply its own trust anchor.
- Live Leno acceptance with Smart App Control On remains required before Surface pairing.

## Recovery and scope

The recovered branch contains eight signing commits and draft PR #16. Its existing CI is green at `630b309`; no real signing workflow or signed binary exists. The native Leno status call returned `disconnected`; RDC reports zero remaining calls. A fresh GitHub clone is isolated from Leno, whose uncommitted state cannot be inspected. Continue the existing branch and push verified changes; do not claim local Leno execution.

## Review focus

1. A caller requires signing but an attacker removes signing metadata and recomputes checksums: reject before any write or package-code execution.
2. A ZIP contains modified setup/supervisor code: authenticate all executable code using the trusted verifier before loading package code.
3. A signing adapter fails, reports a warning, changes an unexpected path, or receives a forged request: no signed candidate is emitted and adapter output cannot leak secrets.
4. A managed file was edited, locked, or changed during an upgrade: preserve human changes and recover the prior managed bytes and receipt on failure.
5. A signing certificate is timestamp-valid but expired now: rely on Windows timestamp-aware verification, never a naive current-date expiration comparison; require an approved identity, code-signing usage and timestamp.

## Task 1: Enforce independent signed-package policy

**Files:** `scripts/setup-windows-device.ps1`, `scripts/verify-windows-device-kit.ps1`, `tests/onboarding/windows-onboarding-signing.Tests.ps1`.

**Interfaces:** Add and consistently forward `RequireTrustedSignature` and `ExpectedSignerThumbprint` alongside `ExpectedPublisherSubject`. Explicit publisher/pin inputs imply a signed package is required. The v2 signed schema covers `bin/tetherd.exe`, `launch/tetherplane-agent.ps1`, and setup/pair/doctor scripts. `Assert-TrustedDeviceSignature` validates Windows trust, embedded signature, exact subject, certificate fingerprint, code-signing EKU and timestamp metadata.

- [x] Add behavioral regressions for metadata removal, independent fingerprint mismatch, unsigned scripts, invalid/untrusted signatures and missing EKU/timestamp.
- [x] Witness the intended failures before changing production code.
- [x] Load verifier functions from the trusted checkout, never the downloaded ZIP; preserve caller pins across dot-sourcing.
- [x] Add a verification-only mode that authenticates the archive without executing its code; full verification follows only after authentication.
- [x] Run focused Pester tests and preserve RED/GREEN logs.

## Task 2: Build, sign and independently verify candidates

**Files:** `scripts/new-windows-signing-request.ps1`, `scripts/invoke-windows-signing-adapter.ps1`, `.github/workflows/windows-trusted-signing.yml`, `scripts/package-windows-device-kit.ps1`, `tests/onboarding/windows-signing-pipeline.Tests.ps1`, `.github/workflows/windows-signature-policy.yml`.

**Interfaces:** The unsigned request is a fixed five-file payload with source commit, relative file names, full SHA-256 and native Windows SIP content digests, and a separately carried request SHA-256. The signed content must equal the approved request even when the provider uses the correct certificate. The signing adapter receives a single literal file path and an approved timestamp URL, uses a key held in its existing service/hardware, and must return exit 0. Its path and SHA-256 are independently provisioned. The package builder accepts an authenticated signed payload directory and exact publisher/fingerprint, signs nothing itself, and writes final hashes only after validating every staged code file. SignTool verification uses `verify /pa /all /tw` and accepts only exit 0.

- [x] Test request allowlist, hashes, source binding, duplicate/path traversal rejection, adapter identity, adapter failure/output suppression, unchanged-input preservation and fail-closed output behavior.
- [x] Witness failures, implement the smallest pipeline helpers, then pass focused tests.
- [x] Create a manual-only workflow restricted to the reviewed `main` revision, with an explicit readiness preflight and protected signing environment. Do not run it before provider approval/provisioning.
- [x] Keep build and final Windows verification on hosted runners; the signing runner is separately provisioned, dedicated and ephemeral, and runs no artifact-provided code.
- [x] Implement signed candidate ZIP generation only after signature checks and independent hosted verification, with immutable candidate uploads and no release/tag/deployment.
- [x] Update existing fast policy CI to exercise new suites on Windows PowerShell 5.1 and PowerShell 7.

## Task 3: Preserve and roll back managed upgrades

**Files:** `scripts/setup-windows-device.ps1`, `tests/onboarding/windows-onboarding-upgrade.Tests.ps1`.

**Interfaces:** New receipts record every managed-file digest and signed trust policy. A repair validates existing file hashes before replacement, stages and verifies candidate files, keeps an owned backup, then updates the receipt last. Missing files can be repaired. Unknown files, device state and agent arguments are untouched. A legacy receipt without sufficient file evidence fails with a preservation instruction instead of silently adopting the prefix. A signed installation cannot silently downgrade to unsigned.

- [x] Test modified managed files, missing-file repair, locked/failed copy after one successful replacement, original receipt/config preservation, signed-to-unsigned downgrade and valid upgrade preservation.
- [x] Witness failures, implement transaction/rollback, and run the full relevant Pester suites.
- [x] Document retained-backup recovery for process interruption and legacy Leno's separately verified binary-only deployment; do not deploy automatically.

## Task 4: Verification, documentation and durable handoff

**Files:** `docs/onboarding/WINDOWS-CODE-SIGNING.md`, `docs/onboarding/SIGNING-RECOVERY-20261018.md`, this plan.

- [x] Run fresh Rust format, Clippy, workspace tests, TypeScript typecheck/test/build, unsafe scan and diff hygiene; report every unsupported/platform-blocked gate accurately.
- [x] Independently review the whole signing change; fix concrete important findings using RED/GREEN tests.
- [x] Commit verified changes to the recovered feature branch, push without rewriting history and inspect Windows/Linux CI logs at the exact pushed SHA.
- [x] Preserve the existing draft PR/base; record final evidence in the repository. Do not send comments or external messages.
- [x] Report signing identity, protected runner/environment setup, real Authenticode/SAC acceptance and Surface pairing as blocked until genuinely performed.

## Execution rulings

- Use the fresh, clean GitHub feature-branch checkout as the isolated execution workspace; Leno is offline. Risk: unpushed Leno-only work remains unknown, so it must be reconciled before local synchronization.
- Keep the predecessor commits and historical evidence. Tests during this continuation are fresh evidence only for the behavior actually exercised.
- Keep production signing disabled until a provider and any costs/enrollment are explicitly approved. YAML alone does not provision or prove environment protection.

## Additional review findings and rulings

- The independently approved request now binds native SIP content digests, so
  older or different code signed by the same certificate cannot be labeled with
  the newly selected source revision. The native boundary uses Windows SIP,
  with no portable raw-hash fallback. Windows CI must run the native fixtures.
- ZIP hashing and extraction now retain the same read-only file handle. A
  witnessed archive-substitution regression is green (15/15 policy cases).
- PowerShell Core uses unchanged Pester 4.10.1; Desktop retains 3.4.0. The Core
  runner's own child-process success/failure/empty/inconclusive tests are green.
- A reviewer reproduced a write between the final destination hash and atomic
  replacement. Three additional regressions failed before the fix; all 15
  upgrade tests now pass. Actual displaced bytes are retained during replacement
  and rollback, and their expected hashes survive journal interruption.
- Available local gates run before committing. Required native Windows, full
  browser and Docker checks run on the pushed branch, because those platforms
  are unavailable in the execution container. A platform-blocked gate is not
  a pass; branch acceptance requires inspection of the exact-revision CI.

## Completed engineering checkpoint

Implementation revision `8415ee030f45519ce00f5293842b2b10439557f8` is pushed.
Fresh [push CI](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39100886687)
and [PR CI](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39100889531)
are successful. Windows policy passed 94/94 on each of PowerShell 5.1 and 7;
full onboarding passed 143/143 with no unrun tests. The real Windows kit and
six-tool/package smoke checks passed, and required Chromium callbacks passed
10/10 on each OS. Linux production Docker builds passed. Existing Node
platform/opt-in skips and local container limitations are recorded separately.

Native Windows testing first exposed `NTE_BAD_ALGID` for the script SHA-256 SIP.
The observed regression was fixed with an explicit hashing-only provider
context; native pipeline tests then passed 39/39 on both engines. Pester 3/4
fixture portability was corrected without removing race assertions. The final
independent review found no remaining concrete must-fix issue.

The final handoff updates documentation only. Exact source, run/job links,
counts, developer artifact hash, witnessed RED/GREEN evidence and remaining
operational dependencies are in
[`SIGNING-RECOVERY-20261018.md`](../../onboarding/SIGNING-RECOVERY-20261018.md).
The latest authenticated Leno check at approximately 05:44 UTC remains offline.
No trusted Tetherplane candidate, live SAC acceptance, Leno restoration or
Surface pairing is claimed by completion of these engineering tasks.
