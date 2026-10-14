# Tetherplane Connector Hardening and Licensed Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden authenticated device/relay and Windows startup connectors, restore full CI and packaging reliability, confirm MIT/Apache licensing and supply-chain release requirements, then produce a verified licensed release candidate without publishing an unverified tag.

**Architecture:** Preserve the existing provider-neutral six-tool MCP edge, relay WebSocket transport, and local Policy Broker. Improve recoverability and secure defaults of the transport/Windows lifecycle through narrowly scoped tests, and add a release-ready gate using the established packaging and acceptance workflow. The user-approved native tray remains a separate prerequisite plan.

**Tech Stack:** Rust, TypeScript, ws, pnpm 10, Node.js 22, PowerShell scheduled tasks, GitHub Actions, Windows package smoke, CI/security tests.

**Spec:** `docs/superpowers/specs/2026-09-17-tetherplane-design.md`, `docs/superpowers/plans/2026-09-17-tetherplane-implementation-roadmap.md`, `docs/superpowers/specs/2026-10-14-windows-tray-presence-design.md` and the companion tray implementation plan.

## Global Constraints

- Preserve six MCP tools: `device`, `files`, `process`, `browser`, `desktop`, `batch`; internal capability names remain provider-neutral.
- Human precedence and `background_only` default. No stealing cursor/focus, clipboard, or human tabs and no terminating human-origin processes.
- Local agent final authority: cloud relay or MCP OAuth changes must never bypass local policy.
- No secrets, raw device keys, tokens, auth headers or external credential transfers in tests, logs, artifacts or chat.
- Maintain existing dual license `MIT OR Apache-2.0`; verify texts and third-party license obligations, do not invent a license migration.
- Existing published `v0.1.0` is historical and must not be moved, reused, overwritten or silently re-tagged.
- Never deploy new production tasks, restart Vaulter relay, or sign users out during normal development verification.
- Commit focused task changes on feature branches; never force-push `main`.
- Release only after fresh two-OS CI, live acceptance, real-device verification, licensing, secret scan, signed-off artifact and provenance gates. Tagging/publication is an explicit final approval boundary.

## Review Focus

1. **Vaulter restarts with no interactive session:** relay and agent must come online in the supported unattended configuration, or block release with a reproducible failure; Task 4.
2. **Remote network stalls / TCP remains established:** bounded authenticated WS heartbeat detects outage and reconnect without duplicate side-effects; Task 3.
3. **Agent/revocation ownership changes:** cross-account routes are denied, revoked devices cannot reconnect, older agents remain interoperable; Task 3.
4. **Install on an existing Windows host:** leave unowned scheduled tasks, browser windows, models, human processes and data untouched; Task 4.
5. **Tag or publish attempted with red CI or missing attestation:** automated pipeline fails before release, without uploading unverified binaries; Task 6.

---

## Task 1: Capture Canonical Git Baseline and Release Inventory

**Files:** Read `docs/live-acceptance.md`, `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE`, `LICENSE-APACHE`, `LICENSE-MIT`, `Cargo.toml`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`. No source changes.

**Interfaces:** A committed matrix in `docs/release/2026-10-14-readiness-matrix.md` (create) recording each release gate, owner, exact evidence, status and blocker.

- [ ] **Step 1:** Inspect Leno repository `git status --short`, `git branch --show-current`, `git log --oneline --decorate -5`, `git remote -v`; establish separate feature worktree and reconcile canonical GitHub branch.
- [ ] **Step 2:** Inspect published tag/release, configured workflows, current CI outcomes, license files and third-party dependencies; do not treat a historical successful run as fresh proof.
- [ ] **Step 3:** Write readiness matrix recording fresh evidence requirements, including tray specification acceptance, and commit `docs(release): establish licensed candidate gates`.

## Task 2: Restore Current Rust 1.99 CI Baseline

**Files:**
- Modify: `agent/providers/search/src/search_tests.rs:214`, `agent/providers/process/tests/process.rs:385`
- Test: existing Rust workspace tests and the CI Clippy gate.

**Interfaces:** No runtime interface change; eliminate only unnecessary assertion forms, preserving semantics.

- [ ] **Step 1:** Reproduce CI errors from run 38537466170 (Windows + Linux). Rust Clippy 1.99 warns at the two locations under `-D warnings`.
- [ ] **Step 2:** Make the smallest assertion-only substitutions with equally meaningful failure output; do not silence `clippy::assert_is_empty`.
- [ ] **Step 3:** Run `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` on the matching toolchain; verify green, then full TypeScript gates.
- [ ] **Step 4:** Commit `test: modernize empty collection assertions for Rust 1.99`, push and inspect fresh CI both OSes.

## Task 3: Harden Authenticated Connector Transport

**Files:**
- Modify: `relay/src/devices/ws-gateway.ts`, `relay/src/routing/device-router.ts`, `agent/tetherd/src/relay_ws.rs`, `relay/test/device-ws.test.ts`, `tests/e2e/remote-plane.test.ts`
- Extend companion tray test coverage without doubling heartbeat or presence subscriptions.

**Interfaces:** Preserve `DeviceRouter.call` semantics, idempotency and existing authenticated WSS device upgrade. The tray plan's single heartbeat service remains authoritative; this task strengthens behavior and negative tests, not duplicate protocols.

- [ ] **Step 1:** Write failing tests for TLS/WSS requirement; incorrect device identity or credential; cross-account isolation; revoked device; reconnect after half-open socket; in-flight request failure vs retry; legacy client compatibility.
- [ ] **Step 2:** Run `pnpm --filter @tetherplane/relay test` and relevant `tests/e2e` tests; verify genuine intended red failures.
- [ ] **Step 3:** Implement minimal fixes at authorization, routing, reconnect and WS boundaries; never log raw credential/header values.
- [ ] **Step 4:** Verify focused, end-to-end and wider suites; commit `fix(remote): harden authenticated device lifecycle`.

## Task 4: Windows Agent and Relay Unattended Recovery

**Files:**
- Modify: `scripts/install-windows.ps1`, `scripts/uninstall-windows.ps1`, `packaging/windows/tetherplane-agent.ps1`, `tests/release/windows-package-smoke.ps1`
- Create: `docs/remote/windows-unattended-startup.md` and targeted tests for the supported unattended configuration.

**Interfaces:** Preserve user ownership and existing scheduled-task names unless migration is explicitly opted in. Do **not** edit an installed signed/integrity-guarded Vaulter supervisor in-place.

- [ ] **Step 1:** Reproduce a no-login post-boot agent/relay start in disposable Windows test environment and assert startup/restart behavior in `windows-package-smoke.ps1`. Record the live Vaulter failure: interactive task denied when the user wasn't logged in, and integrity-guarded supervisor rejected out-of-band logon change.
- [ ] **Step 2:** Inspect launcher access requirements (user profile, DPAPI, credential files, service token permissions, executable paths, ACLs, working directory). Select the least-privileged supported unattended identity *only after* proving required resources are accessible.
- [ ] **Step 3:** Implement an explicit unattended service/task installation mode with secure local file ACLs, startup trigger, bounded restart delay, start-when-available, no 72h process cutoff, readiness check and retry; preserve opt-in interactive mode. Rebuild supervisor integrity snapshots through a supported authenticated redeployment flow; never patch or bypass trusted hashes.
- [ ] **Step 4:** Add failure/reboot/sleep-wake tests and verify a clean uninstall does not kill human processes or delete unowned state.
- [ ] **Step 5:** Run Windows package smoke and reboot tests on authorized disposable or side-by-side environment. After review, schedule explicit user-approved production rollout on Leno, Vaulter, RTX, Surface; verify no-login reboot persistence on each. Commit `feat(windows): support verified unattended Tetherplane recovery`.

## Task 5: Licensing, Dependencies and Security Release Gate

**Files:**
- Modify: `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `scripts/package-windows.ps1`, `docs/release/2026-10-14-readiness-matrix.md`.
- Add a small license/dependency inventory or SBOM generation/checking script only if no suitable existing script covers it.

**Interfaces:** Every binary package contains `LICENSE-MIT`, `LICENSE-APACHE` and dependency notices required by actual locked dependencies. Never misstate the license as a newly granted or proprietary license.

- [ ] **Step 1:** Write failing packaging tests when either full license text or expected SPDX data is missing, the manifest SHA mismatches, or a new dependency's license isn't accounted for.
- [ ] **Step 2:** Review Cargo.lock / pnpm-lock.yaml licensing and security advisories using authoritative package metadata; document exceptions with evidence. Do not automatically bump every package.
- [ ] **Step 3:** Add license/SBOM/secret checks and actionable documented security reporting, install/upgrade/uninstall, account isolation, and bounded telemetry guarantees.
- [ ] **Step 4:** Run negative security tests and package gates; commit `build(security): add licensed release artifact checks`.

## Task 6: Hard Gate for Releasable Artifacts and GitHub Release

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `tests/release/windows-package-smoke.ps1`, `docs/live-acceptance.md`, `docs/release/2026-10-14-readiness-matrix.md`
- Optional: a separate pre-tag readiness workflow. Do not embed secrets in CI fixtures.

**Interfaces:** Release workflow MUST NOT publish artifacts if required checks fail; the release manifest records source commit, version, platform and SHA256. Preserve `v0.1.0` as immutable historical release.

- [ ] **Step 1:** Write a negative workflow/packaging test that simulates a missing license, failed Windows smoke, failed required CI job or mismatched artifact checksum and asserts no release step can execute.
- [ ] **Step 2:** Gate publication on independent successful Linux/Windows CI from the identical commit, tray performance and package-smoke evidence, license/dependency/secret scan and operator-observed live acceptance. Use environment/manual approval as needed; do not publish solely on an unchecked tag push.
- [ ] **Step 3:** Build the complete Windows x64 archive including optional tray and matching manifest+SHA256; verify from clean installed package, and record any unsupported platform instead of inventing additional binaries.
- [ ] **Step 4:** Run fresh gates: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`, `python scripts/check-no-unsafe.py`, Windows package smoke, E2E, human-coexistence and malicious-input tests. Confirm 6 MCP tools and no secret output.
- [ ] **Step 5:** Run authorized Leno operator-observed live acceptance, plus Vaulter/RTX/Surface relay routing and unattended startup checks. Collect snapshots of success/failure *without* credentials. Update readiness matrix.
- [ ] **Step 6:** Generate reviewed version notes and propose the next semver tag; do **not** tag or publish until the user approves the final release candidate and all gates are green.
- [ ] **Step 7:** After explicit approval, tag/push once, observe published artifact and its checksums/signatures, and verify fresh release installation in a disposable environment; record final release URL and SHA.

## Overall sequence and proof

1. Native tray plan: implement presence protocol, secure IPC, Win32 UI, optional installer, benchmarks.
2. This plan: fix CI, harden transport, establish secure reboot persistence, audit licenses and dependencies, gate release.
3. Independent design/security review and negative tests, then measured four-device validation.
4. Public licensed release only when all checks pass and the user explicitly approves the final publication.

**Current audited blockers (2026-10-14):** latest CI failed on both OSes due Rust 1.99 Clippy test assertions; production Vaulter relay depends on interactive Windows logon; authenticated four-device RPC is not yet proved; optional tray not implemented; no fresh signed-off release candidate. The published `v0.1.0` is not a substitute for these gates.

**Definition of done:** all four devices work at the authenticated request/response layer; tray operates within measured CPU/memory targets; relay/agents survive reboot without login and recover from transport failure; approved licensing files and dependency notices ship; security and CI gates green; immutable versioned packages built, verified, published only after approval.
