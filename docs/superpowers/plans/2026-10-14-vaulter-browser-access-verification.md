# Vaulter browser access verification implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this bounded repair. The user authorized continued engineering, TDD and full gates in this chat.

**Goal:** Make browser availability checks reflect a live, read-only provider round trip while recording the actual Vaulter access boundary.

**Architecture:** Keep the existing six-tool MCP interface and provider boundaries. `BrowserBridgeService` checks its backend through `pages()` before reporting availability; discard page data without granting or transferring ownership. Existing extension grant expiry still narrows authorization locally. Network readiness, authentication and functional filesystem/browser proof remain distinct.

**Tech stack:** TypeScript, Node test runner, existing browser RPC server/CDP and extension backends.

**Spec:** `docs/superpowers/specs/2026-09-17-tetherplane-design.md`, sections 2.5, 5, 6 and 22; canonical roadmap and local-core plan.

## Constraints and review focus

- Default surface is exactly device/files/process/browser/desktop/batch.
- Background only: no activation, navigation, clipboard or physical input.
- Status must expose no page URLs, IDs or page contents.
- A disconnected provider must retain its structured failure code and request correlation.
- Empty page lists from a connected provider are healthy; discovery metadata alone is not a health proof.
- Preserve the 17 previously staged files and untracked mesh package in the canonical checkout.

## Task 1: Truthful browser status

Files: `browser/bridge/src/rpc-server.ts`, `browser/bridge/test/rpc-server.test.ts`.

- [x] Add RPC regression: backend page observation fails with provider_failure; browser.status must return error, failed verification and the original request ID.
- [x] Run the regression and observe the current erroneous success response (RED), plus a real closed CDP browser incorrectly reporting success.
- [x] Await backend.pages() in status before returning its existing compact response; do not call bridge ownership synchronization.
- [x] Verify regression and healthy empty/populated page cases, response privacy and unchanged resources (GREEN: 6 RPC tests, bridge typecheck).
- [x] Independently review; run full Rust and TypeScript source gates (137 Rust tests and 281 selected TypeScript tests; two explicit human-state test exclusions below).

## Task 2: Access evidence and handoff

File: `docs/remote/vaulter-access-verification-2026-10-14.md`.

- [x] Record bounded history evidence and fresh Leno network, SSH and connector probes without credentials.
- [x] Prioritize authenticated execution through the existing Tetherplane OAuth route once its client acceptance is repaired. Surface SSH is a historical recovery path requiring separate targeting authorization; do not use it from this task.
- [x] Record full source gates, exact exclusions/failures and unresolved authenticated remote proof.
- [ ] Commit only this task's files after fresh verification, then push the feature branch. Never include preexisting staged work.

## Execution decisions

The live desktop coexistence test opens and activates fixture windows, and B8 reads the human's global clipboard. Run the repository test command with Node's explicit skip pattern for these two tests; retain them as unpassed operator-authorized gates. Background browser tests use isolated headless Chromium contexts. Test file and workspace concurrency are limited to one during the full rerun after startup timeouts.

Current authentication rejects the connector and Leno SSH key. Do not change authorized keys, copy credentials, change relay services, or substitute RDC access to Vaulter. These are live prerequisites, separate from the source repair.

Independent review: no Critical or Important findings. Deferred minor: add an ownership registry assertion to happy-path status tests to detect an accidental future change to bridge ownership synchronization. Direct service request deadlines remain inherited from the backends; production Rust RPC deadlines apply.

All source gate logs are held locally in a dedicated temporary evidence directory. The preexisting staged patch fingerprint before this task was `ade75d74ebb3366c548b6fb3d9cc4191a7445da2`; verify it again after the path-scoped commit.
