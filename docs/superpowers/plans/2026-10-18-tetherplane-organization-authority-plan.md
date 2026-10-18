# Tetherplane Organization Authority and Policy Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver authenticated, multi-organization identity, complete-grant authorization, versioned local-enforced policy, bounded offline authority, and tenant-safe execution/resource state.

**Architecture:** Extend existing Plan A.5 principal/job/policy semantics, the self-hosted OIDC/relay, and the durable device SecurityState built in the containment phase. A modular self-hosted TypeScript organization authority owns membership, delegation, policy issuance, and publication; the Rust agent validates and atomically activates signed device snapshots, then intersects them with local ceilings. Neither the management service nor the relay executes capabilities, and an organization administrator never implicitly becomes a machine operator.

**Tech Stack:** TypeScript 5.8 / Node, pnpm 10, current `@tetherplane/auth` and `@tetherplane/relay`; SQLite WAL with FULL synchronous durability and a verified patched runtime; Rust edition 2024, Tokio, serde, reviewed Ed25519/DSSE + RFC 8785 JCS libraries, `@tetherplane/protocol`, existing test suites.

**Spec:** `docs/superpowers/specs/2026-10-18-tetherplane-organizations-access-control-design.md`, explicitly approved at `c4fdc5a8cb69972828f95e66da0e2d97d57ed47d`.

**Execution order:** Second of three plans. Preconditions: `2026-10-18-tetherplane-containment-foundation-plan.md` has proven its safety interfaces. Next: `2026-10-18-tetherplane-administration-personal-mode-plan.md`. No intermediate phase is a public organizations-first release.

## Global Constraints

- Canonical authorization is organization scoped, principal scoped, device/resource scoped, complete-grant matched; default DENY, applicable denials prevail.
- Human user identity uses verified OIDC `(iss, sub)` pairs. Matching email is never authentication, identity linking, or account merging. Distinct membership creates distinct organization principal.
- Initial device belongs to exactly one organization. Human users may belong to several. Groups are flat; roles are independent templates: owner, organization administrator, access administrator, operator, approver, auditor.
- Role administration cannot supply machine-execution authority or permit indirect grant/credential self-escalation. Human sponsorship applies to all service principals.
- Self-hosted single-node SQLite has one active writer. `PRAGMA journal_mode=WAL`, `synchronous=FULL`, foreign keys and tenant-qualified references are mandatory. Only a runtime whose loaded SQLite includes the WAL-reset fix (upstream 3.51.3 or a later supported release, excluding withdrawn 3.52.0, or an independently verified patched/backported build such as 3.44.6/3.50.7) may start.
- Signed policy snapshots use DSSE v1 payload type `application/vnd.tetherplane.policy-snapshot.v1+json`, UTF-8 RFC 8785/JCS canonical payload, DSSE PAE signature input and separate policy-body and full-payload digests.
- Device/grant audience and enrollment generation are authenticated. A full snapshot's verified revision/sequence/high-water and activation barrier must be persisted atomically. Unsupported newer requirements block affected operations.
- Offline cached authorization lasts at most **300 seconds** (or less); renew near **60 seconds**; restart, rollback, unreliable clock/suspend require authenticated resync. Approval-gated dispatch requires live authority.
- No per-action central lookup may override the final local broker. Outage means bounded, individually scoped offline work, not an automatic privileged local fallback.
- Jobs, handles, approvals, idempotency, cached results, audit, outputs, temp artifacts, sessions and reconnects are tenant-owned and reauthorized on every use.
- Preserve existing paired device identity/records and local stdio launch-bound principal. Organization-managed execution never maps to a fallback launch/global identity.
- Do not change installed Leno, relay production, authentication credentials, Smart App Control, or another device. Commit only reviewed feature work on an isolated branch after RED/GREEN and complete relevant gates.

## Review Focus

1. Two verified identity providers issue the same email: `same_email_different_issuer_subject_never_merges` keeps separate users (Task 2).
2. An access administrator alters group membership to give themselves execution access: `delegated_group_update_cannot_self_escalate` rejects before commit (Task 3).
3. A relay client spoofs `organization_id` in JSON under a valid token for another organization: `forged_tenant_arg_does_not_select_context` rejects (Task 4).
4. A newer revocation is committed while the authority renewal worker holds an older snapshot: `revocation_wins_snapshot_renewal_race` ensures old grants are never renewed (Task 6).
5. An idempotent retry after membership revocation requests a cached successful output: `revoked_retry_must_not_reveal_cached_result` rejects before data disclosure (Task 7).

## File Structure and Interfaces

| File | Responsibility |
| --- | --- |
| Create `management/package.json`, `management/tsconfig.json`, `management/tsconfig.test.json` | New `@tetherplane/management` package; included in pnpm workspace |
| Create `management/src/{schema,store,sqlite-runtime}.ts` and `management/src/migrations/0001-authority.sql` | Transactional multi-tenant storage, patched SQLite verification, versioned migrations, exclusive writer |
| Create `management/src/{identity,membership,delegation,grants}.ts` | OIDC identity linking, membership and service lifecycle, independent roles, complete grants |
| Create `management/src/{device-enrollment,policy-publisher,policy-outbox}.ts` | Local enrollment consent, authenticated signed snapshots, transactional revocation/renewal |
| Create `protocol/src/{organization,policy-snapshot}.ts` and `protocol/fixtures/policy-snapshot-v1.json` | Typed JS contracts, RFC 8785 canonical bytes, DSSE cross-language vectors |
| Create `agent/tether-core/src/{organization,organization_policy}.rs` | Provider-neutral authenticated context and complete-grant/local-veto checks |
| Create `agent/tetherd/src/{authenticated_execution,policy_snapshot,revocation}.rs` | Trusted transport binding, transactional policy activation, expiry/revocation barriers |
| Modify `agent/tetherd/src/{runtime,relay_ws,stdio_rpc,idempotency,job,audit}.rs` | Remove single global execution-principal assumption for remote requests; enforce tenant on state and replay |
| Modify `relay/src/{auth/oidc-auth,routing/device-router,mcp/http-gateway,devices/registry,devices/ws-gateway}.ts` | Signed incoming organization/session context, one-org device routing, generation checks |
| Test `management/test/*.test.ts`, `agent/tether-core/tests/organization_policy.rs`, `agent/tetherd/tests/organization_policy.rs`, `relay/test/organization-routing.test.ts`, `tests/e2e/organizations-authority.test.ts` | Identity, delegated permissions, cross-language policy signatures, tenant isolation |

Implementation must preserve the canonical `InvocationEnvelope` provider semantics and its actor/model provenance. `AuthenticatedExecutionContext` exists only after trusted transport validation and is not caller-deserializable. `ApprovalIntent` and UI endpoints belong to Plan 3; this plan implements the policy and authorization prerequisites.

---

### Task 1: Patched SQLite management store and secure bootstrap records

**Files:**
- Create: `management/package.json`, `management/tsconfig.json`, `management/tsconfig.test.json`, `management/src/{sqlite-runtime,schema,store}.ts`, `management/src/migrations/0001-authority.sql`
- Create: `management/test/store.test.ts`
- Modify: `pnpm-workspace.yaml`, `tsconfig.base.json` only as needed for new package inclusion

**Interfaces:**
- Produce: `openManagementStore(options: { databasePath: string }): ManagementStore`; `ManagementStore.transaction<T>(fn: (tx: ManagementTransaction) => T): T`; `close(): void`.
- Durable tables: `users`, `oidc_identities`, `organizations`, `memberships`, `teams`, `groups`, `group_members`, `role_assignments`, `service_principals`, `devices`, `complete_grants`, `authority_revisions`, `policy_outbox`, `policy_receipts`, `audit_events`, `bootstrap_claims`. All tenant-owned joins and mutation keys qualify `organization_id`.

- [ ] **Step 1: Write failing tests** `loaded_sqlite_runtime_must_be_patched`, `second_writer_refuses_start`, `transactional_change_and_outbox_commit_or_rollback_together`, `foreign_tenant_reference_rejected`, and `bootstrap_claim_single_use_after_concurrent_attempts`.

**Test assertion contract:** `assert.throws(() => openManagementStore(vulnerableRuntime), /SQLite|patched/); assert.equal(committedOutboxCount, 1);`

- [ ] **Step 2: Confirm RED.** Run `pnpm --filter @tetherplane/management test`. Expected: missing package/store and tests fail; verify failure is not unrelated toolchain absence.
- [ ] **Step 3: Implement minimum** patched `node:sqlite`-backed store with an enforced loaded SQLite version gate, startup `sqlite_version()`/source verification, WAL/FULL/foreign keys, exclusive lifetime writer guard, bounded busy handling, migrations and atomic transactions. If the loaded Node SQLite is unpatched, fail production startup rather than weakening the guard; packaging selects a supported patched runtime.
- [ ] **Step 4: Confirm GREEN** on a runtime verified to carry the patch: `pnpm --filter @tetherplane/management typecheck`, `pnpm --filter @tetherplane/management test`. Expected: zero failures including crash/rollback/tenant joins.
- [ ] **Step 5: Review/commit.** Check schema tenancy and absence of logged secrets; commit `git commit -m "feat(management): establish patched tenant-safe SQLite authority store"`.

### Task 2: OIDC human identity, first-owner bootstrap and service sponsorship

**Files:**
- Create: `management/src/{identity,membership}.ts`, `management/test/{identity,membership}.test.ts`
- Modify: `management/src/store.ts`. Resolve the existing OIDC verifier's validated issuer/subject from a trusted authentication result; do not modify `auth/src/account.ts` to derive identity from email or mutable user claims.

**Interfaces:**
- Produce: `resolveOidcUser(tx: ManagementTransaction, claim: { issuer: string; subject: string; email?: string }): UserIdentity`; `linkOidcIdentity(tx, ownerUserId, verifiedNewClaim, freshProof)`; `acceptInvitation(tx, invitedIdentity, invitationId)`; `registerServicePrincipal(tx, orgId, sponsorMembershipId, credentialBinding)`.
- First owner uses an authenticated local `claimFirstOwner(tx, localClaimProof, verifiedUser)` compare-and-set, never an open internet signup endpoint. Service principals have an independently revocable credential identity and accountable active human sponsor.

- [ ] **Step 1: Write failing tests** `same_email_different_issuer_subject_never_merges`; `link_requires_fresh_dual_control`; `unauthenticated_or_racing_initial_owner_rejected`; `pending_revoked_or_wrong_identity_invitation_denied`; `sponsor_departure_suspends_service_and_revokes_sessions`.

**Test assertion contract:** `assert.notEqual(userForIssuerA.id, userForIssuerB.id); assert.equal(acceptedOwnerClaims, 1);`

- [ ] **Step 2: Confirm RED.** Run `node --test management/test/identity.test.ts management/test/membership.test.ts`. Expected: new identity/membership operations missing.
- [ ] **Step 3: Implement minimum** exact `iss/sub` identities and link proof, invitation lifecycle, one-member personal-org bootstrap, sponsor acceptance/reassignment, suspension and last active human-owner protection. Authorized recovery cannot use matching email or reset to open bootstrap.
- [ ] **Step 4: Confirm GREEN.** Repeat targeted tests and `pnpm --filter @tetherplane/management typecheck`. Expected: valid identities work, forged/racing/departed identities and orphaned services fail.
- [ ] **Step 5: Review/commit.** Validate OIDC binding and no credential disclosure; commit `git commit -m "feat(management): bind people and service sponsors to organizations"`.

### Task 3: Scoped independent roles, complete grants, and delegation

**Files:**
- Create: `management/src/{delegation,grants}.ts`, `management/test/{delegation,grants}.test.ts`
- Create: `agent/tether-core/src/organization_policy.rs`, `agent/tether-core/tests/organization_policy.rs`
- Modify: `agent/tether-core/src/{lib,policy}.rs`

**Interfaces:**
- Produce: `authorizeAdministrativeChange(ctx: AdminContext, proposal: AdminMutation, tx: ManagementTransaction): AuthzDecision`, including indirect control of services/groups.
- Produce: `matchCompleteGrant(request: CanonicalExecutionRequest, grants: readonly CompleteGrant[]): GrantMatch | Denied`. A complete grant binds subject, exact capability, client, device/resource, profile, offline eligibility, expiry and approvals; distinct grants cannot union privileges.

- [ ] **Step 1: Write failing tests** `delegated_group_update_cannot_self_escalate`, `admin_role_does_not_grant_machine_execution`, `fragmented_grants_never_union_into_permission`, `wrong_device_profile_client_or_expiry_denied`, `owner_cannot_remove_last_active_owner`.

**Test assertion contract:** `assert.equal(adminRoleHasProcessExecution, false); assert.equal(combineTwoPartialGrants.allowed, false);`

- [ ] **Step 2: Confirm RED.** Run `pnpm --filter @tetherplane/management test` and `cargo test -p tether-core --test organization_policy`; expected target assertions fail because scope/match logic is absent.
- [ ] **Step 3: Implement minimum** independent role templates, current delegation checks for *each* role/group/invitation/credential/grant mutation and exact resource match. The Rust broker intersects accepted organization grants with immutable device-local ceilings and applicable denials. Keep role assignment separate from machine execution.
- [ ] **Step 4: Confirm GREEN.** Repeat targeted suites and `cargo test -p tether-core --test principal_policy`. Expected: legitimate scoped grants pass; all escalation paths deny.
- [ ] **Step 5: Review/commit.** Verify no dynamic wildcard escape, no bypass through an alias; commit `git commit -m "feat(policy): enforce complete grants and scoped delegation"`.

### Task 4: Trusted organization execution binding across relay, adapter and device

**Files:**
- Create: `agent/tether-core/src/organization.rs`, `agent/tetherd/src/authenticated_execution.rs`, `agent/tetherd/tests/organization_policy.rs`, `relay/test/organization-routing.test.ts`
- Modify: `agent/tether-core/src/{envelope,lib}.rs`, `agent/tetherd/src/{runtime,relay_ws,stdio_rpc}.rs`
- Modify: `relay/src/{auth/oidc-auth,routing/device-router,mcp/http-gateway,devices/registry,devices/ws-gateway}.ts`
- Modify: `protocol/schemas/invocation.schema.json`, `protocol/src/index.ts` and regenerated types as required

**Interfaces:**
- Produce: `AuthenticatedExecutionContext { instance_id, organization_id, principal_id, client_id, credential_id, session_id, device_id, enrollment_generation }` constructed from authenticated transport and locally enrolled trust (not untrusted request JSON).
- Produce: `AgentRuntime::execute_authenticated(&self, invocation: InvocationEnvelope, context: AuthenticatedExecutionContext) -> ResultEnvelope` as an async method; legacy `execute` remains bound to a separately authorized local stdio launch identity only.
- Relay routing consumes an authenticated context for organization-aware device ownership; `ClientIdentity` from existing relay cannot select an organization just by reusing its old `accountId`.

- [ ] **Step 1: Write failing tests** `forged_tenant_arg_does_not_select_context`, `two_memberships_same_user_have_distinct_authority`, `foreign_enrollment_generation_rejected`, `unknown_peer_version_denied_not_downgraded`, and `local_stdio_launch_binding_remains_explicit`.

**Test assertion contract:** `assert.equal(forgedTenantResult.status, 'permission_denied'); assert.equal(localStdioPrincipal, launchBoundPrincipal);`

- [ ] **Step 2: Confirm RED.** Run `node --test relay/test/organization-routing.test.ts`, `cargo test -p tetherd --test organization_policy` (new) and `pnpm --filter @tetherplane/protocol test`. Expected: missing trusted binding/tenant checks.
- [ ] **Step 3: Implement minimum** authenticated context minting/forwarding, device enrollment generation and one-org ownership, explicit protocol negotiation and local validation before provider execution. Keep caller model names as provenance only. Remove one-global-principal substitution from organization-managed runtime; deny incompatible peers and wrong-tenant reconnects.
- [ ] **Step 4: Confirm GREEN.** Re-run new suites plus `pnpm --filter @tetherplane/relay test` and `cargo test -p tetherd --test stdio_rpc`. Expected: secure remote and preserved local explicit launch behavior.
- [ ] **Step 5: Review/commit.** Validate no secret-bearing headers/logs and no new unauthenticated inbound device listener; commit `git commit -m "feat(transport): bind organization principals end to end"`.

### Task 5: Signed versioned snapshots and atomic local policy acceptance

**Files:**
- Create: `protocol/src/policy-snapshot.ts`, `protocol/fixtures/policy-snapshot-v1.json`, `management/src/policy-publisher.ts`, `management/test/policy-publisher.test.ts`
- Create: `agent/tetherd/src/policy_snapshot.rs`
- Modify: `agent/tetherd/tests/organization_policy.rs` (created in Task 4)
- Modify: `agent/tetherd/src/security_state.rs` from Plan 1, `agent/tetherd/Cargo.toml` and `protocol/src/index.ts`

**Interfaces:**
- Produce: `encodeSnapshotBody(body: PolicyBody): Uint8Array`, `signDeviceSnapshot(snapshot: TypedSnapshot, signingKey: SecretKeyHandle): DsseEnvelope` and `PolicySnapshotVerifier::accept(&self, envelope: &[u8], expected: &EnrollmentAudience) -> Result<ApplyReceipt, CapabilityError>`.
- `payloadType` is exactly `application/vnd.tetherplane.policy-snapshot.v1+json`. DSSE signs exact JCS payload with PAE; `policy_body_digest` hashes canonical policy body, while `snapshot_digest` hashes complete signed payload bytes; neither hash is recursive.

- [ ] **Step 1: Write failing independent fixture tests** `rust_and_typescript_agree_on_dsse_jcs_bytes_and_digests`, `duplicate_equal_sequence_does_not_extend_expiry`, `equal_sequence_conflicting_digest_rejected`, `higher_sequence_lower_permission_revision_rejected`, `unknown_signer_schema_or_audience_denied` and `crash_before_atomic_activation_never_admits_old_broad_grant`.

**Test assertion contract:** `assert.equal(snapshotDigestRust, snapshotDigestTypeScript); assert.equal(duplicateDelivery.expiry, originalExpiry); assert.equal(rollbackResult.status, 'permission_denied');`

- [ ] **Step 2: Confirm RED.** Run `pnpm --filter @tetherplane/protocol test`, `node --test management/test/policy-publisher.test.ts` and `cargo test -p tetherd --test organization_policy`. Expected: missing typed snapshot and verifier behaviors.
- [ ] **Step 3: Implement minimum** reviewed Ed25519 DSSE/JCS interoperable encoding/verification, strict audience/algorithm/schema checks, version/high-water and active policy atomic transaction via Plan 1 `SecurityState`, authenticated acknowledgements, key transitions and fail-closed unsupported requirements. Do not trust a key ID alone or copy code-signing trust roots.
- [ ] **Step 4: Confirm GREEN.** Re-run all targeted tests with fixed cross-language vectors, corrupted/expired/frozen/rollback fixtures, and simulated interrupted SQLite transactions. Expected: only valid eligible version advances become effective.
- [ ] **Step 5: Review/commit.** Independently verify cryptography library choices and secret handling; commit `git commit -m "feat(policy): sign and atomically activate device snapshots"`.

### Task 6: Authority revisions, renewal, bounded offline validity and revocation receipts

**Files:**
- Create: `management/src/{device-enrollment,policy-outbox}.ts`, `management/test/{device-enrollment,policy-outbox}.test.ts`
- Create: `agent/tetherd/src/revocation.rs`, `agent/tetherd/tests/revocation.rs`
- Modify: `agent/tetherd/src/{runtime,policy_snapshot,security_state}.rs`, `management/src/policy-publisher.ts`

**Interfaces:**
- Produce: `commitAuthorityChange(tx, orgId, mutation): AuthorityRevision` and `renewDeviceSnapshot(orgId, deviceId, revision): SnapshotPublication`; renewal must observe current committed revocation before signing.
- Produce: `RevocationBarrier::apply(&self, snapshot: VerifiedSnapshot) -> Result<EnforcementReceipt, CapabilityError>` with distinct states: policy accepted, admission blocked, termination requested/confirmed, cleanup verified/unverified. Bind receipts to device/enrollment/boot/revision/digest/challenge.
- `MonotonicGrantDeadline` enforces max 300 seconds from last authenticated freshness, renewal target ~60 seconds, no offline approval dispatch.

- [ ] **Step 1: Write failing tests** `revocation_wins_snapshot_renewal_race`, `stale_or_replayed_ack_not_current_enforcement`, `offline_expiry_blocks_access_and_requests_owned_tree_stop`, `clock_rollback_resume_restart_requires_resync`, `new_unenforceable_snapshot_blocks_broad_old_policy`.

**Test assertion contract:** `assert.equal(renewalAfterRevocation.allowed, false); assert.equal(staleAck.confirmed, false); assert.equal(expiredGrant.newAccessAllowed, false);`

- [ ] **Step 2: Confirm RED.** Run `node --test management/test/policy-outbox.test.ts` and `cargo test -p tetherd --test revocation`. Expected: missing revision ordering and monotonic receipt barriers.
- [ ] **Step 3: Implement minimum** transactional mutation/audit outbox, authenticated policy delivery/receipt, freshness renewal and revocation priority, bounded clock/suspend behavior, affected session/job/approval/lease invalidation, owned-tree stop initiation without false confirmation, and local emergency-stop interoperability. The agent cannot claim fresh enforcement from transport delivery.
- [ ] **Step 4: Confirm GREEN.** Repeat focused tests and targeted `cargo test -p tetherd`. Expected: races, outages, replayed receipts and clock changes fail closed with truthful statuses.
- [ ] **Step 5: Review/commit.** Verify off-line interval and all 300/60 second bounds; commit `git commit -m "feat(policy): enforce revocation and short offline authority"`.

### Task 7: Tenant ownership across jobs, handles, idempotency and audit

**Files:**
- Modify: `agent/tetherd/src/{runtime,idempotency,job,audit,security_state}.rs`
- Modify: `agent/tether-core/src/{ownership,handles,batch}.rs` and applicable browser provider resource stores
- Create: `agent/tetherd/tests/organization_resources.rs`

**Interfaces:**
- Produce: `ResourceOwner { organization_id, principal_id, device_id, enrollment_generation, created_session_id }` on all persistent and stateful resources; `reauthorize_resource_use(context, resource, operation) -> Result<(), CapabilityError>`.
- Consumes: Task 4 authenticated context and Task 5/6 locally activated authority; unauthorized cached results must not be returned before policy reevaluation.

- [ ] **Step 1: Write failing tests** `revoked_retry_must_not_reveal_cached_result`, `idempotency_key_same_name_different_tenant_isolated`, `foreign_job_checkpoint_handle_and_audit_denied`, `lease_does_not_create_grant`, `batch_child_cannot_select_other_org` and `audit_write_failure_denies_sensitive_dispatch`.

**Test assertion contract:** `assert_eq!(revoked_cached_result.error.code, ErrorCode::PermissionDenied); assert!(foreign_org_handle.is_err());`

- [ ] **Step 2: Confirm RED.** Run `cargo test -p tetherd --test organization_resources` and `cargo test -p tether-core --test batch`. Expected: existing global JSON metadata/replay path fails required tenant checks.
- [ ] **Step 3: Implement minimum** tenant-qualified persistent records and handles, fresh reauthorization on reads/inputs/continuations/idempotent retries, transactional security/audit intent for sensitive operations (extending Plan 1 store), and explicit migrations from legacy JSON rather than overwriting records. Do not log secrets or hidden model reasoning.
- [ ] **Step 4: Confirm GREEN.** Repeat new tests and `cargo test -p tetherd --test job_state`, `cargo test -p tetherd --test idempotency`, `cargo test -p tetherd --test audit`. Expected: authorized same-org sharing only when separately granted; cross-tenant and revoked sessions denied.
- [ ] **Step 5: Review/commit.** Check no broad grant migration or forced re-pair; commit `git commit -m "feat(agent): reauthorize all tenant-owned execution state"`.

### Task 8: Two-organization authority E2E, negative matrix and integration gate

**Files:**
- Create: `tests/e2e/organizations-authority.test.ts`
- Modify: `.github/workflows/ci.yml` only for new isolated matrix/fixture gates
- Create: `docs/security/organizations-authority-runbook.md`

**Interfaces:**
- Produce: reproducible synthetic two-organization/three-human/two-service fixtures with current issuer/subject bindings, two device enrollment generations, signed policy, and distinct principal grants.
- Acceptance focus: `AC-01` through `AC-05`, `AC-09` through `AC-11`, `AC-14`, `AC-15`, `AC-18` and tenant-related `AC-20`; full admin/approval/UI and `AC-22` remain Plan 3.

- [ ] **Step 1: Write failing E2E tests** `two_orgs_concurrent_authorized_and_foreign_denied`, `sponsor_departure_loses_machine_access`, `outage_renewal_revocation_expiry_truthful`, `wrong_org_reconnect_and_cached_output_denied` and `self_escalation_group_rotation_denied`.

**Test assertion contract:** `assert.equal(crossTenantDenialCount, expectedCrossTenantDenials); assert.equal(confirmedRevocationsWithoutAgentReceipt, 0);`

- [ ] **Step 2: Confirm RED.** Run `node --test tests/e2e/organizations-authority.test.ts` after the existing `pnpm --filter @tetherplane/e2e build:deps`. Expected: incomplete E2E flow fails on the intended identity/policy assertion, never because credentials or real devices are missing.
- [ ] **Step 3: Integrate** full management→relay→agent harness with synthetic identities and signed policy vectors. Require exact device-local enforcement/acknowledgement evidence; connect no real Surface, Vaulter, RTX or production relay.
- [ ] **Step 4: Confirm GREEN and broader gates.** Run `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace -- --test-threads=1`, `python scripts/check-no-unsafe.py`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`. Obtain fresh Windows/Ubuntu hosted CI at one SHA; track any integration/profile gap as blocker.
- [ ] **Step 5: Review/commit.** Commit `git commit -m "test(organizations): prove tenant grants, distribution and revocation"` after independent review; no public-release claim until Plan 3 and all 22 acceptance items are green.

## Completion and Handoff

- An access-controlled management API and signed grants can operate without the eventual human UI, but this phase does NOT meet first-release usability or approvals requirements; proceed only through the next approved plan.
- Preserve Plan 1 OS containment. A complete grant is never a process-sandbox substitute. Windows unsupported profiles remain unavailable.
- Before substantive development resume, inspect `git status`, current branch, five recent commits, remote, and the isolated worktrees. No operations on human-origin files or unrelated devices are authorized.
- Do not import new service credentials from another app, reveal signing material, change existing pairings, deploy, reset state or clear stop latches. Signing/provider trust and Leno restoration remain separate.
