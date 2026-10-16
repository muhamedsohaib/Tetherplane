# Agensi Starter verification record — October 17, 2026

## Result
Local publication-package candidate is prepared for review. Changed-component verification passed on Leno; the explicitly authorized feature-branch push will obtain fresh exact-commit Windows/Linux CI. Do not claim complete verification until that CI passes and its exact tested artifact is selected. Local broader gate limitations remain below. No merge, tag, submission, email, payout setup or VM provisioning is authorized.

Source baseline: ad2542abc84fcdb6f336919e86b561d588784bce on feature/open-source-commercial-model-20261014, in the existing Leno Agensi worktree. The adjacent artifact manifest identifies the final committed source or explicitly records working changes for a local build; baseline identity alone is not final package provenance.

## Fresh Leno verification
All project execution explicitly targeted Leno via the existing authenticated Native Web Test connection in background_only mode. Desktop Commander usage remained paused; the other Tetherplane connection returned Authentication required. No connections were changed.

| Check | Result |
| --- | --- |
| Output-overwrite regression RED | Two expected failures on temporary copied inputs; no real source was overwritten |
| Packaging regression GREEN | 7/7 passed |
| Complete Python skill suite | 29/29 passed |
| Repository hygiene / high-confidence secret scan | Passed for 373 tracked files; limited scanner coverage, not a security certification |
| Rust formatting | Passed |
| Rust Clippy workspace/all-targets, warnings denied | Passed |
| Rust workspace tests | Blocked: exit 101 before one unsigned test executable could start |
| TypeScript workspace typecheck | Passed |
| TypeScript workspace tests | Incomplete: browser-bridge extension-backend.test.ts worker hung; recursive command exited 1 after verified worker was stopped |
| TypeScript workspace builds | Passed |
| Authored unsafe check | Passed |
| Real read-only Starter Compact MCP integration | Passed |
| Windows package/install smoke | Initial attempt lacked the release binary; release build and corrected smoke follow-up pending |
| git diff --check | Passed |
| Embedded CI provenance step | Executed in a scratch workspace; exact bytes, source identity, 11 members and hashes passed |
| Final exact-commit CI / new artifact | Required after the authorized feature-branch push; use the selected artifact manifest/run record for the outcome |
| Operator-observed coexistence | Not run; planning only |
| Model-driven skill activation / independent consumer installation | Not tested |

Gates ran sequentially with one Cargo build job/test thread and low process priority. CI-parity GITHUB_ACTIONS=true deliberately excludes the interactive Windows desktop fixture. This is not observed coexistence evidence.

### Windows code-integrity block
At 2026-10-16T20:24:44Z (October 17 00:24:44 Dubai), Code Integrity event 3077 identified the worktree's private_clipboard-be521f126e3e8727.exe, invoked by Cargo, under policy VerifiedAndReputableDesktop (27555.1000.240208), status 0xc0e90002. File is NotSigned; signing levels requested 2, validated 1. Events 3033/3089 and a matching file SHA-256 corroborate denial before launch. No bypass, signing, unblock, policy change or retry of that executable occurred. Operator/policy-owner review of an authorized trust/execution route on Leno is required.

### TypeScript worker disposition
The extension-backend.test.ts worker remained alive after output stopped for more than five minutes. Its exact PID, creation time, test argument and full descendant chain to this task's gate process were verified before stopping only that worker. No browser descendants remained at inspection. The suite remains incomplete; termination is not a pass. One isolated serial run of the semantic-wait case with a 5-second test limit and 10-second process ceiling subsequently passed (1/1, exit 0, 434 ms); it did not reproduce or clear the full-suite hang. Source review suggests a fixed-5-ms reply timing race, but the cause and retained handle remain unconfirmed.

## Package identity
- Version: 0.1.0.
- Leno candidate: %LOCALAPPDATA%/Tetherplane/release-candidates/agensi-starter-0.1.0-20261017/tetherplane-starter-0.1.0.zip.
- Size: 12,928 bytes; 11 regular UTF-8 members under one root.
- SHA-256: 50b21a75cbb0482b9450b01576bb77350ab146d0e36f312f6798bee6763841c5.
- Two fresh builds were identical; CRCs, fixed timestamps/permissions and full license bytes verified.
- Python 3.10.11 on Leno; identical bytes are claimed only for identical inputs and builder.
- Separate checksum and member-hash provenance manifest retained alongside the ZIP.
- Historical ad2542a artifact (12,624 bytes; f51215ce4a15fac576190248e61a6b8443b3f4baf7dc3c932705c0d148e0c011) was rehashed unchanged and preserved.
- Baseline GitHub runs 38952769626 and 38952762299 were rechecked: both successful, five jobs each. Baseline OpenCode 2.0.30 discovery does not prove discovery/model execution of this changed ZIP.
- Proposed CI now retains the exact bytes after successful discovery with version, source SHA, SHA-256 and all member hashes. Select a successful exact-head push artifact after the gate clears; PR artifacts may use synthetic merge SHAs.

## Remaining gates and approvals
The task changes only the ZIP packager, its regression tests, CI artifact retention and documentation; no Rust/provider/runtime or browser-test code changed. Fresh changed-component tests, integration, typecheck/build, formatting/Clippy, hygiene and diff checks passed locally. Proceed with the user's authorized task-branch push for full fresh CI; require all exact-commit CI jobs before selecting the upload ZIP. Preserve local failures as limitations of Leno live acceptance, not a claim of local full-suite success. Continue to preserve the canonical dirty checkout.

The clean Windows/observed-session plan records operator availability from 00:05 Dubai and a proposed 00:20–00:50 window; no observed session ran. Browser capability is unavailable and the public release runner requires clean main == origin/main. Leno's observed free RAM (1.29 GiB) is insufficient for a safe Windows guest allocation; Hyper-V/Sandbox are disabled. No provisioning is ready or authorized.

Marketplace payout requirements for a free listing and applicability of platform saving/redistribution restrictions to this free MIT/Apache package remain unresolved. Real activation, broader agent testing and independent-tester quality checks are open. Separate explicit approval is still required for submission/publication, Stripe/payout setup, messages, merge or release tag.

Full local logs: dist/agensi/verification-20261017-001 (ignored, not committed or sent externally).
