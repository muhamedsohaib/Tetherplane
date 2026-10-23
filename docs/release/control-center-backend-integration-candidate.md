# Tetherplane — source-only combined integration candidate

**Prepared:** 2026-10-23. **Status:** NOT DEPLOYED, NOT MERGED, NOT PRODUCTION-READY.

## Exact source provenance

- Base: draft PR #46 native Windows onboarding, commit `9e9bef7947f292bd8b8eda0b0dbed60fbaf18296`.
- Added without editing: exact Control Center files from draft PR #35 at `72c4e2b6714719d84166d2e8b31cf64d1fd169ad`, including `server.mjs`, `oauth.mjs`, browser behavior JS, HTTP/OAuth synthetic tests, owner-HTML verifier and installer. An existing local-only frontend on VAULTER port 8791 was reported, but it has not been read or modified during this integration.
- Added without editing: recovery guard, Pester tests and instructions from draft PR #47 at `68138090c1c447ffd5d8303d6916f00ea904cac7`.
- Reliability workflow: preserved every job and path gate from PR #46 and added PR #47's guarded recovery job and source path filters. Exact UI workflow uses the repository's already vetted checkout action SHA.
- New `adapters/control-center-exact/test/real-relay-compat.test.mjs` exercises a **genuine current relay control HTTP gateway** from this same checked-out commit, against the genuine exact portal server, on ephemeral loopback ports with in-memory synthetic accounts. It tests explicit pairing approval and CSRF, account-scoped device directory, typed revocation, device-secret invalidation and denied unauthorized or revoked device access.

## Deliberately preserved boundaries

- The approved original `public/index.html` is **not** in Git, not reconstructed from fixtures, and not redistributed. Original local asset SHA-256 must equal `36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82` during later on-device visual acceptance.
- No client registrations, OAuth callbacks, issuer configuration, scopes, resource audiences, identity files, device credentials, production relay, Tailscale ACLs, Windows task, firewall, RDP session or VAULTER listener changed.
- All new tests use loopback and synthetic identities. A green workflow does **not** prove real browser OAuth, current VAULTER port state, actual four-device status, pairing on real hardware, signed packaging or reliable unattended crash recovery.

## Test contract

1. Exact Control Center Windows + Ubuntu Node tests, including the new real-relay control-plane E2E tests, at one immutable commit.
2. Existing Windows native onboarding, signing-policy, Windows/Linux quality CI, agent WS liveness and guarded recovery regression suites at that **same** commit.
3. Review any failures without disabling checks, re-registering auth clients or overwriting owner-held artwork.
4. Later controlled acceptance: same-original-HTML visual interaction, approved live browser OAuth, one authorized device pairing, authorized status/permission-denied, device revocation/reauthorization, offline/reconnect states, clean signed Windows install, rollback and independent four-device run.
5. Keep PR #35, #46 and #47 as separate draft sources; this staging branch and PR are a reproducible **candidate**, not authorization to merge/deploy.

Related mandatory release blocker: [Issue #48](https://github.com/muhamedsohaib/Tetherplane/issues/48).

## Independent follow-up verification — 2026-10-23

The owner confirmed this tracked handoff at `63f1398a1b57ca65ed4824be46f549fc125f51c1` as authoritative; the missing chat attachment is not required. Follow-up work uses a separate linked checkout from the canonical repository. The dirty primary checkout and every other worktree were left untouched. The app's worktree creation returned `Not a git repository`; its attachment tool rejected the fallback as unmanaged. The fallback remains a normal Git linked worktree, not an app-managed attachment.

### Refreshed GitHub evidence at the original integration source

All five Actions workflows completed successfully. Their tested PR merge commit `5eb32044b9cf843cc47280468fbe91e4e2a53814` and branch HEAD `63f1398a1b57ca65ed4824be46f549fc125f51c1` both have Git tree `892fd281523b5742a0855b3a4f61d748e8c1371b`, independently recomputed locally.

| Workflow | Result | Evidence |
| --- | --- | --- |
| Full Windows/Ubuntu quality CI | Both jobs successful, including Clippy, Rust/TS tests and builds; Windows binary/package/negative canary; Linux containers | [39915474573](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39915474573) |
| Exact portal | Windows and Ubuntu successful, 22 tests each | [39915474681](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39915474681) |
| Native onboarding | Successful; log confirms 147 passed, zero failed/skipped; disposable unsigned kit/task | [39915474624](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39915474624) |
| Lifecycle/liveness/recovery | All four jobs successful; Windows guard log confirms 22 passed, zero failed/skipped | [39915474625](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39915474625) |
| Authenticode policy | Both PowerShell policy jobs successful; no publicly trusted signature established | [39915474567](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39915474567) |

These are original-source results. Follow-up source edits require their own fresh exact-head CI. Platform-inapplicable E2E cases are skipped by the existing full suite; green CI is not full real-device acceptance.

The separate Vercel status remains **failure**. Authenticated read-only Vercel inspection and build events confirm deployment `dpl_CuTtoBLLnyGW7MUJ18NCtHyEFGc1`, branch `integration/control-center-windows-20261023`, source `63f1398`, fails with `NOW_SANDBOX_WORKER_ROOTDIR_NOT_EXIST` at `build-container-init`: configured root `adapters/control-center` is absent. This is not a relay or portal test failure. No Vercel project settings, build roots, protection or integrations were changed. Do not deploy the loopback operator portal or substitute its fixture to repair this badge.

### Fresh device observations and denied boundaries

| Device | Actual read-only result | Limit |
| --- | --- | --- |
| VAULTER | `device.status` succeeds: Windows x86_64, agent `0.1.0`, `background_only` | No exact binary/source provenance or Control Center proof |
| Leno | Same version/platform/policy; authenticated transport, process alive, responsive and ready | Connector-originated status, not frontend acceptance |
| Surface | Same version/platform/policy; authenticated transport, process alive, responsive and ready | Connector-originated status, not frontend acceptance |
| RTX | `disconnected`, requested device offline | No fourth-device acceptance |

- Desktop Commander lists VAULTER online (its app version is `0.2.50`, **not** a Tetherplane version), but the one read-only loopback request is blocked by its monthly usage quota. Its response says not to retry or reconnect; neither was attempted.
- VAULTER `browser.pages` returns `permission_denied` for the limited principal. Its portal-checkout file read returns `permission_denied`, outside configured allowed directories. No browser mutation, process-based filesystem workaround, credential read, port forwarding or listener change followed either denial.
- Initial unscoped discovery returned `device_id is required when multiple devices are online`; lowercase `vaulter` was unknown. The exact `VAULTER` route succeeded. Neither routing error is an offline-device observation.
- Current port 8791 health, process PID, runtime Git SHA, owner HTML hash, screenshot, browser session and actual frontend-to-device actions remain **unverified**. Historical October 20 OAuth/browser evidence must not be presented as fresh acceptance.

### Follow-up source changes and independent tests

The original assembly copied PR #35's tracked adapter files unchanged. This follow-up changes only its behavior JS and adds tests; `server.mjs`, `oauth.mjs`, `tp-oauth.js`, original HTML installation/verifier, OAuth identities/scopes and native runtime remain unchanged.

- Added `relay/test/control-center-mcp.test.mjs`: actual `ExactPortal` -> actual Streamable HTTP MCP -> actual `RelayServer`/router -> real WebSocket transport with a **synthetic** device peer. Tests prove canonical identity binding, returned device data, preserved policy denial, offline/reconnect results, route timeout without mutation replay, and real session cleanup (later use receives HTTP 404). The peer does not execute a native command or enforce real device policy.
- Added this MJS test to the existing relay test runner. The lockfile only gains the empty importer for the already-present private portal package; no dependency version changes.
- Added behavior-script tests using `node:vm`, minimal page globals and synthetic HTTP responses. Before fixing code, three tests reproduced a second MCP POST after transport failure, route timeout or disconnect; another reproduced an empty-account claim after a failed refresh. A separate RED test reproduced false sign-out confirmation when logout transport failed.
- Minimal UI fixes fence later MCP commands until a successful explicit directory refresh, never replay a command during refresh, preserve definite denials, show `DIRECTORY UNAVAILABLE` on failed observations, and warn when server sign-out is unconfirmed. A directory refresh does not prove a prior arbitrary operation's outcome: the operator must confirm that outcome before retrying it. Sign-out warning changes no server session or authorization behavior.
- Local Windows Node `24.19.0`, pnpm `10.34.5`: portal **28/28**, relay **82/82**, relay TypeScript check and `git diff --check` pass. An independent reviewer also exercised actual MCP success/denial and session deletion; the final follow-up review is recorded on the draft PR. These tests provide no owner-artwork visual, actual browser OAuth or installed-device acceptance.

### Concrete remaining gates and next intervention

1. **Obtain an authorized local VAULTER receipt** without widening policy: current listener/PID, executable/package and Git provenance, and SHA-256 of the existing on-disk owner HTML. The required original hash remains `36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82`. An owner-operated read-only check is appropriate while remote access remains denied. Do not request auth JSON or credential contents. The hash of the served page is different because scripts are injected at runtime; hash the source asset on disk.
2. **Resolve first-use kit instructions before install acceptance.** `scripts/setup-windows-device.ps1:Get-ApprovalInstruction` and generated kit README still direct the user to `device(op="approve_pairing")`. This source's compact translator forwards it as `device.approve_pairing`, with no corresponding native handler. The existing portal already offers owner-confirmed `POST /api/pair/approve`; the next source intervention should reconcile kit guidance with that approved management path and test the complete fresh-device flow. Do not add an ad hoc seventh tool, new OAuth scope or device-side approval authority.
3. **Run supervised frontend acceptance** against the exact staged source and owner HTML: approved browser OAuth/denial/expiry; account directory; permitted status/read and local denial; all four devices, including RTX recovery; pairing/revocation only with explicit owner approval; timeout/error/reconnect, measured first status, rollback and independent observation. No live mutations were performed here.
4. **Keep native release holds:** approved trusted signing, clean Windows first-install/upgrade/uninstall, privilege-matched guard start/recovery and verified out-of-band recovery, reboot/logon and exactly-one-agent evidence. Disposable CI is not that evidence.
5. **Review the preview's intended product and distribution rights** before any Vercel change. The owner HTML remains private and excluded from Git. No root repointing or failure suppression is authorized.

Minor known limitation: plain static-token portal sessions expire for authorization at 15 minutes but idle expired entries are pruned on a later request; its credential-memory wording is stronger than this cleanup behavior. OAuth mode has its own cleanup timer. No server authentication behavior was changed in this follow-up; bounded cleanup/wording review remains separate.

**Decision: production NO-GO.** The candidate remains draft; no protected merge, deployment, signing/authentication change, device credential change, production task change or live process shutdown is authorized by this record.
