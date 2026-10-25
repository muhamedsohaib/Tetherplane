# Tetherplane Device Authority — verified isolated candidate

**Date:** 2026-10-25 (Asia/Dubai)
**Scope:** existing five-card Control Center adapter only
**Branch:** feature/device-authority-20261025
**Implementation commit:** 56fb772e298ccfe28a3aa6692bbefbbfaa7c71db
**Base:** 2fabefccb1779f5118b3cd544fc835b3f06af949
**Production decision:** NO-GO. Not merged, deployed or pushed.

## Implementation recovered and completed

The interrupted local source was recovered from the isolated Leno worktree without resetting the canonical dirty checkout or changing any other worktree. This candidate implements:

- Existing-session owner subject and active account/device checks before authority decisions.
- Live device.capabilities discovery, explicitly labeled as **advertised**, not an end-to-end privilege grant.
- Opt-in, deny-only **Control Center** restrictions; no native policy editing or administrator grant.
- Same-origin POST and CSRF, exact device confirmation, reason, explicit revision matching and stale-revision rejection.
- HMAC-chained persisted audit of restrictions and rollback with replay verification and tamper denial.
- Conservative MCP pre-dispatch denial for restricted tool groups, including process, batch and non-observational device operations under active restrictions.
- Frontend restrictions and revisioned rollback displayed in the original five-card page by an externally appended JS module.
- UI errors that preserve uncertainty after timeout/disconnect, label failed directory refresh accurately and avoid false confirmed logout.
- Request-epoch fencing to prevent an out-of-order earlier device observation replacing the current selected device.
- Removal of a private issuer hostname embedded in the browser JS; authorization URL stays HTTPS-only and the server continues to enforce the existing configured issuer and endpoint.

The existing device-local PrincipalProfile, OAuth client and relay scope remain unchanged.

## Verification — independently executed locally on Leno

| Evidence | Result | Meaning |
|---|---|---|
| Node test suites (7 files) | **42 passed / 0 failed / 0 skipped** | Synthetic core, HTTP, OAuth, original Control Center integration, local relay and UI tests |
| Headless Microsoft Edge QA | **PASS** | Actual candidate HTML/JS loaded with intercepted **mock** authority responses; one simulated restriction, rollback, non-owner readonly, stale-response race |
| Stale response RED control | **Observed failure before patch** | Delayed Surface GET overwrote selected Leno details; fixed and browser retest passed |
| Restricted device op RED control | **Observed failure before patch** | Non-observational device operation initially passed Control Center restriction; fixed and HTTP/unit regressions passed |
| Installer/checksum mismatch RED | **Observed failure before patch** | Installer still required older HTML hash; aligned and added consistency test |
| Owner HTML SHA-256 | **4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8** | Current local candidate and staged copy, byte-identical |
| Node visual verifier | **PASS** | Current source bytes match pinned candidate hash |
| JS syntax check | **PASS** | Device Authority frontend parser |
| git diff --cached --check | **PASS** | No diff whitespace errors before code commit |
| Git working tree immediately after commit | **Clean** | Source-only commit on feature branch, no unrelated checkout changes |
| Real device policy edits | **0** | The Edge test's mutations were mocked, not sent to real agents |

The browser test opens and terminates its own temporary loopback server and uses a synthetic test-only audit key. It does not change VAULTER, Tailscale or device identity configuration.

## Read-only device observations (2026-10-25)

| Device | Authenticated connector device.status | Device capability inventory |
|---|---|---|
| Surface | Windows x86_64, agent 0.1.0, background_only, success | 9 provider namespaces; browser unavailable |
| Leno | Windows x86_64, agent 0.1.0, background_only, success | 9 provider namespaces; browser and desktop operations advertised |
| VAULTER | Windows x86_64, agent 0.1.0, background_only, success | 9 provider namespaces; process operations not advertised to this principal |
| RTX | Windows x86_64, agent 0.1.0, background_only, success | 9 provider namespaces; browser unavailable |

All four device.status and device.capabilities calls returned through the authenticated connector. This is **not** proof of the deployed browser Control Center, account pairing for its OAuth session, every principal's grant, real mutation acceptance, or packaging reliability.

The restricted VAULTER principal denied process.run; unscoped C:\ filesystem listing denied outside allowed directories. No alternative capability was used to bypass those restrictions.

## Source-parity checkpoint

Candidate files compared byte-for-byte with the earlier isolated Device Authority staging directory on Leno:

| File | Compared with staging |
|---|---|
| authority-http.mjs | Identical |
| oauth.mjs | Identical |
| server.mjs | Identical |
| public/tp-oauth.js | Identical |
| public/index.html (private, untracked) | Identical; fingerprint above |
| authority.mjs | Different: additional denied-device-operation hardening |
| public/tp-authority.js | Different: out-of-order response protection |
| public/tp-integration.js | Different: interrupted UI recovery fixes plus configured-issuer portable OAuth redirect |

Other application files (test, installer, README, verifier) were separately tested or updated. The candidate's private HTML is ignored by Git and **was not committed**.

**Important art provenance:** the historical October 23 documentation describes an older HTML hash, 36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82. The named Leno functional-copy file hashes to 49704627654a1b9a909218e9e6ac0fae18f89d967cead4535f3e0cfdb3adf679. Neither is identical to the current approved candidate hash. Do not silently replace or equate these artifacts.

**VAULTER port 8791 source parity remains UNKNOWN.** Deployed listener/process provenance, source files, OAuth/fleet presence versions and private artwork hash could not be read using the currently authorized limited principal. A successful VAULTER agent status is not proof of Control Center source parity or health. No newer deployed fleet/OAuth behavior was overwritten.

## Security and remaining release blockers

1. **Deployed VAULTER provenance:** owner-authorized read-only report of port 8791 listener/PID, source/code SHA and private source HTML SHA, followed by exact file-by-file reconciliation. Do not request or export credentials or widen the remote principal.
2. **Actual portal acceptance:** approved existing OAuth browser login, account session expiry, account/pairing isolation, real read-only allowed/denied operations and four-device directory/probe flow. Do not perform live permission edits just for testing.
3. **Journal-loss and recovery:** The subsequent isolated source change uses an authenticated high-water checkpoint, refuses missing/erased/rolled-back journals, requires explicit offline first-use provisioning and tests matching backup restoration. Protect and back up journal, checkpoint and key; independently verify production ACLs, single-writer safety, interrupted-write recovery and operator procedures before activating production admins.
4. **Release provenance:** independent new-head CI, trusted Windows signing, clean install/upgrade/uninstall, recovery/rollback and physical device acceptance not yet performed on this commit.
5. **Approved art and distribution rights:** preserve the exact visual source and resolve older/candidate hash discrepancy before release.

The authority panel does **not** override native agent rules. A successful synthetic fixture must not be represented as live production authorization.

## Controlled promotion plan — prepared, not authorized to execute

A future operator-approved maintenance procedure should:

1. Capture a sanitized exact VAULTER release manifest (ports, PIDs, SHA-256 of source/assets and service startup provenance), keeping private paths and secrets out of reports.
2. Back up deployed files and protected audit state in place using access-controlled storage; record the rollback operator and exact old build.
3. Assemble a parallel isolated stage at a distinct loopback port with the **correct** approved HTML, reused OAuth client and reconciled current fleet-presence implementation.
4. Perform browser, session, permission-denial, journal integrity and four-device read-only acceptance. Explicitly mark any mock portions.
5. Request separate authorization for protected production promotion. On failure, restore the recorded prior build, restart through the approved supervisor, and verify authenticated session/recovery and device visibility without overwriting identity state.

**Single next action:** obtain the authorized VAULTER port-8791 sanitized source/asset/PID fingerprint receipt and reconcile it against the current isolated branch. Do not deploy while this evidence, journal recovery operations and live device acceptance remain missing.


## Continuation — 2026-10-25 source-only recovery hardening

A new behavioral RED test suite reproduced **three** unrestricted-startup defects in the previous implementation: unprovisioned audit, deleted journal after confirmed restriction, and erased zero-length journal after confirmed restriction. These all returned unrestricted history rather than failing closed.

The isolated fix adds:

- authority-audit.mjs: an HMAC-authenticated high-water checkpoint (journal SHA-256 digest, record count and chain head), checked on every authority evaluation and startup.
- tools/provision-authority-audit.mjs: explicit one-time offline journal+checkpoint creation from an existing private authority configuration, refusing overwrite or partial re-initialization.
- authority.mjs: startup rejects absent/mismatched audit storage; a confirmed mutation appends and fsyncs the journal, advances the checkpoint through a temporary fsynced file and atomic rename, then replays the fully verified pair before returning a success receipt.
- All synthetic fixtures and isolated Edge tests now explicitly provision their own disposable audit storage.
- A read-only PowerShell collector that accepts owner-selected VAULTER portal root and output path, reports SHA-256 of a fixed allowlist of source/assets and port-8791 listener/process metadata, excludes command lines and secrets, and refuses overwrite. **NOT EXECUTED ON VAULTER.**

The expanded recovery suite tests missing and erased journal, missing/both missing storage files, stale journal against newer checkpoint, matched backup restoration, checkpoint corruption, mismatched key, a valid appended journal event without checkpoint advance, and repeated provisioning refusal. A copy of the exact bytes of both journal and checkpoint is needed for restoration.

The receipt collector was exercised **on Leno only**, targeting the isolated worktree and a test JSON output path. It reported 10 whitelisted files, no local port-8791 listener, excluded source-root/command-lines/credentials, and refused a second write to the same receipt. These are **Leno test results, not VAULTER observations**.

**Residual risk:** An authorized OS-level actor controlling both files and the MAC key can still re-provision; operational ACLs, backups, trusted operator identity, cross-process writer coordination and review of restoration decisions are external safeguards. Checkpoint advancement is deliberately fail-closed on a partial transaction, which can block service until a verified matching pair is restored. Runtime changes are not proof of crash recovery readiness or deployment parity.

Neither production OAuth nor VAULTER service state was changed.


### Continuation verification result — isolated Leno worktree

- **Node 50/50 passed**, zero failed/skipped, across eight test files.
- **Headless Edge PASS:** current candidate UI loaded; simulated restriction, rollback, non-owner denial and out-of-order device response protection; local test server terminated; zero real policy edits.
- **Visual SHA gate PASS:** private HTML SHA-256 4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8, unchanged.
- **New audit module syntax check PASS** and Git diff whitespace check PASS.
- **Collector Windows PowerShell smoke PASS on Leno:** created only a new sanitized test JSON outside source; no listener on Leno port 8791; 10 whitelisted source hashes. Repeat run correctly refused overwrite. Did not run on VAULTER.
- Browser test originally encountered a CSP-blocked JavaScript-evaluation wait helper; it was replaced with supported locator expectations, without modifying or weakening the application's CSP. Rerun passed.
- The new release changes have **not** been pushed, merged, installed or deployed. Account identity, existing OAuth client/resource/scope and Windows service configuration remain untouched.

The source-level journal-loss defect is now guarded; **operator-approved VAULTER provenance, on-disk audit ACL validation, independently measured crash recovery, trusted signing and real four-device Control Center acceptance remain open release gates.**

**Isolated audit hardening commit:** `69c0c33c4466201aad97e675cde95fc04e8a85dc`. This changes no running service and is not a production release. The sanitized VAULTER receipt collector requires an authorized local operator to select the actual source root and the approved evidence-output directory; neither location has been verified through the limited connector.
