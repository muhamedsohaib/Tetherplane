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
