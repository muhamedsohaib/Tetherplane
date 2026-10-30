# Tetherplane Store privacy: persistence security review (2026-10-30)

Status: **REVIEW ONLY / NO-GO**. This report documents source observations and missing acceptance evidence, not a finding of unauthorized disclosure or an approved change to retention policy.

## Source observations

1. `packaging/msix-store-runtime/app/state-security.mjs` uses Windows DirectorySecurity with inheritance disabled and an allow-list for the current user SID and LocalSystem when creating a **new Store onboarding credential-state directory**. Reuse checks the state directory, `device.json`, and `device-credential.txt`. This is a credential-state boundary and does not, by itself, establish protections for all agent state directories.
2. `agent/tetherd/src/idempotency.rs` creates `<state_dir>/idempotency` with `std::fs::create_dir_all`, writes a pending fingerprint and a completed `ResultEnvelope` as JSON, and replays the result for a matching key and fingerprint. This module does **not** explicitly set a Windows DACL, encrypt a completed result, or implement time-based expiry/rotation. An enclosing directory might already be protected; effective permissions are **unverified**.
3. `agent/tetherd/src/audit.rs` appends execution metadata to `<state_dir>/audit/events.jsonl`. The inspected event fields exclude raw invocation arguments but include principal, actor, job/request/device IDs, capability and outcome metadata. The reviewed module does not implement retention or rotation.
4. `agent/tetherd/tests/idempotency.rs` tests replay after restart, conflicts, concurrency and a characterization of the completed-record layout. The test fixture's append result does not prove that all other capability results are free of sensitive output.

## Threats and independent acceptance

- **Unauthorized local read:** On an isolated Windows test runner, create a fresh agent state tree through the production-equivalent setup path, then inspect effective DACLs of the root, `idempotency`, completed JSON and audit JSONL. Use a distinct, unprivileged Windows account to assert access denial. Record SIDs/ACL structure privately (never real credentials or personal data). A passing setup credential ACL check does not replace this test.
- **Sensitive result persistence:** In a disposable test with synthetic secret-marker output, demonstrate precisely which operation result fields are persisted and replayed. Do not copy any real customer data to CI.
- **Replay-safe cleanup:** Establish an explicit lifetime and recovery policy for pending/completed keys, crash uncertainty, retries and operator-initiated deletion. Expiring a key can cause a previously executed non-idempotent mutation to run again; no automatic purge is authorized without verified safeguards.
- **Path and ownership assumptions:** Verify that all deployment modes (Store, Windows service, manual agent, local MCP) choose an adequately protected `--state-dir`; test inherited ACLs and directory preexistence. Never silently re-ACL existing owner state in a test.
- **Operator disclosure:** Publish no claims of zero payload storage, universal encryption, or fixed retention until independently supported.

## Current gate

PR #111 is draft and isolated from deployment. No production or protected device files were read, deleted, re-permissioned or migrated. Microsoft publisher case `2610290010001747`, privacy notice approval, exact Store artifact approval, real Store-signed install and four-device acceptance remain separate release gates.

**Decision:** Maintain NO-GO. Next engineering step is a Windows-only negative access-control test on entirely disposable state, followed by retention design review before any implementation change.
