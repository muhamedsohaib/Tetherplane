# Windows UIA role normalization and PR #15 final readiness — 2026-10-18

## Scope and source of truth
Continue draft PR #15 at `ed50ee3b02a41e6cf3101887bc300ac9ba036078`. Follow the canonical 2026-09-17 design, roadmap and local-core plan. Target only Leno and its existing isolated worktree; preserve the installed agent and `background_only` policy. The previous source-bearing OAuth acceptance and exact-head 4/4 hosted CI pass are established evidence, not a license to merge or release.

## Observed issue
A Leno-local `cargo test --workspace` failed `windows_uia_worker_starts_and_returns_a_bounded_semantic_snapshot` because a returned UIA node had an empty role. `describe_element` currently substitutes `unknown` on `get_localized_control_type()` error but leaves `Ok("")` unchanged. This is a candidate root cause; prove it with a synthetic failing regression before the smallest source change.

## TDD and verification steps
1. Add a role normalization unit regression for missing, empty and whitespace-only localized values; require current source to fail at RED.
2. Normalize only the output role to a non-empty `unknown` fallback while preserving informative localized role strings; leave ownership, identity, input and foreground behavior unchanged.
3. Prove GREEN for unit tests; run the real **read-only** UIA snapshot integration test on Leno without foreground interaction; avoid dumping human window titles or sensitive UI content.
4. Run Rust format, workspace Clippy and workspace tests, plus safe browser-free Node tests, TypeScript builds/typechecks, unsafe scanner and diff checks. Keep live Chromium execution on GitHub-hosted isolated runners.
5. Review the PR's changed code and documented release gates, separately identifying security and human-coexistence risks. Treat the operator-active UIA measurement as waived, never passed.
6. Stage only verified files, commit to the existing feature branch, push without rewriting history and obtain exact-head hosted Windows/Ubuntu quality and Chromium logs. Keep PR #15 draft/unmerged.

## Hold points
Do not perform foreground control, touch another device, deploy, merge or approve a release. Clean-device installation and any new live operator-active measurement require separate eligible execution conditions; this plan records their disposition without declaring them passed.

## Result
Pending fresh RED/GREEN, release checks and hosted evidence.

## Verified RED -> GREEN: Windows UIA role metadata

On Leno, the new `role_normalization_tests` failed at RED with Rust E0432 because `normalized_role` was missing. The minimum source change now reads the optional localized control type and substitutes `unknown` for missing, empty or whitespace-only strings; informative values are preserved without altering actuation APIs. Two unit tests passed at GREEN. The original read-only `cargo test -p tether-desktop-provider --test windows_uia` also passed **2/2**, including the prior empty-role assertion. No foreground lease, synthetic mouse/keyboard event, clipboard mutation, user window activation, installed-agent change or unrelated device was involved.

## Review and acceptance boundaries

- PR #15 spans 122 files against `main`. The registered GitHub review list and review-thread list were both empty when checked on 2026-10-18. A code scan here is an **internal preliminary audit**, not the independent PR-wide review or release approval.
- Related draft PR #14 also remains open and unmerged. Do not merge either PR as part of this task.
- The 2026-10-17 operator-active overlap waiver is explicitly scoped to its earlier reviewed provider baseline and documentation-only descendants. This new change modifies **read-only desktop role metadata** but no action/ownership/foreground logic; record a specific waiver-scope reassessment before counting it for release. The missing instrumented operator-overlap pass is still **waived/not passed**. No live operator test is requested here.
- Hosted OAuth callback acceptance and full CI previously passed at `ed50ee3`, but a fresh exact-head CI run is required after any source commit. Clean-device Windows lifecycle and external independent approval remain held.

## Local gate execution caveat

The first broad local verification executed Rust workspace tests and 45-file browser-free relay tests concurrently on Leno. Rust fmt and Clippy passed; the original Windows UIA snapshot test **passed inside the full run** (2/2), but two separate process-provider tests failed timing/output assertions during contention. The relay sweep reported 149 PASS / 5 FAIL from CDP socket timeouts and pairing HTTP deadlines while under concurrent load. TypeScript workspace build/typecheck, authored unsafe scan, and diff hygiene passed. This run must **not** be described as a clean local workspace gate. A standalone process-provider rerun was started for diagnosis; retain exact failing evidence rather than extending deadlines or rewriting assertions. The final hosted CI matrix is the required cross-platform gate for any committed candidate.

## Release-continuation results — 2026-10-18

At source commit `6d52807f3e35a17a9ba07be7d6462d9383b395cd`, [GitHub CI #832](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39071472506) passed all four required jobs on one SHA: Windows/Ubuntu quality and Windows/Ubuntu **real Chromium OAuth callback**. Each browser job logged 10 actual named PASS results, zero failures, zero skips and no cleanup errors.

The Leno-local Rust process-provider timing/output failures were isolated rather than suppressed. Three previously failing tests passed when executed individually with unchanged assertions; the 14-test process suite then passed with `--test-threads=1`, and `cargo test --workspace -- --test-threads=1` passed. The browser-free relay suite (45 files, excluding real Chromium execution on Leno) passed **154/154** when it was not competing with Rust tests. This supports local test-runner contention as a cause of the earlier failures but does not prove scheduling invariance under all loads. No production process-provider change, process termination bypass or test-deadline increase was made.

### Confirmed Windows kit packaging issue — RED/GREEN

Internal review of the draft PR #15 source changes also identified that `scripts/package-windows-device-kit.ps1 -Zip` would silently replace an existing `<OutputPath>.zip` and its checksum sidecar, even if they were unrelated human files. The builder could additionally follow an existing redirected/junction `OutputPath` root without rejecting it, despite validating entries *inside* the directory. Only disposable **test-owned** archives and junction targets were used in reproduction.

Three focused Pester tests reproduced the fail-open behavior before the fix (two archive collisions and one root-junction refusal). The narrow correction now rejects existing archive or sidecar paths **before modifying the prior kit directory**, rejects a redirected output-directory root and creates both the ZIP and checksum with `FileMode.CreateNew` to prevent a late-path collision from overwriting another file. An unmodified prior kit directory can still be rebuilt without `-Zip`. For ZIP builds, choose a fresh `-OutputPath`; replacing existing ZIP artifacts requires separately validating their ownership and handling them explicitly. There is no silent overwrite.

After implementation, the focused Windows kit tests passed **10/10, 0 fail**, and the full Pester onboarding suite passed **53/53, 0 fail, 0 skipped, 0 inconclusive** after building a worktree-local `target/release/tetherd.exe` prerequisite. The two earlier full-suite failures were solely caused by that absent candidate binary; no installed Leno agent was replaced. An independent temporary ZIP creation/verification smoke using the candidate binary passed: manifest source commit matched `6d52807`, the SHA-256 matched, the shipped binary answered `device.status`, and default policy remained `background_only`. This precommit ZIP recorded `source_tree_dirty=true` as expected; only a new hosted artifact built from the final clean source SHA can satisfy the immutable-release-candidate requirement.

### Review and authorization hold points

The current review is an **internal risk-focused audit**, not a completed independent review of all 123 changed files in PR #15 and the 15-file dependency PR #14. Both PRs remain draft, and no submitted GitHub review was found at the audit checkpoint. Reconcile the two PRs before any merge to avoid double inclusion or history rewriting. New clean Windows x64 installation, real ChatGPT pairing, policy denial, restart/reboot/reconnect/repair/upgrade/rollback/uninstall and independent PR-wide approval remain separate **unverified** release gates. No approval to use Surface, Vaulter, RTX, a new device, foreground control or the production relay is implied. The operator-active UIA overlap measurement remains **waived, not passed**; reassess the waiver's scope for the later read-only role-normalization source change before release.
