# Phase 3 pre-canary readiness — nonproduction only

**Release decision: NO-GO.** This document does not approve installation, deployment, authentication changes, restarts, tagging, or publication.

## Scope and retained evidence

Draft PR #43 on `diagnostic/leno-relay-recovery-20261022` is the sole reliability integration branch. The completed Phase 2 baseline `f3b5c8cec176ad2982db272ff33efd4601804f95` passed Windows/Ubuntu CI; do not overwrite its independent observations or source/build fingerprints. Preserve owner-created VAULTER Workspace reports, process start/mtime evidence, logs and the XERJ/OpenCode evaluation. None of these is to be reset or deleted.

## Execution and uncertainty policy

- **Nonmutating operation:** an exceeded bounded execution deadline may cancel its read-only future; caller receives `timeout`, not a claimed successful result. No authorization shortcuts.
- **Mutating operation:** an MCP route timeout, WebSocket write timeout or client disconnect is **not evidence that execution did not happen**. Keep execution running with its ownership/permit until its authoritative result or a separately authorized intervention. Never replay implicitly.
- **Durable idempotency:** a reserved pending mutation must be reported as `action_unverified` until the local state can be reconciled; do not erase pending records, invent success, or reuse the key for a different payload.
- **Exhaustion:** retain the 16-work/4-control isolation. If all 16 mutating operations are permanently uninterruptible, reject additional work and preserve remote authenticated control responsiveness; automatic safe reclamation is **not proven**, and this is a canary gate. A watchdog that releases slots while underlying effects continue could create unbounded concurrency; it is forbidden.
- **Transport:** blocked response writes must not permanently hold a shared mutex. A write deadline produces uncertain acknowledgment, not mutation cancellation.

## Authenticated liveness semantics

Static relay `/healthz` and `/readyz` indicate only relay HTTP responsiveness. A registered WebSocket indicates an authenticated transport connection, not an executing agent. Successful authenticated `device.status` is an active request-response sample (alive, responsive, capacity observation). Lack of such a response is `unverified/unresponsive` from the caller's viewpoint; do not infer why from a timeout. Saturation counts are best-effort instantaneous; they do not certify the physical device or prove progress for permanently blocked CPU tasks.

## Signed Windows canary candidate — preparation procedure only

1. Pin the exact approved draft-branch commit after **both** CI jobs pass. Preserve the existing `release.yml` tag-only publication boundary; do not invoke it.
2. Use `scripts/package-windows.ps1 -OutputPath <isolated-dir>` in a clean isolated authorized Windows build environment. Package `manifest.json` records source commit. Preserve complete build logs, Windows packaging smoke logs, dependency/lockfile identity and any reproducible build inputs.
3. **Signing is not available in the current ordinary CI.** Signing requires a separately approved trusted code-signing certificate/workflow; do not create a certificate, self-sign as a substitute or use unrelated credentials. An unsigned package is never labeled signed.
4. After approval and actual signing, run `scripts/release/verify-windows-canary.ps1` in read-only verification mode with package root, source SHA, independently approved signer thumbprint and external output manifest. Fail closed on missing/wrong signature, commit mismatch, missing agent binary or changed component SHA.
5. Hash **all** packaged files (especially `bin/tetherd.exe`, JS relay modules and launch/install scripts), archived ZIP, signatures and attestation. Have a second verifier independently recompute checksums without trusting build machine output. Do not store credentials in artifacts.
6. No installation in this phase; signed canary binary **not produced/verified yet**.

## Proposed controlled canary acceptance (requires separate approval)

- Owner designates **one nonproduction authorized Windows canary**, maintenance window, named operator, allowed read-only probes and explicit permitted synthetic mutations, and protective rollback approver. RTX, Surface, Leno and VAULTER remain unchanged until separately authorized.
- Snapshot previous signed installation, exact PIDs and process start times, installed hashes, scoped configuration *without exposing credentials*, current tasks/services/ports, state/audit files, and operator rollback bundle. Validate rollback inputs and integrity before touching anything.
- Stage side-by-side without modifying existing installation; confirm exact signed manifest, Authenticode chain, approved signer identity, hash consistency, permission boundaries and scope denials.
- With authorization, measure control-plane p50/p95/max under 16-work saturation, 4-control saturation, read-only deadlock, controlled child session exits, slow/blocked sender and EOF/reset, uncertain mutation recovery and idempotency. Detect and reject duplicate agents/workers.
- Require independent status and capability probes and correct denial of foreign principals. Verify process-exit supervisor behavior separately; a live process whose dispatch loop hangs cannot be treated as recovered just because PID remains alive.
- A rollback must stop only canary-owned new processes under an approved plan, restore prior artifact and task configuration, verify previous signatures, hashes, audit continuity and control-plane state; never delete unrelated worktrees or state. Owner witnesses and signs acceptance.
- Expand to four-device architecture **only after** canary proves install/recovery, route-event trace, timeouts, denial, signed build and full rollback; avoid unapproved production fault injection.

## Vercel classification (no suppression)

At Phase 2 and Phase 3 preview attempts, `tetherplane-pr22-source-preview` has `NOW_SANDBOX_WORKER_ROOTDIR_NOT_EXIST`: project configured with root `adapters/control-center`, absent from this branch. Failure occurs at build-container initialization, before relay runtime tests. A legitimate fix is to inspect the actual intended Vercel project and, if a supported web app is still maintained, set its Root Directory to that tracked app's real path with an appropriate build/output config. If the project is an obsolete historical preview, obtain explicit owner approval to retire/disconnect its integration or migrate to a proper source project; do not spoof missing root, bypass or suppress a required check. Do not change Vercel settings in Phase 3.

## Release blockers

Unbounded physically hung mutating provider; no external reconciliation authority for ambiguous effects; transport liveness under CPU starvation; memory/handle measurements on real Windows with long-running workloads; full signed-build provenance; clean-install and rollback practice; Vercel required-check ownership; independently verified four-device acceptance. **NO-GO**.
