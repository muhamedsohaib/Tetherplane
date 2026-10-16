# Agensi Starter Publication Package Completion Plan

> **For agentic workers:** Use the existing free-starter implementation plan and verification-before-completion. All execution targets Leno explicitly.

**Goal:** Finish a reviewable, versioned free Starter package and push its verified branch without publication.
**Architecture:** Instructions-only skill; no kernel/provider/adapter/transport/policy changes. Local policy and background_only remain authoritative.
**Tech Stack:** Existing Python ZIP packager/tests, Rust/pnpm repository gates, Markdown, SHA-256.
**Spec:** docs/superpowers/specs/2026-10-14-open-source-commercial-distribution-design.md

## Constraints and baseline
- Reuse C:\Users\Sohaib\source\Tetherplane\.worktrees\agensi-starter-release-20261016.
- Branch feature/open-source-commercial-model-20261014 begins at ad2542abc84fcdb6f336919e86b561d588784bce.
- Preserve existing listing-evidence edits and all dirty canonical checkout/index state.
- Read canonical September 17 design, roadmap, local-core plan and October 14 Starter plan.
- No merge, tag, marketplace submission/publication, email, Stripe setup, VM provisioning or spending.
- Leno only; preserve connections, human resources, clipboard, focus and foreground.
- Model invocation and clean consumer installation remain unverified unless separately demonstrated.
- Existing successful CI: PR 38952769626 and push 38952762299, five jobs each; no retained artifact.

## Task 1: Package integrity (strict TDD)
Files: scripts/package_starter_skill.py; tests/skills/test_starter_package.py.
- [ ] Reproduce output collision in a temporary fixture, never against real source.
- [ ] Add failing test: output equal to LICENSE or another existing source refuses overwrite and preserves bytes.
- [ ] Add failing test: an existing output artifact is not silently overwritten.
- [ ] Implement smallest fail-closed output guard; preserve existing allowlist and deterministic metadata.
- [ ] Run focused Python tests and the complete skill suite; record red/green results.
- [ ] Review diff independently.

## Task 2: Accurate listing and versioned candidate
Files: skills/tetherplane-starter/README.md; docs/distribution/agensi-starter-listing-draft.md; docs/distribution/agensi-starter-publication-checklist.md.
- [ ] Record Starter package version 0.1.0 and short change note in README.
- [ ] Preserve existing historical ad2542a evidence; distinguish new final package evidence.
- [ ] Describe free instructions-only bundle, six tools, prerequisites, permissions, full dual licenses, local vs relay/host privacy, and unsupported claims.
- [ ] Confirm public Agensi format/submission/security guidance; retain separate approval gates.
- [ ] Build twice to new versioned paths, compare full bytes and SHA-256; inspect exact 11 regular UTF-8 members, metadata, licenses and size.
- [ ] Write external checksum and JSON provenance manifest with source/input tree identity and builder versions. Avoid self-referential commit hashes in committed artifacts.
- [ ] Keep generated ZIP/checksum/manifest under ignored dist and operator LocalAppData candidate directory; never add secrets or binary artifacts to Git.

## Task 3: Fresh verification and push
- [ ] Run repo hygiene, complete Python skill tests, Rust fmt/clippy/tests, pnpm typecheck/tests/build, authored unsafe check and diff check.
- [ ] Run existing isolated Windows package/install smoke; do not register tasks or change production installs.
- [ ] Run starter real local read-only integration.
- [ ] Verify exact packaged ZIP host discovery in approved isolated CI; discovery does not prove model execution.
- [ ] Commit only reviewed task files; push existing feature branch without force.
- [ ] Inspect new exact-commit CI. If a gate fails, preserve evidence and report the specific blocker.
- [ ] Reconfirm canonical checkout state is unchanged by this work.

## Task 4: Operator session and clean Windows environment (planning only)
Files: docs/distribution/leno-observed-session-and-clean-windows-plan-20261017.md.
- [ ] Record operator availability: October 17, 2026 from 00:05 Asia/Dubai; propose a 30-minute explicitly confirmed window.
- [ ] Do not run the public release acceptance runner on a dirty feature branch; it requires clean main == origin/main.
- [ ] Record actual Native Web Test Leno status and unavailable browser provider; avoid calling this a coexistence pass.
- [ ] Read-only OS/hardware/feature inventory on Leno; assess Hyper-V/Sandbox feasibility and licensing.
- [ ] Specify baseline, network/sharing isolation, test lifecycle, capacity and approval requirements. No provisioning or restart.
- [ ] Final report: Completed, Verification, Git state, Remaining work/blockers.

## Execution record and rulings
- Task 1 implemented with copied-fixture RED (two expected failures), GREEN 7/7 and complete Python skill suite 29/29; independent review found no remaining defect.
- Task 2: version/readme/listing/checklist written; historical ad2542a ZIP rehashed unchanged. Two new Leno ZIPs match (12,928 bytes, 11 members; SHA-256 50b21a75cbb0482b9450b01576bb77350ab146d0e36f312f6798bee6763841c5), CRCs and license bytes verified.
- Ruling: retain versioned ZIP/checksum/member-hash manifest in CI after exact OpenCode discovery, then select exact push-CI artifact; baseline CI retained no artifact. Local embedded provenance step executed successfully.
- Ruling: run gates sequentially at low priority, one Cargo build/test thread, with CI-parity GITHUB_ACTIONS=true. Interactive Windows desktop fixture is intentionally not run unattended; no live coexistence pass is claimed.
- Task 3 blocked: cargo test --workspace exited 101 because Windows Application Control prevented private_clipboard-be521f126e3e8727.exe from starting (os error 4551). Event 3077 at 2026-10-16T20:24:44Z identifies policy VerifiedAndReputableDesktop, status 0xc0e90002, unsigned file; correlated 3033/3089 and matching file hash. No bypass/retry/security change. Independent remaining gates continue; no commit/push while required verification is blocked.
- Task 4: operator timing and agenda documented; read-only Leno inventory shows insufficient current RAM headroom and disabled Hyper-V/Sandbox. No provisioning, restart or spending. The planned window does not authorize an unattended session.
- Marketplace: current October 12 Terms vs older guide leave free-listing payout requirement unresolved; clarify free MIT/Apache package treatment under saving/redistribution restrictions before submission. Platform privacy and remaining real-activation/independent-tester quality checks are explicit.
- Additional Task 3 blocker: pnpm recursive tests stalled in the browser-bridge extension-backend.test.ts worker after its output stopped. After over five minutes, verified the exact PID/start time and full descendant chain to this task-owned gate; stopped only that worker. The suite exited 1 and remains incomplete. No human or production process was targeted; no passing result is claimed. TypeScript typecheck passed.
- Ruling (supersedes the local-only push gate above): changed-component regression/complete Python suite, real starter integration and other local static/build checks passed; the Rust trust denial and browser worker hang affect unchanged code. Proceed with the user's explicitly authorized feature-branch push to obtain fresh exact-commit Windows/Linux CI. Require all new CI jobs and exact artifact provenance before package verification is complete; retain local limitations for live acceptance. No local security policy is bypassed and no merge/publication is permitted.
