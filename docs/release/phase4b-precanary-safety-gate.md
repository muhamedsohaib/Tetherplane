# Tetherplane Phase 4B — isolated safety gate

**Status: NO-GO for release and canary installation.** No service, signing,
OAuth, Tailscale, production device or release configuration is changed.

## Source and regression
Parent: ed1b1c8cfd026081136d2e6095e67057ea2f7033, CI 39778214256
passed Windows and Ubuntu. Draft PR #43 remains stacked on
feature/codex-repeatable-acceptance-20261021, not main.

Historical-lock negative-control branch test/phase4b-hol-negative-control-20261022,
run 39788942812, recorded behavioral RED: both deterministic HOL and
in-flight duplicate-key tests failed while the historical mutex held the
provider invocation. That branch is deliberately unsuitable for merging.

The positive regression uses an explicit two-party barrier inside a test-only
provider, after the original mutation enters actual effect execution.
It requires an independent key to finish before releasing the original;
a duplicate key must return observable action_unverified/running without
dispatching another effect; a matching retry after completion must replay
the result without re-execution.

## Persistence and crash boundaries

The existing per-key file-backed protocol is retained to avoid an unsafe
state migration. Writes to a new reservation or temporary running/completion
record use File::sync_all. The running/completion versions are published
with rename; on Linux, the containing idempotency directory is fsynced
before returning. Failed pre-effect persistence stops dispatch. Failure
persisting an effect's completion produces action_unverified and
reconciliation_required rather than pretending the external effect failed.
Malformed pending records are never silently removed or retried.

The new child-process fault fixture is killed at four observed checkpoints:
reserved-before-effect, running, effect-performed-before-completion, and
completed-before-acknowledgment. On restart the first three must be
reconciliation_required; a completed result must replay without another
effect. Tests also cover failed record creation/rename, malformed pending
state, cross-generation exclusive reservation, actual persisted phase
transitions, and a provider effect followed by deliberately failed completion
publication. The latter must report an unverified outcome and reject replay
after restart. These are OS-process tests, NOT physical power-cut tests.

The storage design is intentionally limited:
- Unix fsync protects file and directory publication when the filesystem
  honors durable writes. Initialization also syncs the idempotency
  directory entry through the supplied state directory. Newly created
  ancestor directories still require a controlled initialization protocol.
- Windows file sync is used, but Windows directory-entry power-loss
  durability has NOT been proved. An existence check is not directory fsync.
- Network/shared-disk multi-host atomicity, lying storage controllers,
  unexpected media failure and entire-machine power loss remain untested.
- A database rewrite would require migration and rollback proofs for old
  idempotency keys; it is not part of this bounded repair.

## Fault isolation and release conditions

The 16-work/4-control architecture and all authorization safeguards remain
unchanged. Sixteen permanently blocked effects can still exhaust the work
plane; automatic cancellation, permit release, and replay of an uncertain
external mutation are prohibited.

Signed artifact prerequisites: pinned exact-head CI on both OS, locked build
inputs, archived package and executable hashes, independently approved
Authenticode signer and thumbprint, and a second-party signature/hash
attestation using scripts/release/verify-windows-canary.ps1. No code-signing
identity is authorized and no signed release artifact is claimed.

Rollback: the existing Windows release smoke provides temporary synthetic
install/uninstall plus preserved state evidence. It does NOT establish a
signed prior-version rollback, restored task behavior or a canary recovery
receipt. A versioned rollback rehearsal needs an isolated VM and separate
approval.

## Vercel ownership

The Vercel project tetherplane-pr22-source-preview is owned by team
The Heathens, with muhamedsohaib verified as team OWNER. PR #22's
Control Center branch has adapters/control-center/package.json and site
assets; the Phase 4B reliability branch does not. Error
NOW_SANDBOX_WORKER_ROOTDIR_NOT_EXIST concerns a preview-project
source/root mismatch, not an agent regression. Direct Vercel project
metadata did not expose a Root Directory setting. The owner must confirm
the intended preview-branch filter/configuration before any change.
Do not bypass required checks or create dummy directories.

## Proposed isolated candidate

Disposable Windows 11 VM, UEFI Secure Boot, >=2 vCPU, >=8 GiB RAM and
>=64 GiB disk; clean and post-install snapshots, synthetic mutations,
separate nonproduction relay, least-privilege identities and no live
credentials. Do not repurpose Surface, Leno, Vaulter or RTX.

**Canary installation: NO-GO** without independently verified signed
package/provenance, an approved candidate and test window, tested
prior-version rollback, an explicit decision on permanent-hang and Windows
power-loss limits, and all mandatory CI/status gates. Production is
separately NO-GO. Request approval before any installation.
