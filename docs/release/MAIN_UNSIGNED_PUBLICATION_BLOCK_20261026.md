# Main unsigned-release safety gate — 2026-10-26

## Exact source
- Device: **Leno** (Windows, Tetherplane agent **0.1.0**, **background_only**).
- Current remote `main`: `5feee084eb24bfd4831ab42840bb5f10dafc8113` (verified by both GitHub and Leno `git ls-remote`).
- Observed `main:.github/workflows/release.yml`: `v*` tag-triggered, `contents: write`, unsigned Windows ZIP construction, `gh release create`, no trusted-signature guard.
- `.github/workflows/windows-trusted-signing.yml` absent from `main`; release-security work remains on draft unmerged branches (#44, #45, #46, #49, #50, #56, #57).

## Safe local correction
- Isolated worktree: `.worktrees/main-unsigned-release-block-20261026`; branch `fix/main-unsigned-release-block-20261026`, based directly on the exact remote `main`.
- Code commit: `175628b6ef73c109ad5ee61912d087320a745285`.
- `.github/workflows/release.yml`: switch to `contents: read`; remove all old build, upload, and publication steps; retain only an unconditional PowerShell `UNSIGNED_PUBLIC_RELEASE_BLOCKED` throw.
- `tests/release/windows-main-publication-block.test.mjs`: Node source contract plus nine in-memory mutations (tag permissions, guard skip, ignored failure, alternative job, added step, extra command, publishing bypass).
- `.github/workflows/ci.yml`: run this Node-only gate on push and PR ahead of dependency installation. No changes to existing protected integrations.

## Native evidence and limits
- BEFORE: Node suite against untouched local `main` failed **0/2, exit 1**, proving guard absent.
- AFTER: Node suite passed **3/3, exit 0**; staged and unstaged `git diff --check` returned **exit 0**.
- Real Leno Windows PowerShell 5.1 executing the guard's throw exited **1**, reporting `UNSIGNED_PUBLIC_RELEASE_BLOCKED` (expected).
- Tests are local source-only: **no** installer run, Scheduled Task registration/mutation, signing dispatch, external publication, daemon change, credential access, or OAuth change.
- The separate complete signing workflow, Windows Application Control, protected environment and actual GitHub CI result for this branch remain **unverified**.

## Residual security gate
**LIVE MAIN STILL HAS THE ORIGINAL RELEASE WORKFLOW until this patch is reviewed and promoted.** A local commit does not protect remote publication.

A tag pushed at an older source revision can still be a distinct exposure because GitHub supports tag-triggered `push` workflows from non-default refs. Independently inspect tag rulesets, who can create/update `v*` tags, and workflow token permissions before claiming complete containment. Configure safeguards only after owner authorization.

**SIGNED PUBLIC RELEASE: NO-GO.** Protected signing provider, approved publisher and runner, candidate verification, independent clean-install/rollback and four-device capability acceptance remain pending.

## Next owner decision
With explicit approval only: push this focused branch, open an emergency PR directly against `main`, verify CI, and merge through protected review. Do not merge the entire feature stack or modify signing identities to solve this separate safety issue.

## Follow-up: isolate release-policy CI from pre-existing Rust Clippy failures
- GitHub PR #58 initial CI run `40271405617` failed on both Windows and Ubuntu at the Rust Clippy stage (Rust 1.99.1). The inherited base tests use `assert!(visible.is_empty())` in `agent/providers/search/src/search_tests.rs:214`; Ubuntu also flags `assert!(!processes.is_empty())` in `agent/providers/process/tests/process.rs:385`. Neither file is part of PR #58.
- On initial run, the source release-policy test was skipped because it followed Clippy inside the `quality` job; therefore the CI failure did not establish that the safety contract itself failed.
- The `.github/workflows/ci.yml` release check has been moved into a **new independent `release-policy` job**, on ubuntu-latest, with read-only contents permission, SHA-pinned checkout/setup-node, and no dependencies on quality or Rust.
- The Node source contract now checks CI-job independence and includes six negative-control mutations against skipped, dependent, ignored-error, disabled-step, missing-test, and writable-token variants. After change: local Node suite **4/4 PASS**; GitHub Actions verification of the updated commit must still be observed.
- Separate Clippy-only branch: `fix/clippy-rust-199-assertions-20261026`, based directly on original `main`. The live Leno local Rust test was blocked by missing MSVC `link.exe`; do not claim native compilation passed there. Verify using GitHub's Linux/Windows CI runners before considering a merge.
- Vercel `tetherplane-pr22-source-preview` failed before build with `NOW_SANDBOX_WORKER_ROOTDIR_NOT_EXIST` for configured `adapters/control-center`. That path does not exist in the checked `main` tree. This is a separate preview-configuration problem, not grounds to change release security or deploy production.
