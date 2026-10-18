# Tetherplane Administration, Approvals, and Personal Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the complete first-release self-hosted administrator console, exact-action approval and audit workflows, recovery/migration tooling, and simplified Personal Mode over one unchanged organizational security model.

**Architecture:** Complete the organization authority service and device security transaction foundation from Plans 1 and 2. A versioned server-authorized management API backs an accessible browser console with explicit organization context and personal navigation; administrative roles never bypass execution grants or local ceilings. Exact-action approval binds a canonical intent, live authority, single-use dispatch reservation and crash-safe local idempotency/audit transaction. All 22 acceptance gates and separate signing/operational proofs must be met before any release claim.

**Tech Stack:** TypeScript / Node with the existing pnpm workspace and `@tetherplane/protocol`, new `@tetherplane/management` API, React/TypeScript + Vite browser console, Playwright UI/e2e fixtures, Rust `tetherd` and SQLite device state, existing two-OS GitHub CI and Windows onboarding release tests.

**Spec:** `docs/superpowers/specs/2026-10-18-tetherplane-organizations-access-control-design.md`, explicitly approved at `c4fdc5a8cb69972828f95e66da0e2d97d57ed47d`.

**Execution order:** Third of three plans. Prerequisite: `2026-10-18-tetherplane-containment-foundation-plan.md` then `2026-10-18-tetherplane-organization-authority-plan.md` have green independent safety gates. No product code was authorized by committing these plan documents.

## Global Constraints

- **Personal Mode and Organization Mode are mandatory first-release user experiences**, sharing the same one-member-or-multi-member organization model, identity, grants, local Policy Broker, audit and six default MCP tools.
- Individuals must install locally/self-host, securely bootstrap, enroll personal devices, configure AI principals/permissions, review approvals/activity and recover without invitations, teams, enterprise role terminology or a paid hosted account.
- Organization mode must support multiple isolated orgs, multiple humans, service sponsors, teams/flat groups, the six independent role templates, scoped grants and delegation, revocation and truthful enforcement status.
- No role, including organization owner/administrator, implicitly authorizes unrestricted execution. Personal owner remains subject to explicit grants, local ceilings, OS containment and independent-human requirements where policy mandates them.
- Approval request lifetime ≤**600 seconds**; approved authorization ≤**60 seconds** and no later than underlying authority; live dispatch reservation ≤**10 seconds**, nonce-bound, single-use and not issued after committed revocation.
- Intent canonicalization: typed RFC 8785/JCS UTF-8 and SHA-256, including actual executable/script/configuration content identity, revision/side-effects; no model-generated summary substitutes for human-reviewable canonical intent.
- Device consumption, idempotency reservation and required audit intent commit atomically before consequential dispatch. Crash/response loss is `uncertain`; never auto-replay.
- Management UI must show configured/committed/delivered/agent-enforced and observed termination/cleanup as **distinct** states. Offline/expired devices are not displayed as confirmed stopped.
- Administrative API checks fresh identity, tenant, delegation, record version and CSRF/session safety per request; browser toggles never establish authorization.
- Device-local emergency stop works without network/service/audit, survives restart, and can only be cleared by authenticated local recovery. Do not terminate human-origin processes or infer process ownership from recycled PIDs.
- Initial SQLite authority store is single-node one-writer, patched loaded library, WAL/FULL, protected consistent backups and explicit blocked restore. No invented high availability.
- Legacy migration preserves pairings, credentials, files and partial receipts; unknown owner/state fails closed. Do not install, repair, migrate, pair, delete or reset any live device without separate user authorization.
- Every acceptance requirement `AC-01` through `AC-22` is a release gate. Fresh real Windows process isolation, self-hosted installation, exact-head CI, Windows public signing, Leno live acceptance and human-active coexistence require independent evidence; green CI alone is insufficient.
- No paid service, external communications, financial actions, foreground control, local security changes, or use of devices other than explicitly authorized Leno. Synthetic fixture tests can create their own devices without connecting real equipment.

## Review Focus

1. Two people edit a sensitive grant concurrently: `stale_if_match_grant_change_returns_resource_conflict` must reject the later stale edit (Task 3).
2. Approver views an executable but the script changes before launch: `mutated_script_invalidates_approval` must refuse dispatch (Task 1).
3. Approved action is reserved, device crashes, user retries with same idempotency key: `crash_after_reservation_never_replays_effect` must report uncertain without duplicate side effect (Task 2).
4. A personal user enables multi-user administration after connecting an AI agent: `personal_to_org_does_not_expand_device_access` preserves exact grants/ceilings and identities (Task 5).
5. A restored older backup contains a formerly valid approval: `restore_cannot_reactivate_consumed_or_revoked_approval` must remain blocked pending trust reconciliation (Task 7).

## File Structure and Interfaces

| File | Responsibility |
| --- | --- |
| Create `protocol/src/approval-intent.ts`, `protocol/test/approval-intent.test.ts` | Canonical typed exact-action intent, JCS digest and reviewable operation description |
| Create `management/src/{approvals,approval-reservations}.ts` and tests | Human eligibility, separation-of-duties, bounded single-use remote reservation |
| Create `agent/tetherd/src/approvals.rs` and `agent/tetherd/tests/approvals.rs` | Atomic local approval/idempotency/audit reservation, dispatch/outcome evidence |
| Create `management/src/{http,admin-routes,sessions}.ts` and tests | Versioned, tenant-scoped, CSRF-safe/admin API with optimistic concurrency |
| Create `management/src/{audit-query,recovery,backup,migration}.ts` and tests | Authorized redacted audit query/export, backup/restore, staged preservation-first migration |
| Create `console/package.json`, `console/tsconfig.json`, `console/index.html`, `console/src/{api,auth-context,App}.tsx` | Accessible first-release UI; register console in pnpm workspace |
| Create `console/src/pages/{PersonalHome,Organizations,People,Agents,Devices,Access,Approvals,Operations,AuditRecovery}.tsx` | Focused functional surfaces sharing typed API |
| Modify `agent/tetherd/src/{security_state,runtime,emergency_stop}.rs` | Transactional consumption, authorization barriers, blocked restore and emergency/recovery |
| Modify `relay/src/mcp/http-gateway.ts`, `adapters/compact-mcp/src/compact-tools.ts` only where required to retain current six-tool compatibility |
| Create `tests/e2e/{admin-console,personal-mode,approval-resume,organizations-release}.test.ts` | Synthetic end-to-end workflows and acceptance evidence |
| Create `docs/onboarding/ORGANIZATIONS-SELF-HOSTED.md`, `docs/security/ORGANIZATIONS-RELEASE-ACCEPTANCE.md` | Secure operator guidance, exact commit/OS/profile evidence and blocker matrix |

API paths selected here: `/api/v1/organizations/:organizationId/...` with current authenticated organization context; `If-Match` for mutable record revision and `resource_conflict` for stale writes. Personal routes map to the same tenant-scoped API and never create unscoped privileged endpoints.

---

### Task 1: Canonical exact-action intent and human approval eligibility

**Files:**
- Create: `protocol/src/approval-intent.ts`, `protocol/test/approval-intent.test.ts`
- Create: `management/src/approvals.ts`, `management/test/approvals.test.ts`
- Modify: `protocol/src/index.ts`, `management/src/store.ts`

**Interfaces:**
- Produce: `canonicalIntentBytes(intent: ApprovalIntent): Uint8Array`; `hashApprovalIntent(intent: ApprovalIntent): string`; `renderApprovalDescription(intent): ReviewableActionDescription`.
- Produce: `requestApproval(tx: ManagementTransaction, ctx: AuthenticatedExecutionContext, intent: ApprovalIntent): ApprovalRequest`; `decideApproval(tx, approver: HumanAdminContext, approvalId: string, decision: "approve" | "deny"): ApprovalDecision`.
- Bind immutable intent to organization, principal, client/credential/session, device generation, capability/args, resolved binary/script/bundle digests, resource revisions, execution profile, side-effect class, current grant/authority revision and expiry.

- [ ] **Step 1: Write failing tests** `jcs_cross_language_intent_digest_stable`; `mutated_script_invalidates_approval`; `missing_eligible_grant_cannot_request_approval`; `linked_identity_cannot_self_approve_independent_human_action`; `approval_expired_after_600s`; `review_description_matches_exact_action`.
- [ ] **Step 2: Confirm RED.** Run `pnpm --filter @tetherplane/protocol test` and `node --test management/test/approvals.test.ts`. Expected: missing intent/digest and eligible approval functions; verify fixtures are valid.
- [ ] **Step 3: Implement minimum** typed canonicalization (reject ambiguous numbers/duplicate keys), exact executable identity/digest, current scoped approver authority and separation-of-duties, immutable reviewable summary free of secrets or model-written substitution. A pending request conveys no execution permission.
- [ ] **Step 4: Confirm GREEN.** Run both targeted suites and `pnpm --filter @tetherplane/management typecheck`. Expected: forgery, expiry, substitution and self-escalation denied.
- [ ] **Step 5: Review/commit.** Audit canonical serialization and display escaping; commit `git commit -m "feat(approvals): bind eligibility and canonical action intent"`.

### Task 2: Live dispatch reservation and crash-safe device execution accounting

**Files:**
- Create: `management/src/approval-reservations.ts`, `management/test/approval-reservations.test.ts`
- Create: `agent/tetherd/src/approvals.rs`, `agent/tetherd/tests/approvals.rs`
- Modify: `agent/tetherd/src/{runtime,security_state,idempotency,audit}.rs`

**Interfaces:**
- Produce: `reserveDispatch(tx, authenticatedDevice, approvalId, nonce): DispatchReservation` with ≤10-second validity, current authority version, exact intent, device/enrollment/boot/session, and single use.
- Produce: `consumeAuthorizationAndReserve(&self, approval: VerifiedApproval, idempotency: IdempotencyIdentity) -> Result<DispatchPermit, CapabilityError>` in a single device-security transaction. An uncertain dispatch is a first-class queryable outcome, not an automatic retry token.

- [ ] **Step 1: Write failing tests** `revocation_committed_first_prevents_reservation`; `concurrent_approval_consumers_exactly_one_wins`; `crash_after_reservation_never_replays_effect`; `expired_or_wrong_boot_dispatch_reservation_denied`; `audit_failure_blocks_nonemergency_dispatch`.
- [ ] **Step 2: Confirm RED.** Run `node --test management/test/approval-reservations.test.ts` and `cargo test -p tetherd --test approvals`. Expected: missing atomic durable reservation/recheck operations.
- [ ] **Step 3: Implement minimum** server-ordered revocation vs reservation, verified fresh challenge, single-use nonce, local serialized final admission, atomic consume/idempotency/audit intent, actual dispatch/outcome recording, and explicit `uncertain` crash recovery. Do not claim a distributed transaction with external websites.
- [ ] **Step 4: Confirm GREEN.** Rerun targeted tests, inject power-loss/storage-full/restart and parallel consumers, and `cargo test -p tetherd --test idempotency`. Expected: exactly one dispatch permit and no duplicate action.
- [ ] **Step 5: Review/commit.** Verify no approval extends grant validity; commit `git commit -m "feat(approvals): consume live permits transactionally"`.

### Task 3: Complete secure management HTTP API and effective-access queries

**Files:**
- Create: `management/src/{http,admin-routes,sessions}.ts`, `management/test/{admin-routes,sessions}.test.ts`
- Modify: `management/src/{delegation,grants,identity,membership}.ts`
- Test: `relay/test/organization-routing.test.ts` from Plan 2

**Interfaces:**
- Produce: `createManagementHttpServer(input: { store: ManagementStore; authenticate: AdminAuthenticator }): ManagementHttpServer` with tenant-qualified REST routes:
  - `GET /api/v1/organizations/:organizationId/effective-access`
  - `POST /api/v1/organizations/:organizationId/invitations`
  - `POST /api/v1/organizations/:organizationId/grants`
  - `GET /api/v1/organizations/:organizationId/devices/:deviceId/enforcement`
  - `POST /api/v1/organizations/:organizationId/approvals/:approvalId/decisions`
  - organization-scoped membership, team, group, sponsor, credential, audit and recovery endpoints using similarly qualified routes.
- The server obtains tenant/principal/role from authenticated session and registered membership, never from path alone; mutations take `If-Match` or an explicit expected revision.

- [ ] **Step 1: Write failing tests** `stale_if_match_grant_change_returns_resource_conflict`; `cross_org_url_and_cached_context_denied`; `csrf_missing_token_rejected`; `fixated_session_rejected_after_login`; `sensitive_change_requires_fresh_auth`; `effective_access_distinguishes_pending_from_confirmed`.
- [ ] **Step 2: Confirm RED.** Run `node --test management/test/admin-routes.test.ts management/test/sessions.test.ts`. Expected: missing route/session authorization.
- [ ] **Step 3: Implement minimum** authenticated sessions, CSRF/clickjacking controls, strict input validation, per-request tenant/delegation and record version checks, bounded responses and redaction; expose distinct configured/committed/delivered/applied/exit/cleanup evidence. No misleading `success` on accepted-but-undelivered policy.
- [ ] **Step 4: Confirm GREEN.** Re-run suites and `pnpm --filter @tetherplane/management typecheck`. Expected: authorized CRUD works; forged/cross-tenant/stale/sensitive requests deny or conflict.
- [ ] **Step 5: Review/commit.** Check cookies, cache and security headers, no secret payloads; commit `git commit -m "feat(management): ship tenant-scoped administrator API"`.

### Task 4: Functional organization administrator console

**Files:**
- Create: `console/package.json`, `console/tsconfig.json`, `console/index.html`, `console/src/{api,auth-context,App}.tsx`
- Create: `console/src/pages/{Organizations,People,Agents,Devices,Access,Approvals,Operations,AuditRecovery}.tsx`
- Create: `tests/e2e/admin-console.test.ts`
- Modify: `pnpm-workspace.yaml`, `tsconfig.base.json` as needed for console build

**Interfaces:**
- Produce: `OrganizationContextProvider` with authenticated organization selection and protected cache/draft invalidation; typed `ManagementApiClient` only uses current tenant-scoped endpoints.
- Every page exposes actual first-release workflows, including human/team/group lifecycle, accountable service principals, device enrollment and confirmed enforcement, complete grants, exact-action approvals, operations/job/export evidence, redacted audit search/export, recovery.

- [ ] **Step 1: Write failing Playwright tests** `tenant_switch_clears_drafts_and_protected_cache`; `invite_suspend_group_delegate_and_sponsor_reassign`; `device_grant_displays_saved_awaiting_ack`; `approve_exact_intent_or_show_uncertain_outcome`; `audit_redacted_export_enforces_scope`. Use synthetic served management API fixtures; never human-owned tabs.
- [ ] **Step 2: Confirm RED.** Run `node --test tests/e2e/admin-console.test.ts` after installing/building test dependencies. Expected: missing screens/actions cause assertion failures; not missing browser setup.
- [ ] **Step 3: Implement minimum** accessible typed React/Vite flows with explicit organization selector, current authorization/effective access, revisions/timestamps, review-and-confirm for consequential changes, guarded refresh on `resource_conflict` and no secret display. Browser client is non-authoritative.
- [ ] **Step 4: Confirm GREEN.** Re-run fixture browser suite, `pnpm --filter @tetherplane/console typecheck` and `pnpm --filter @tetherplane/console build`. Expected: UI workflows complete and server still independently rejects tampered requests.
- [ ] **Step 5: Review/commit.** Audit XSS/CSRF/session changes and accessibility controls; commit `git commit -m "feat(console): implement organization administration workflows"`.

### Task 5: First-release Personal Mode with safe transition to organization administration

**Files:**
- Create: `console/src/pages/PersonalHome.tsx`, `console/src/personal-flow.ts`
- Create: `tests/e2e/personal-mode.test.ts`
- Modify: `console/src/{App,auth-context}.tsx`, `management/src/{http,membership,device-enrollment}.ts`

**Interfaces:**
- Produce: `PersonalModeFlow` that creates **one member organization** using the single-use authenticated local bootstrap, then uses the same scoped devices/principals/grants/approvals/audit endpoints.
- Produce: explicit `enableOrganizationAdministration(personalOrgId, authenticatedOwner)` UI transition; no credential reset, new tenant, re-pair, automatic permission broadening or local-ceiling change.

- [ ] **Step 1: Write failing tests** `first_time_personal_user_completes_onboarding_without_enterprise_forms`; `personal_can_enroll_devices_create_ai_grant_revoke_and_read_audit`; `personal_to_org_does_not_expand_device_access`; `personal_owner_cannot_bypass_independent_approval`; `switching_personal_and_other_org_does_not_leak_context`.
- [ ] **Step 2: Confirm RED.** Run `node --test tests/e2e/personal-mode.test.ts` against synthetic account/device fixtures. Expected: no personal onboarding and safe transition implemented yet.
- [ ] **Step 3: Implement minimum** personal navigation `My devices`, `My AI agents`, `Permissions`, `Approvals` and `Activity`; first-owner commissioning and device-local grant confirmation; optional advanced administration toggle over the **same** organization. Do not require SaaS account, team invites or privileged unconfined process access.
- [ ] **Step 4: Confirm GREEN.** Re-run focused end-to-end and server-side forged personal-owner tests. Expected: full AC-22 personal workflow plus preserved AC-01/AC-02 cross-tenant barriers.
- [ ] **Step 5: Review/commit.** Verify simple UX did not alter policy semantics; commit `git commit -m "feat(console): add secure first-release Personal Mode"`.

### Task 6: Authorized audit, redacted export and observability integrity

**Files:**
- Create: `management/src/audit-query.ts`, `management/test/audit-query.test.ts`
- Modify: `agent/tetherd/src/{audit,security_state}.rs`, `console/src/pages/AuditRecovery.tsx`
- Create: `tests/e2e/approval-resume.test.ts`

**Interfaces:**
- Produce: `queryAudit(ctx: AuditorContext, filter: AuditFilter, pagination: AuditCursor): RedactedAuditPage` and `exportAudit(ctx, filter, destination): AuthorizedExportReceipt`; both reauthorize at access/export time.
- Source integrity includes monotonic source event sequence and integrity checkpoints, identifies missing/duplicate/conflicting events without fabricating recovered history.

- [ ] **Step 1: Write failing tests** `different_org_cannot_query_audit`; `auditor_without_payload_scope_sees_redacted_records`; `missing_sequence_remains_visible`; `audit_storage_full_blocks_approval_but_not_emergency_stop`; `approval_uncertain_outcome_does_not_change_to_verified_without_observation`.
- [ ] **Step 2: Confirm RED.** Run `node --test management/test/audit-query.test.ts tests/e2e/approval-resume.test.ts`. Expected: redacted tenant query/continuity unavailable.
- [ ] **Step 3: Implement minimum** tenant-filtered audit queries, separately approved exports, bounded retention with visible collection gaps, checkpoint verification and device-level required-commit barrier. Emergency stop remains callable during storage failure and later records *uncertainty*, not invented events.
- [ ] **Step 4: Confirm GREEN.** Re-run tests and `cargo test -p tetherd --test audit`. Expected: no cross-tenant disclosure or silent evidence loss.
- [ ] **Step 5: Review/commit.** Verify audit traces contain no credentials, browser cookies, hidden reasoning or unbounded process output; commit `git commit -m "feat(audit): authorize export and expose evidence gaps"`.

### Task 7: Backups, blocked restore and preservation-first legacy migration

**Files:**
- Create: `management/src/{backup,recovery,migration}.ts`, `management/test/{backup,recovery,migration}.test.ts`
- Create: `docs/onboarding/ORGANIZATIONS-SELF-HOSTED.md`
- Modify: `agent/tetherd/src/security_state.rs` and relevant packaging scripts **only after** independently reviewed ownership evidence

**Interfaces:**
- Produce: `createConsistentBackup(ctx: RecoveryAdminContext, destination: ProtectedBackupTarget): BackupReceipt`, `stageRestore(source, currentTrust): BlockedRestorePlan`, `approveRecovery(plan, authenticatedLocalAuthority): RecoveryDecision`.
- Produce: `stageLegacyMigration(inventory: LegacyInventory, mapping: ExplicitOrganizationMapping): MigrationPreview`; missing owner, receipt, credential or state history must block application.

- [ ] **Step 1: Write failing tests** `restore_cannot_reactivate_consumed_or_revoked_approval`; `restored_counter_requires_fresh_authority_reconciliation`; `missing_legacy_receipt_preserves_bytes_and_blocks_install`; `concurrent_file_change_aborts_migration`; `recovered_emergency_stop_remains_latched`.
- [ ] **Step 2: Confirm RED.** Run `node --test management/test/backup.test.ts management/test/recovery.test.ts management/test/migration.test.ts`. Expected: blocked restore and migration preview unavailable.
- [ ] **Step 3: Implement minimum** supported transactionally consistent SQLite snapshot API, protected keys/backup state, blocked-on-restore startup, version/trust reconciliation and preservation-first migration previews. No automatic overwrite, device enrollment reset, re-pair, counter reset or broad compatibility grant; Leno's incomplete receipt is an explicit negative test fixture, not an excuse to touch its installation.
- [ ] **Step 4: Confirm GREEN.** Re-run focused tests with synthetic protected backup and fake incomplete receipt plus existing `pnpm --filter @tetherplane/management test`. Expected: safe restores only after independent trust proof; unauthorized/ambiguous migrations remain blocked.
- [ ] **Step 5: Review/commit.** Check protected backups never enter Git or logs; commit `git commit -m "feat(recovery): guard restore and preserve legacy ownership"`.

### Task 8: Device-local emergency recovery, transfer and operational self-host installation

**Files:**
- Modify: `agent/tetherd/src/{emergency_stop,security_state,runtime}.rs`, `management/src/{device-enrollment,http}.ts`
- Create: `tests/e2e/organizations-release.test.ts`
- Create: `docs/security/ORGANIZATIONS-RELEASE-ACCEPTANCE.md`

**Interfaces:**
- Produce: local-only authenticated stop/recovery workflow, `DeviceTransferPlan` that requires old-grant revocation/observed disposition before new-org enrollment, and a self-host runbook with signed versioned policy, single-writer SQLite, key rotation and outage semantics.
- Human-active overlap remains a *separately approved* test window; completing this task's synthetic tests does not grant foreground control.

- [ ] **Step 1: Write failing tests** `device_local_stop_works_with_management_offline`; `remote_cannot_clear_stop_latch`; `transfer_requires_old_state_revocation_and_disposition`; `two_writer_collision_fails_safely`; `interrupted_install_preserves_unmanaged_files`.
- [ ] **Step 2: Confirm RED.** Run `cargo test -p tetherd --test emergency_stop` and `node --test tests/e2e/organizations-release.test.ts`. Expected: at least new transfer/recovery assertions fail on intended missing semantics.
- [ ] **Step 3: Implement minimum** secure local recovery and transfer, truthful persisted ownership and revocation status, single-writer startup runbook, and non-destructive supported test-owned installer fixtures. No installed Leno tasks/files are altered or remote production action submitted by this plan alone.
- [ ] **Step 4: Confirm GREEN.** Re-run targeted suites plus Windows onboarding Pester tests (`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-onboarding-tests.ps1` in an isolated supported Windows runner). Expected: exact owned resources restored, unknown ownership never overwritten, stop latch locally controlled.
- [ ] **Step 5: Review/commit.** Inspect package/signing impact and human-resource ownership; commit `git commit -m "feat(operations): preserve enrollment and local stop recovery"`.

### Task 9: Release-wide AC-01–AC-22 verification and independent acceptance ledger

**Files:**
- Create: `tests/e2e/organizations-release.test.ts` if not already created in Task 8; extend dedicated acceptance assertions
- Modify: `.github/workflows/ci.yml` only to incorporate real synthetic Windows/Ubuntu requirement-specific gates
- Complete: `docs/security/ORGANIZATIONS-RELEASE-ACCEPTANCE.md` and `docs/onboarding/ORGANIZATIONS-SELF-HOSTED.md`

**Interfaces:**
- Produce one acceptance matrix indexed `AC-01` ... `AC-22`, with exact commit, OS/build, supported Windows profile/program/runtime/piped-or-PTY, test command, numerical totals, side-effect verification, signer status, independent reviewer, exclusions and unresolved blockers.
- `AC-22` requires real functional Personal Mode and safe optional organization transition, not screenshots or mere role metadata.

- [ ] **Step 1: Write failing gate test** `all_22_acceptance_requirements_have_fresh_evidence_or_explicit_blocker` plus the full synthetic multi-org and personal UI/API/agent negative matrix. Include clock/renewal/race, forged identity, corrupted snapshot, unconfined process, forged approval, audit storage failure, unsafe restore, incomplete installation, and coexistence fixtures.
- [ ] **Step 2: Confirm RED.** Run `node --test tests/e2e/organizations-release.test.ts` on the current branch. Expected: outstanding evidence produces honest failure/blocker state, never a fabricated successful release.
- [ ] **Step 3: Integrate and collect independent results** from Plan 1 native OS profile and Plan 2 authority suites, Plan 3 UI/approval flows, synthetic two-tenant device tests and a clean self-host instance. Require a scoped fresh human-active Leno test authorization before observing the user workstation; no background permission implies such a window. Record separate Windows public trust/SignPath eligibility and installed-agent recovery gates.
- [ ] **Step 4: Confirm broad gates at exact candidate SHA:** `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace -- --test-threads=1`, `python scripts/check-no-unsafe.py`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`, full Windows onboarding Pester, Windows package smoke, patched SQLite WAL stress, native process sandbox tests, genuine Playwright browser tests, and fresh hosted Windows/Ubuntu CI. A single missing/failed gate is an explicit blocker.
- [ ] **Step 5: Review/commit and hold release.** Commit `git commit -m "test(release): trace organizations and personal acceptance evidence"` only for verified results. Request independent security review of the final branch; **do not merge, publish, deploy, purchase code signing, disable Smart App Control or alter Leno** without separate approvals. Report exact unverified gates rather than calling the initiative complete.

## Completion and Execution Handoff

- This plan ends at a reviewed, reproducible source/evidence candidate, not automatically at an installed/published release.
- The three plans jointly cover `AC-01`–`AC-22`: Plan 1 containment/emergency/coexistence primitives; Plan 2 identity/tenant/snapshots/offline/audit barriers; Plan 3 exact-action approvals, UI, Personal Mode, migration/recovery and all-up tests.
- Use a dedicated development feature branch/worktree created through `superpowers:using-git-worktrees`; preserve the existing dirty canonical Leno checkout, the signed-kit worktree and the separate spec worktree. Read the three canonical documents and approved spec afresh before implementation.
- Required execution path remains TDD RED → verify correct failure → minimal GREEN → broader gates → independent code/security review → commit and push only verified task branches. Do not skip test/evidence gates between tasks.
- A human must separately approve this implementation plan **and choose the execution method**; this written plan, like the design, is not permission to start implementation, change devices or deploy.
