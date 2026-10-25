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


## Additional release-gate investigation — October 25, 2026

**Source-only hardening (not deployed):** A deterministic RED test proved that a pre-existing audit writer lease did not block a second actor's write. The fix uses an exclusive journalPath plus ".writer.lock" lease, acquired before full journal replay, mutation append, checkpoint fsync and verification. Other writers fail with authority_writer_busy without changing the journal or checkpoint; a normal completed write removes its own lease. A stale lock after process crash deliberately requires review, never time-based or forced removal. This is one-host filesystem coordination, **not** independent evidence for distributed shared/network storage, Windows ACL security or unattended recovery.

A second RED test showed that an unexpected HTTP failure could tell the owner "No change was applied" even if a write was durable but an acknowledgement failed. The generic 503 response now states that the outcome is uncertain and instructs a verified audit refresh before further mutation.

**Verification:** Control Center Node **52/52 passed**, 0 failed/skipped, including both new RED/GREEN controls. Current HTML fingerprint remains 4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8. Headless Edge simulated authority/restriction/rollback and stale-response behavior passed without live mutations. Release contract Node tests **48/51 passed with 3 platform-specific skips and no failures**. All four device.status routes returned Windows x86_64 agent 0.1.0, background_only; VAULTER deliberately denied browser.pages under its limited principal.

### Windows onboarding acceptance — deliberately NOT counted as passing

Existing onboarding PowerShell 5.1/Pester 3.4 suite was run on Leno without a release-built target/release/tetherd.exe. Outcome: **142 passed, 5 failed, 0 skipped**. This does **not** constitute native signed-package, clean-install or task lifecycle acceptance.

The failures are discriminated:
- 1 real-agent acceptance test requires exact worktree release-built tetherd.exe, which is absent.
- 3 device task tests refuse registration/reuse on Leno because an existing Tetherplane agent/process/identity is present. These are correct **safety guards**, not evidence that a clean machine can install.
- 1 Windows SIP/PE test needs an accessible embedded-Authenticode PowerShell executable. Independent read-only probe found Windows PowerShell's powershell.exe has **Valid/Catalog** signature; pwsh.exe returns **IOException: The file cannot be accessed by the system** on Leno. No protected executable was modified and no trust policy weakened.

The Pester suite took ~333 seconds. Further on-device installation trials must occur on a **newly provisioned authorized disposable Windows machine/VM**, not on Surface, Leno, VAULTER or RTX with current production identities. A request to terminate that specific test runner through Tetherplane process.terminate was blocked by local approval_required, and no alternate termination technique was used. The suite subsequently exited with code 1. Afterward, Leno's authenticated device.status remained available.

### Current constraints and release gate matrix

| Gate | Status | Independent evidence still required |
| --- | --- | --- |
| Four existing agent routes | PASS for connector status only | Control Center OAuth session, each device's authorized/denied behavior via that panel |
| Isolated portal authority Node suite | PASS 52/52 | Multi-process writer stress, production journal ACL and supported recovery |
| Browser UI simulated acceptance | PASS on isolated Leno | Owner-approved real OAuth login/expiry and actual browser-to-relay read-only operations |
| VAULTER port 8791 deployment | BLOCKED by intentionally limited principal | Owner-executed sanitized read-only listener and source/artwork fingerprint receipt |
| Native Windows onboarding | 142/147 host-incompatible, not accepted | Clean machine/VM; exact-source built agent and independent install/upgrade/rollback |
| Trusted Windows signing | NOT VERIFIED | Provider-approved code signing identity, thumbprint, timestamp and protected signing workflow |
| Production identity/policy | UNCHANGED | Explicit authorization for any protected deployment or admin activation |
| Artwork source version | UNRESOLVED | Owner decision between historical original and current private candidate SHA versions |

Leno capacity measured during testing: ~0.75 GB free physical RAM and ~95 GB free C:; no Rust release build was started under this pressure. Surface showed ~7.2 GB RAM free, RTX ~23.6 GB, but both are already registered devices rather than clean installers. No available machine was assumed to be a disposable authorized canary.

**Next human-controlled dependency:** Run the existing read-only collector locally on VAULTER under an authorized operator using its exact existing Control Center source root and a permitted receipt-output directory. Return only its sanitized metadata JSON. No process execution, identity mutation, authenticated browser login, or unsafe workaround was attempted through the restricted VAULTER principal.

**Release decision remains NO-GO**, and this branch remains local until an approved source-sharing/review step. Passing synthetic tests or existing device.status is not a production release attestation.


## Actual VAULTER port-8791 receipt comparison — 2026-10-25

**Evidence type:** The owner provided the JSON body of a locally executed, read-only deployment receipt. Captured 2026-10-25T04:26:13.2194190Z. Receipt path on VAULTER: C:\Users\muham\Desktop\vaulter-control-center-20261025-082608.json. Its independently reported SHA-256 was c7bbd4f41646f6588753d65b4e9b03543f46061244f6fd265f04a71718817298. This is a user-supplied receipt; the restricted connector cannot independently read the Desktop or deployment root. Do not treat the receipt as an attestation of the Node process's exact loaded JS.

**Observed deployment:** C:\ProgramData\Tetherplane\ControlCenterReleases\20261025-approved-oauth, localhost listener 127.0.0.1:8791, PID 5016, node.exe started 2026-10-25T00:50:32.3712350Z. Node executable SHA-256 3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237; executable hash is not application source provenance.

**Candidate:** Leno feature/device-authority-20261025, HEAD 79ca36acae62ec6174f522958634e1d61f964e93 at reconciliation. Its 10 source fingerprints were independently computed through read-only Get-FileHash.

| Relative path | Deployed VAULTER | Leno candidate | Result |
| --- | --- | --- | --- |
| server.mjs | aa6bdab77879780aa5bf3164aba1a2b51d50df8b117fa74e68221d84cf7353b8 | bd41f7cf13544e637ab4d3b1bc521f6f902a4784f39db951569a913b98fad2ec | DIFFERENT |
| oauth.mjs | 4e187df4a1e9fbcca934b21064544142801b0a67401761ee8cbf18d0d13a0e29 | 379750684abc302e4164fe07ac4191ec2ff42cf1b547d946f60d86741a622a17 | DIFFERENT |
| authority.mjs | MISSING | b52bb4b5a2e82b1af4587d043e2bc5432b6ee2a923a8e25ab247b5b0175a5bbc | NOT DEPLOYED |
| authority-http.mjs | MISSING | 8a56e6c6cf3e84c2a9571e6942a74a6f03f67f52223dc83ca376d5ac2fddc1d6 | NOT DEPLOYED |
| authority-audit.mjs | MISSING | ecbc57518405796bbc10063da759fb85bc23fef3a3e77621da8e9ce3bbf10c85 | NOT DEPLOYED |
| public/index.html | 4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8 | SAME | EXACT BYTE MATCH (116329 bytes) |
| public/tp-integration.js | 956e79fe108bcd16579211c54f663b042e07547fc6a61bfb91cb3da5d2735175 | 865090b34fc3ba74efe62f39db9884441662be75d18ba60892d1fac154212bcc | DIFFERENT |
| public/tp-oauth.js | d6eed7795247417d13e472aba88c39076ab7883e042080aa1571b246b90a4195 | SAME | EXACT BYTE MATCH (90 bytes) |
| public/tp-authority.js | MISSING | 6cd15a06d1b8cb25481d4d3b9cc959fc7fcae176de2270aaa6f24d534b3c4047 | NOT DEPLOYED |
| tools/verify-original.mjs | MISSING | 8250f96e430c999c5fb602b15f2a77afb7d905a421bc8781ce0efc427c872b1a | NOT DEPLOYED |

**Provenance search:** A read-only search of the 18 known Leno Tetherplane worktrees proved that VAULTER's oauth.mjs SHA matches multiple older integrated worktrees, including integration-release-audit-20261023 and vaulter-recovery-20261024. The deployed tp-integration.js SHA exactly matches the separately preserved TetherplaneDeviceAuthorityStage-20261025/public/tp-integration.js, allowing an exact local source comparison. The deployed server.mjs SHA did NOT match those 18 local worktrees. A subsequent Git-history search checked the five distinct committed server.mjs revisions (six commits) with both LF/CRLF transformations; it still found no match. The deployed server.mjs therefore requires owner-approved source review; the exact delta is UNKNOWN and must not be guessed.

**Known source differences:** Candidate oauth.mjs adds the optional AuthorityHttp integration, authority routes, optional authority JS serving and --authority-config parsing. Candidate tp-integration.js adds uncertainty fencing and correct directory-unavailable and sign-out messaging, plus HTTPS OAuth URL portability. Those two diffs were independently examined against their hash-matched local baselines. The current VAULTER server.mjs cannot be safely overwritten with candidate code until its true contents have been reviewed and preserved.

**Private font asset issue found and corrected in isolated candidate:** The identical owner HTML requests /tp-font.woff2, which was missing from the Leno feature worktree although its server exposes the route. The originally staged 40,404-byte private font was found at the earlier authorized staging location with SHA-256 18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e and copied byte-identically to the isolated candidate. It is excluded from Git by public/.gitignore and must not be published without distribution-rights review. The manual visual verifier now pins both the original HTML and this asset. Headless Edge verified the real font HTTP route and original UI with synthetic authority behavior. **53/53 Node tests passed** and the isolated Edge test passed. These results do not certify that VAULTER's unlisted font asset is present or byte-identical.

**Next minimal dependency:** Obtain the exact deployed, 20,808-byte server.mjs code through owner-authorized, source-only review. Do not export OAuth config, credentials, journal, private owner data, or process command lines. Compare the loaded production server's features with the known original version and preserve unrelated fleet-presence/OAuth fixes before any side-by-side stage. The audit/authority modules are intentionally not active in VAULTER's existing production release; no production change was attempted.

**Still NO-GO:** Exact server source reconciliation, proper local ACL and recovery acceptance, owner-approved real Control Center OAuth flow, trusted signed Windows artifact, clean-install/rollback trial and multi-device independent acceptance remain release gates.
