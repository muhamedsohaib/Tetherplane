# Store candidate rebased as an isolated integration **preview** — 30 October 2026

**Disposition: NO-GO; draft-only; no Store submission or real-device mutation.**

## Exact reviewed inputs

- Existing Store MSIX candidate from draft PR #108 at `86fcb572bff34bf1dc9bcaeecd62d0cee8db0e5e`, including MSIX package version `1.0.0.0` and previously reserved Store identity `ARCUSLabs.Tetherplane`.
- Later Windows source from draft PR #107 at `be544ec3e1a53c649249d4fb0908fb917312da1b` (this integration branch's parent), whose latest separate standard CI and independent unsigned Windows candidate clean-host workflow passed.
- This branch copies only the minimum Store-specific packaging, setup UI, runtime helpers, and Store tests from PR #108 onto the PR #107 source tree. No old `scripts/install-windows.ps1`, security/auth, live-relay, Windows scheduled task, or production configuration is copied from PR #108.
- No existing PR or protected branch was rebased or merged. Both source branches remain unchanged.

## Source integrity and authentic test gates

- A disposable Windows pull-request run must compile the **actual integrated checkout** Rust `tetherd`, build the Compact MCP runtime and Node bundle, and pack/unpack synthetic-artwork Store MSIX with fixed identity (but **never** upload an MSIX artifact).
- The source contract and Store runtime unit tests must execute. Crucially, the native/relay owner-approval, six-tool, stranger-denial, same-identity reconnect and owner-revocation test has a **required** environment gate and **must fail** if its runner/branch preconditions are not met. Earlier Store PR runs incorrectly reported this step as successful because the test skipped on `feature/msix-store-private-candidate-*` branches.
- CI preserves a JSON-only status report. An MSIX generated with synthetic artwork is discarded and **NOT SUBMITTABLE**. No signing, Store upload, OAuth/DCR, credentials, tenant, tasks, or trust controls are changed.
- A successful isolated preview does not prove an installed Store-signed build, Smart App Control admission, no unexpected foreground windows, correct scheduled-agent recovery, rollback across versions or four-device acceptance.

## Remaining independent gates

1. Microsoft support case `2610290010001747`: obtain publisher-account/name and package identity disposition. **Do not** silently update ARCUS Labs, the reserved publisher CN, or account identity.
2. Approve genuine black/crimson icon-source bytes and exact exported SHA-256 hashes; capture a real unpaired GUI screenshot without credentials or device identifiers. The known Drive blue and halftone logos are **not** approved substitutes.
3. Independent Windows App Certification Kit validation and approved owner-mode unsigned package with package provenance; no synthetic preview may be submitted.
4. The integration now uses the reviewed dual-binary Windows build and packages the explicit GUI-subsystem `tetherd-agentw.exe`. The builder checks the actual x64 PE subsystem before export; the Store overlay stages the windowless name only in scratch, preserving the separate CLI and dev source. The native/relay test targets that binary. **Still NOT proven:** Store-activated Node wizard window behavior, foreground coexistence, Smart App Control on a physical machine, background restart and Windows packaging activation.
5. Independent privacy policy, Store developer-account eligibility and certification review. Only after owner authorization: private-audience Microsoft Store signing and physical Windows 11 SAC-on install, scoped-denial, reboot and rollback acceptance.

**Do not merge, sign, upload, certify, publish or change any of the four live devices on the basis of this preview.**
