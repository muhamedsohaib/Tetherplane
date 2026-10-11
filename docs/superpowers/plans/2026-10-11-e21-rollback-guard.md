# E21 rollback guard implementation plan

**Goal:** Preserve operator recovery when the original supervised Auth0 action has already been restored but restart or health verification was interrupted.

**Architecture:** Keep the protected action-only handover and existing rollback helpers. Correct evaluation of the manual rollback guard without changing the supervisor, native launcher, issuer, credentials, routing or installed state.

**Spec:** `2026-09-17-tetherplane-design.md` and `2026-10-10-vaulter-supervised-bridge-integration.md`.

## Constraints and review focus

- Source-only work on `feature/vaulter-supervised-bridge-integration-20261010`, starting at `74be01841e565156d38d3b3e7c3e8fc065d320e8`.
- No live activation, protected-stage edits or service inspection by this work.
- Preserve the original bounded Auth0 supervisor, rollback checkpoint, failed-stage archive and all private ports.
- A rollback must accept either recognized action and reject unknown actions before mutation.
- Exercise the actual manual rollback branch; the existing transaction tests do not cover it.
- An already restored running fallback must not restart; an already restored Ready fallback may restart only with a vacant port.

## Task 1: Correct and verify manual recovery

- [x] Add behavioral cases to `tests/release/vaulter-relay-supervised-bridge-handover-contract.ps1`, extracting the real rollback branch and helpers while replacing only external task, port and health operations with synthetic fixtures.
- [x] Observe the expected failure on Windows PowerShell 5.1 and PowerShell 7 before implementation.
- [x] Parenthesize both predicate calls in the production rollback guard.
- [x] Run both targeted shells and related isolated bridge/supervisor contracts (13 contracts per shell; 26 successful runs).
- [ ] Commit and push the verified fix; inspect full Windows/Ubuntu CI at the resulting SHA.
- [x] Record the operator preservation/re-staging procedure below. Pin the final SHA after CI; live execution is a separate gate.

## Root cause and review result

In PowerShell command mode, `(Test-TaskIsBridge -or (Test-TaskIsAuth0))`
passes `-or` to the first function. It does not combine the two returned
booleans. Therefore the manual rollback entry point refuses an already restored
Auth0 action. This matters if action restoration succeeds and the later start
or health verification is interrupted. The automatic transaction rollback uses
different calls and was not the failing path.

The new regression executes the real manual branch with real action predicates,
restore and start helpers, using synthetic task/port/health boundaries. Its first
case failed on both shells with `restored Ready Auth0; accepted=False; events=`.
The one-line production correction made both shells pass. Cases also cover a
running fallback, a stopped bridge, unknown registration and occupied port.

The source review covered the protected handover, bounded restart loop, native
launcher, bridge child helper, independent auth postcheck and their contracts.
The public/private route checks, Auth0 preservation and native secret inheritance
remain unchanged. This is not proof of live process-tree shutdown, bridge
recovery, authenticated device routing or reboot behavior.

The older `vaulter-relay-supervisor-handover.ps1` has the same expression pattern
in its separate manual rollback guard. It is outside this bridge migration's
recovery path. Do not use that older handover to recover E21 or change its
protected installed files as part of this fix.

## Guarded operator continuation (proposal, not execution)

1. Keep `relay-supervisor-bridge` at 74be018 untouched until the new feature head
   has passing full Windows/Ubuntu CI and both PowerShell bridge contracts.
   Confirm that head again immediately before preparation; do not follow a moving
   branch implicitly.
2. In an operator-controlled Vaulter session, create a NEW detached review
   worktree at the verified SHA from the canonical GitHub remote. Verify exact
   HEAD, origin and a clean worktree. Never reuse or overwrite a review directory.
3. Run a read-only preservation preflight: verify current stage manifest and
   source pins, protected stage ACL, original task XML equals the saved
   `pre-supervisor-task.xml`, original supervised relay ownership, unchanged auth
   process, native bridge preflight and independent postcheck. Also require the
   earlier `relay-supervisor-bridge.failed-31a3975` archive to remain protected.
   Keep all metadata and process command lines in memory; report only checks.
4. Only after a visible passing result, separately approve preserving the 74be018
   stage and creating its replacement. Record every file digest, ACL and runtime
   configuration path privately. Rename that exact stage to a NEW sibling such
   as `relay-supervisor-bridge.pre-e21-74be018`; reject an occupied destination or
   any reparse point. This operation must stay under the canonical private state
   directory. Do not modify the original `relay-supervisor`, pre-bridge checkpoint
   or failed-stage archive.
5. Invoke the new reviewed source handover with `-Stage`, all required source
   digests, the new reviewed commit and the existing runtime/config/registry
   paths from the preserved stage. Revalidate those paths and runtime digests;
   never reconstruct credentials or copy a secret. Require the newly generated
   task snapshot to equal the preserved original snapshot and the same relay/auth
   process identities before and after. Stage refuses an occupied target.
   On a staging failure leave the partial replacement and preserved archive
   intact; the original relay remains the fallback. Diagnose before retrying.
6. Run fresh read-only handover/native/postcheck verification on the NEW stage.
   Require the corrected handover hash, exact CI-verified source commit, preserved
   rollback snapshot, unchanged Auth0 metadata and all four tailnet-only ports.
7. Only then obtain a separate visible operator activation decision. The guarded
   activation entry point is the protected installed handover's `-Apply` mode;
   it must not be run from a source checkout. Staff the corrected installed
   `-Rollback` path and independently verify health after either outcome.
   Do not run the older supervisor handover or an arbitrary process kill.
8. Keep activation, same-supervisor crash recovery, authenticated six-tool/device
   routing, local-policy denial and reboot acceptance as distinct gates. Do not
   infer any of them from a passing source or health test.
