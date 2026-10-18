# Tetherplane organizations-first access control

**Status:** Formal architecture specification awaiting explicit written-specification approval.

**Date:** 2026-10-18, Asia/Dubai.

**Approval basis:** Conversational Sections 1-5 and every attached clarification were approved by the user. This document consolidates those decisions; approval of this written artifact is still pending.

**Change scope:** Documentation only. No implementation, implementation plan, installation migration, service activation, or release is authorized by this commit.

## 1. Intent, authority, and first-release commitment

Tetherplane must let real organizations administer who and what may operate their computers, with enforceable tenant isolation, resource restrictions, approvals, revocation, audit, and human coexistence. Multiple users, multiple organizations, a functional administrator UI, approval workflows, and audit capabilities MUST ship in the first release. They are not deferred enterprise features.

The initial deployment is a self-hosted, single-node organization management service that supports multiple isolated organizations. The same service boundary must permit future hosting without changing local execution semantics. Local operation requires no hosted Tetherplane service. A personal installation uses an explicitly established one-member organization.

Authority belongs to authenticated human or AI/service principals. Model brands, actor labels, prompts, dashboard roles, and possession of a resource identifier do not establish execution authority. The local device's Policy Broker is final: organizational administrators, the management service, relays, and adapters cannot override stricter local restrictions.

The default AI-facing MCP interface remains exactly **device, files, process, browser, desktop, batch**. Organization administration belongs to a separate human management API/UI. Existing job and audit operations remain behind the existing compact interface; no seventh administrative or policy helper tool is introduced.

### 1.1 Canonical sources and precedence

This specification extends these repository-backed requirements:

- [Canonical architecture and product design](2026-09-17-tetherplane-design.md).
- [Implementation roadmap](../plans/2026-09-17-tetherplane-implementation-roadmap.md).
- [Local core plan](../plans/2026-09-17-tetherplane-local-core-plan.md).
- [Model-neutral control-plane addendum / Plan A.5](2026-09-19-tetherplane-model-neutral-control-plane.md).
- [Windows installation ownership and signing contract](../../onboarding/WINDOWS-CODE-SIGNING.md).

The approved organizations-first scope replaces any older interpretation that organization administration can be deferred under the canonical design's rich-dashboard non-goal. Essential administration is required; general analytics remain deferred. Prior references to a sandboxed principal or allowed working directory do not establish OS subprocess containment. This specification supplies the stronger, testable boundary.

All other canonical invariants remain in force: provider-neutral internal semantics, local-first deployment, compact deltas and continuation handles, exact capabilities, background_only by default, protected human resources, verified actions, and independent foreground leases.

### 1.2 Source baseline and current gaps

Discovery inspected Leno's canonical checkout at 4dbe174 and the repository object 14f3143ea6f98036db3a5eecc55a0fe3b0af7896. This documentation branch starts from the latter object without changing its existing Windows-signing worktree. These are inspection baselines, not evidence of implemented organization security.

| Existing source | Observed behavior to extend or replace |
| --- | --- |
| [PrincipalProfile](../../../agent/tether-core/src/principal.rs) and [LocalPolicyBroker](../../../agent/tether-core/src/policy.rs) | One optional local-process-bound principal with exact device/capability/root grants; no organization membership or role model |
| [AgentRuntime](../../../agent/tetherd/src/runtime.rs) | Replaces incoming identity with one launch-bound principal; cached idempotency results can return before policy reevaluation; audit append failure only logs |
| [Process provider](../../../agent/providers/process/src/lib.rs) and [session launcher](../../../agent/providers/process/src/session.rs) | Starts piped/PTY OS processes under ambient host-account authority; no demonstrated filesystem, network, credential, or tenant sandbox |
| [Job provider](../../../agent/tetherd/src/job.rs) | Durable JSON jobs, checkpoints, and execution leases; a lease is not a general authorization or containment mechanism |
| [Audit provider](../../../agent/tetherd/src/audit.rs) | Principal-scoped JSONL lineage; no organization-wide authorized audit model or required-commit gate |
| [Relay registry](../../../relay/src/devices/registry.ts), [router](../../../relay/src/routing/device-router.ts), and [MCP gateway](../../../relay/src/mcp/http-gateway.ts) | Account-owned device routing and account/client/principal sessions; no complete organization authority context |
| [OIDC authentication](../../../relay/src/auth/oidc-auth.ts) | Explicit bindings and subject-derived identity modes; neither is organization membership or delegated execution authority |
| [Auth persistence](../../../auth/src/sqlite-adapter.ts) and [device administration](../../../relay/src/devices/control-http.ts) | OIDC object persistence and pairing/list/revoke endpoints; not a complete organization administration service |

In particular, files.read can deny an off-root path while process.run starts PowerShell, Python, Git, or another program able to access that path through the Windows account. No bypass execution was needed to identify this source-level gap. Directory configuration and cwd are not security boundaries.

### 1.3 Scope boundaries and trust assumptions

The threat model includes malicious or prompt-injected clients and subprocesses, cross-tenant routing and state errors, privilege escalation through administration, stolen/replayed credentials, stale policies, approval substitution, filesystem races, inherited authority, and interference with human activity.

The host OS, authenticated host administrator, and the enrolled policy trust root are trust assumptions. Shared-kernel containment does not claim resistance to kernel compromise, a malicious host administrator, or hardware side channels. A trusted signer remains limited by the device's locally delegated ceiling. The service must not advertise confidentiality from its own infrastructure administrator without a separate architecture.

Policy/grant administration, authenticated execution, containment, and human interaction remain distinct controls. A valid signature proves origin and integrity, not permission to exceed local limits.

## 2. Architecture and responsibility boundaries

The selected approach is one modular management service distributing authenticated grants to the existing local Policy Broker. It extends Plan A.5 rather than adding a competing execution-policy engine.

| Component | Owns | Must not do |
| --- | --- | --- |
| Organization management service | Membership, administrative authorization, teams/groups, roles, principal lifecycle, delegated grant authoring, publication, approval coordination, and organization audit views | Execute computer capabilities or treat its own administrative decisions as an override of device policy |
| Human administrator UI | Reviewable workflows and truthful configured/confirmed state | Establish authority through hidden buttons, client-side checks, or optimistic success labels |
| Authentication/transport | Verify identity; bind organization, principal, client, session, and device audience | Trust caller-supplied principal/organization fields or derive membership from email |
| Capability Kernel and Policy Broker | Canonical requests, complete-grant matching, local veto, ownership, approval/lease requirements, state access, and admission decisions | Delegate final execution authority to a relay or model |
| Providers | Enforce authorized resource semantics and OS isolation; observe results and report verification | Reinterpret grants, silently weaken a profile, or fall back to ambient authority |
| Relay/adapters | Authenticated routing and translation into canonical invocations | Own provider semantics or bypass broker checks for batch, retries, cached results, or administration |

Standalone local operation uses an explicitly provisioned local organization authority and launch-bound identity. It must not resurrect expired remote grants or silently change authority modes during an outage. A remote deployment retains outbound device connections; no additional unauthenticated machine-control listener is introduced.

Device-local commissioning explicitly establishes the ceiling and any initial locally authorized grants; an organization role cannot supply that consent. A person who is both a host custodian and an organization administrator must authenticate the separate local authority. This does not waive any requirement for an independent human or permit self-escalation through the management API.

Three coherent delivery boundaries exist within this architecture: containment safety, organization authentication/grant enforcement, and complete administration/approval/audit workflows. These are architecture boundaries, not an implementation plan. All are required before first-release acceptance; the narrow initial development slice does not define a reduced public release.

## 3. Identity, membership, and delegation

### 3.1 Entities and tenant ownership

| Entity | Required semantics |
| --- | --- |
| Human user | Stable application identity linked to verified issuer/subject pairs; email is contact data |
| Organization | Tenant boundary with independent membership, policy, resources, and audit |
| Membership / human principal | Distinct per-organization authority for a human; pending, active, suspended, and removed states |
| AI/service principal | Organization-owned execution identity with its own authentication binding, credential lifecycle, and accountable primary human sponsor |
| Team | Organization-scoped grouping of people and work/resources; membership alone grants nothing |
| Group | Flat collection of principals used for explicit role/grant assignments; no nested groups initially |
| Role assignment | Independent permission template bound to a subject and administrative/resource scope |
| Device | One owning organization initially; locally established enrollment generation, identity, ceilings, and capabilities |
| Grant | One complete subject/capability/resource/constraint authorization statement |

All tenant-owned records, associations, queries, caches, indexes, exports, and background work MUST include and validate organization ownership. Cross-organization joins or resource sharing are excluded initially. Global identifiers do not relax tenant checks. Human user authentication is global identity information; membership and every execution principal remain organization-scoped.

Every job, checkpoint, process, browser resource, output, artifact, temporary resource, continuation, approval, audit event, idempotency entry, reconnect record, and session must carry enforceable tenant/owner context. Resources shared within an organization need explicit authorized sharing; sharing does not expand capability grants.

### 3.2 Secure linking and enrollment

OIDC human identity is keyed by the verified issuer and subject pair. Matching email addresses MUST NOT merge accounts, establish membership, or recover authority. Linking another identity requires verified control of both identities with fresh authentication, or an independently authorized, audited recovery procedure. Account-linking sessions cannot be reused as execution approval.

Invitations are expiring, scoped, revocable records. Acceptance requires an authenticated intended identity and current inviter delegation. Pending invitations confer no authority. Invitation creation, acceptance, and any accompanying role/group assignment are checked again at commit; an invitation cannot smuggle execution privileges past scoped delegation.

Secure local bootstrap establishes the initial human owner and trust bindings. First-owner enrollment requires an explicit, authenticated, interactive local claim ceremony under an authorized deployment custodian, with an expiring, single-use, locally protected claim challenge. No remotely reachable first-visitor or unauthenticated claim endpoint can appoint an owner. A transactional compare-and-set records the unique first-owner claim; concurrent or replayed claims fail and produce reviewable evidence. Until claimed, the management service exposes no organization authority or executable device grants. A failed or lost claim requires the separately authorized, audited local recovery flow, not resetting to an open bootstrap state. Deployment-operation privileges do not automatically grant tenant membership, audit access, credentials, or machine execution.

### 3.3 Independent first-release roles

These templates have no automatic inheritance hierarchy and no implicit unrestricted execution:

| Role | Authority |
| --- | --- |
| Organization owner | Ownership, recovery, and authorized administrative appointments |
| Organization administrator | Ordinary membership, team, and organization administration within delegation |
| Access administrator | Author grants only within explicitly delegated device/resource ceilings |
| Operator | Execute exact capabilities only when a complete scoped grant also applies |
| Approver | Decide eligible requests within current approval scope and separation-of-duties rules |
| Auditor | Read authorized, redacted audit records and separately authorized exports |

Only humans may own organizations or approve execution requests. Membership alone provides no execution access. The last active human owner cannot be removed or suspended without an authorized ownership transfer or independently authorized recovery procedure.

Server-side scoped delegation applies to role assignments, team/group changes, invitations, service-principal creation, sponsor changes, credential issuance/rotation, grant changes, and administrative appointments. An administrator cannot grant themselves additional execution authority or obtain it indirectly through controlled identities, credentials, groups, or aliases. Protected changes require the independently authorized authority dictated by the device delegation and separation-of-duties policy. Human identity linking cannot create a second independent approver.

The ability to manage a principal's credentials is itself sensitive delegated authority: it can enable impersonation and must not be available merely because an administrator can edit its display name. Organization administrators cannot change a human's upstream authentication identity through membership administration.

### 3.4 Service-principal accountability

Each AI/service principal must have an active, accountable primary human sponsor. A planned transfer requires scoped delegation, explicit acceptance by an eligible replacement, review of existing grants, and a recorded handover. Transfer does not copy the replacement's permissions or expand existing grants.

If the sponsor is suspended, removed, or departs before an accepted transfer, suspend the service principal and initiate revocation of its credentials, sessions, grants, leases, and applicable execution. Orphaned principals cannot retain unrestricted or renewable authority. Apply the same acknowledgement and bounded-staleness rules as any revocation; a disconnected device is not represented as already stopped.

Reassignment after suspension does not automatically reactivate the principal. Reactivation requires authorized review, valid credentials, fresh policy publication, and any required independent/local approval.

### 3.5 Authenticated execution context

Every organization execution session binds the instance, organization, principal, authenticated client, credential/session identity, and permitted device audience. The agent validates that binding against locally enrolled trust, current accepted authority, and local ceilings. Actor/model labels remain provenance.

Trusted transports construct the security context; arguments cannot establish or overwrite it. Switching organizations requires a newly authorized context. Multi-user operation replaces the existing single-global-principal assumption without removing the explicit launch binding used by local stdio.

Organization-aware context and enforcement support must be negotiated and mandatory for organization-managed execution. An incompatible peer fails closed; no silent downgrade to an unbound compatibility principal or to an organization inferred from the first device/account is permitted.

Credential or membership changes invalidate affected sessions and authority. Credential rotation preserves identity only through an authorized, audited transition and revokes superseded credentials as specified by that transition.

## 4. Authorization semantics and resource use

### 4.1 Complete-grant matching

A grant binds its principal/group subject, exact canonical capabilities, device/resources, allowed client conditions, execution profile when applicable, approval requirements, offline eligibility, and expiry as one statement. Role templates are instantiated only with explicit scopes. Initially there are no unconstrained capability wildcards or implicit whole-machine resource scopes.

A request must match a complete grant. Several grants are alternative complete permissions; fragments cannot be combined into a broader permission. For example, read access on device A and write access on device B do not authorize writing on A. Applicable mandatory restrictions and denials remain cumulative.

The execution decision is the intersection of authenticated identity and current organization authority; a complete grant; client/device scope; local ceilings; resource ownership/sharing; OS-enforceable effects; approval and lease requirements; coexistence rules; and operation preconditions.

Default is DENY. Applicable denials prevail. An unknown required constraint, unsupported isolation guarantee, missing authority, or invalid resource binding cannot become an ALLOW. Approval satisfies an existing approval requirement only; it does not manufacture a grant, supported provider, local permission, or foreground lease.

### 4.2 Reauthorization at every use

Jobs, handles, process input/output, continuations, artifacts, cached results, approvals, audit views, and reconnect state must be reauthorized when used. Opaque IDs are references, not capabilities. Cross-organization access and revoked-session replay fail closed before data disclosure or execution.

Idempotent retry must first reauthorize access to any stored result. It may return an authorized prior result, never reexecute the mutation. A changed request under the same idempotency identity conflicts. Idempotency identity includes organization, principal, authenticated client binding, device/enrollment generation, capability, and key; request equivalence binds canonical intent.

Each batch child inherits the immutable authenticated context and crosses the same broker and provider checks. It cannot select another tenant, principal, execution profile, or broader resource scope through child arguments.

Jobs preserve Plan A.5's observable state, checkpoints, lineage, and handoff semantics without storing hidden model reasoning. Job-linked mutations require both current job access and an active execution lease where specified. Read access requires current job/resource authority. Leases coordinate work and never confer execution permissions. Handoff does not transfer credentials, sandbox identity, or unrestricted scratch access to another principal.

## 5. Execution containment and filesystem integration

### 5.1 Required provider-neutral execution profile

The broker authorizes an immutable execution profile revision. The process provider receives trusted internal authorization context, not caller-controlled enforcement flags.

| Profile dimension | Required constraint |
| --- | --- |
| Security context | Organization, principal, device/enrollment generation, job where applicable, and profile revision |
| Filesystem | Explicit resource identities and read/write/create/delete/execute modes; declared runtime dependencies; private scratch/configuration |
| Credentials and configuration | No ambient host credentials, authentication agents, browser profiles, sensitive environment, or host startup configuration |
| Network and IPC | Denied except specifically authorized, enforceable channels; approved stdio is explicit |
| Human interfaces | No ability to observe or interfere with human keystrokes/input, window and accessibility state, screen contents, clipboard data, or unrelated processes |
| Lifecycle | Descendant confinement, bounded resources/lifetime, ownership evidence, and verified termination/cleanup |

The first Windows profile has a genuinely read-only attached workspace, explicit read/execute runtime dependencies, private writable scratch/configuration, and no network, including loopback, or unauthorized privileged IPC. Scratch execution is not implicitly granted. A process must be able to read authorized input and produce a useful private artifact; an isolated echo or mocked denial alone is not acceptance.

The promise is workspace plus declared runtime/private resources, not that a useful process can access literally only one directory. Writable host-workspace or network-enabled profiles require separate enforceable constraints and positive/negative evidence. Arbitrary programs do not become available by being named in a request.

### 5.2 Pre-execution enforcement

Before untrusted code executes, establish and verify the sandbox identity, OS filesystem permissions, network restrictions, inherited-handle allowlist, environment/configuration, human-interface restrictions, and process containment. Close any interval in which an unconstrained child could run before attachment to its security/lifecycle controls. Recheck authorization at the final dispatch boundary.

Missing profiles, failed setup, unsupported OS features, unsafe resource attachment, or unverifiable containment MUST deny launch. There is no fallback to the host account, a different shell, unverified PTY, or a weaker profile. Working directory, executable allowlisting, argument filtering, and environment cleanup alone are not containment.

Sandbox identities, storage, handles, and temporary resources must be OS-isolated across organizations and unauthorized principals, not merely tagged in metadata. Do not reuse a security identity across those boundaries. Writable resources and scratch inherit the intended OS ownership; intentional sharing requires explicit authority and compatible confinement.

Descendants retain restrictions. They must not inherit privileged process/file handles, device/policy keys, host credentials, authentication agents, sensitive environment, privileged service endpoints, or browser-bridge access. Containment must survive supervising-agent failure. Separate process handles and OS lifecycle controls must support that guarantee without relying on a periodically enumerated PID list.

### 5.3 Windows candidate and honest availability

Evaluate LPAC/AppContainer access isolation combined with Job Object lifecycle/resource controls. AppContainer's token/DACL mechanism and LPAC's restricted access are candidates, not proof that PowerShell, Python, Git, PTY, or arbitrary developer tools work. Job Objects alone do not establish filesystem or credential isolation.

The Windows provider must establish and verify an effective boundary for both confidentiality and interference: attempts to capture human keystrokes, observe unrelated windows/UI Automation or accessibility trees, read clipboard content, or capture the human screen must be denied, as must attempts to manipulate those resources. Windows AppContainer isolation alone is not proof of these guarantees: Microsoft documents keyboard/mouse resources as available to AppContainer applications. A separately isolated desktop/session or another supported OS mechanism is acceptable only if real tests establish the required boundary; otherwise the profile remains unavailable. The Windows provider may add necessary OS controls for noninteractive UI isolation, private resources, allowed inheritance, and secure launch. Any supported alternative must meet the same contract through actual Windows tests. Evaluation of VM-based alternatives does not authorize provisioning a VM, changing security controls, or incurring cost.

Publish a precise supported-profile matrix by OS/build, architecture, program/runtime version, piped/PTY mode, profile revision, required capabilities, and tested guarantees. Unsupported combinations are unavailable, not best effort. Linux/macOS providers retain the same contract and remain unavailable for unsupported guarantees until independently verified. Platform-neutral architecture does not imply tested parity.

### 5.4 Filesystem and cross-tool consistency

Provision only locally authorized resources. Do not weaken unrelated host ACLs, recursively grant broad access to human files, or add global application-package permissions to make a tool work. Prefer Tetherplane-owned private resources; attaching an existing workspace requires validated ownership, explicit local authority, narrowly scoped OS rights, and preservation of human-owned state.

Authorization must remain valid through actual file access. Avoid a canonicalize/check/reopen race: use stable authorized handles or equivalently strong OS-enforced access that rejects reparse/junction/symlink replacement, alternate paths, and concurrent substitution. Handle write/create/delete distinctions and destination preconditions explicitly.

The effects permitted to executable code are part of its grant. process.run cannot hide deletion, external communication, credential use, or other consequential effects behind a generic reversible classification. If the required distinction cannot be enforced, deny the profile; approval does not cure absent authority or absent isolation.

Files, search, document helpers, uploads/downloads, browser/desktop services, and batch must preserve the same resource and effect constraints. Confined code cannot ask a more privileged local endpoint to act as an unrestricted deputy. Authenticated browser sharing remains locally approved, tab/operation scoped, expiring, and revocable.

### 5.5 Controlled artifact export

Private scratch artifacts do not acquire permission to become persistent or enter another workspace. Export requires a separately authorized brokered operation, applicable approval, an immutable source artifact identity/digest, destination identity, allowed operation, and destination revision/overwrite preconditions.

Revalidate source and destination immediately before use, preserve concurrent human changes, verify the resulting bytes and location, and record lineage. A changed artifact, destination, authority, or precondition invalidates the authorization. Cross-organization export is excluded initially. Read-only workspaces remain read-only to subprocesses even when a separate file operation is authorized to modify a destination.

### 5.6 Coexistence and emergency stop

background_only remains the default. No focus theft, cursor movement, simulated OS typing, clipboard changes, navigation/closure of human tabs, human-window manipulation, or termination of human-origin processes is permitted without the separate applicable authority. Physical interaction requires a scoped expiring ForegroundLease; human activity suspends conflicting automation. Concurrent modification returns resource_conflict.

Provide a device-local emergency stop available to an authenticated local human even when the organization service, relay, authorization database, or audit writer is unavailable. It blocks new Tetherplane work, revokes local admission, and initiates termination only of verified Tetherplane-owned process trees. It does not kill by a historical PID or traverse an unverified descendant snapshot.

Retain OS process/job handles and identity/start-time/enrollment evidence sufficient to prevent PID-reuse mistakes. If ownership cannot be established, block further work and report uncertain termination rather than kill an unrelated process. Safety shutdown is never delayed to satisfy an unavailable audit commit.

Persist the stop latch across restart; no remote action can clear it. Only authenticated local recovery, current valid authority, and satisfied containment requirements permit resumption. Missing/corrupt/uncommittable security state fails closed; a failed latch write is reported, never claimed durable. Record emergency/recovery evidence when storage returns without inventing missing events.

## 6. Policy distribution, freshness, and offline operation

### 6.1 Snapshot contract and delivery

Distribute complete signed snapshots for a device audience, rather than composing partial permission updates at the agent. Each snapshot binds:

- Snapshot type/schema, authorized signer/key identity, and fixed verification algorithm rules.
- Instance, organization, device identity, and locally established enrollment generation.
- Monotonic delivery sequence, authority/permission revision, and policy-body content digest (not a self-hash of the enclosing snapshot).
- Issuance/not-before/expiry bounds, complete applicable grants, principal/credential status, and enforcement requirements.

Policy signatures and transport authentication are both required. Trust roots are established through locally authorized enrollment; received key IDs, URLs, or algorithm claims cannot expand trust. Validate purpose/type and audience so identity credentials, approval records, and policy messages cannot substitute for one another. Use reviewed signature libraries, fixed allowed algorithms from enrolled trust configuration, and strict parsing; do not design custom cryptography.

The version-1 signed snapshot wire format uses a **DSSE v1 signed envelope** with the exact, case-sensitive `payloadType` `application/vnd.tetherplane.policy-snapshot.v1+json`. The decoded `payload` bytes are UTF-8, RFC 8785/JCS-canonical JSON for one typed, versioned snapshot document; the signature input is DSSE's standard `PAE(UTF8(payloadType), payloadBytes)`. Sign and verify those exact bytes without parsing or reserializing between signature verification and the application layer. The configured local trust policy fixes acceptable signature algorithms, key purposes, and signer thresholds; an envelope `keyid` is only a lookup hint, never authorization. Verify the signature and expected type before interpreting the payload, then reject duplicate keys, malformed/ambiguous data, noncanonical bytes, unsupported schema/claims, wrong audience, untrusted signatures, and unknown mandatory enforcement requirements.

The signed document carries `policy_body` (the complete typed grants, principal statuses, and enforcement requirements) and `policy_body_digest = SHA-256(JCS(policy_body))`. The distinct **snapshot digest** used for receipt binding, equal-sequence conflict checks, and replay evidence is `SHA-256(payloadBytes)` of the complete verified signed payload. Neither digest recursively includes itself. All bytes, digests, and semantic records must agree across the Rust agent and TypeScript organization service. New schema versions require explicit negotiation and verification; an unknown version is never downgraded. Tests must include independent DSSE protocol vectors and positive/negative cross-language signing, parsing, and digest cases.

Administrative mutation, authority revision, required audit intent, and publication intent commit transactionally. An outbox supports retry and acknowledgement without losing a committed tightening. The signer must read current committed authority: it cannot renew an older grant while a newer revocation is waiting for publication. Full snapshots may supersede old outbox entries only without losing the restrictive result.

The agent validates the full candidate, stores verified version/digest and activation state durably, applies it atomically against request admission, and then issues an authenticated receipt. Until activation completes, it cannot report enforcement. A correctly authenticated newer revision with unsupported requirements blocks affected execution instead of retaining older broad permissions.

### 6.2 Anti-rollback and trust transitions

Persist highest verified and highest applied sequence/digest state per enrollment generation. Reject lower sequences and authority revisions; equal sequence with different content is a security conflict. Identical delivery is idempotent and cannot refresh validity. A greater freshness sequence may renew the same permission revision; it does not silently change permissions.

Key rotation must chain from currently trusted authority and preserve version ordering and bounded validity. Revoked/unknown signing keys fail closed. Recovery after signer compromise needs an independently authorized local trust transition; an untrusted replacement key cannot declare itself authoritative. Enrollment-generation reset and device transfer require explicit local authorization and invalidate old sessions, grants, handles, and receipts.

Restart, restored local state, or unreliable time requires an authenticated synchronization with a fresh challenge bound to the current device/boot and authoritative policy state before organization execution resumes. A cached signature or replayed successful receipt cannot satisfy it.

Local counters alone cannot defeat a coordinated rollback of both device and authority history. Restore is an explicit recovery operation; require trustworthy current history or independently authorized trust re-establishment. Do not claim hardware-anchored or external-witness rollback protection that has not been designed and verified. A restore must not silently revive revoked permissions or superseded policy revisions.

### 6.3 Timing and offline boundaries

| Control | First-release rule |
| --- | --- |
| Maximum cached-grant validity | 300 seconds, or a shorter underlying credential/grant/profile expiry |
| Renewal | Attempt approximately every 60 seconds, with bounded retry/jitter and no expiry extension on failure |
| Offline eligibility | Individually scoped permission; only explicitly allowed reads and OS-confined local computation |
| Approval request lifetime | At most 600 seconds from creation |
| Approved single-use authorization | At most 60 seconds from approval and never beyond any underlying validity |
| Approval-gated dispatch | Requires live-authority verification; a separately provisioned on-device authority can satisfy this without cloud access |

Use authenticated expiry together with monotonic elapsed-time measurements. Enforce the earliest applicable deadline. Duplicate delivery, retries, disconnects, wall-clock rollback, suspend/resume, and restored state must never extend authority. Verify clock/suspend behavior on each supported OS; unreliable timing blocks organization execution until fresh synchronization. Suspend does not create unused authority to spend later.

No new privilege changes, approval-gated execution, artifact export requiring approval, or external/destructive actions proceed merely on an offline permission. Offline operation is not a blanket organization mode. At expiry, deny new admissions and further resource access and initiate termination of affected computation. The five-minute freshness bound does not guarantee process termination within five minutes; termination remains a separately verified state.

Private scratch creation and housekeeping remain limited to the profile's explicit rights; they do not authorize destructive operations on human files. Do not infer that the agent can instantly retract OS access already held by running code: block new broker access, initiate confined-tree termination, preserve confinement, and keep execution/cleanup unconfirmed until observed.

Local standalone policy is a separately authenticated authority configuration, not a fallback from unavailable remote authority. This preserves local-first/self-hosted operation without permissive outage behavior.

## 7. Revocation consistency and truthful state

Committed security-tightening changes take precedence over renewal and queued action admission. On the agent, serialize policy activation, approval consumption, final dispatch checks, and revocation barriers so queued stale work cannot race through after a locally received tightening. A reserved but undispatched action must recheck authority before launch or external dispatch.

For approval-gated actions, the organization authority transaction orders committed revocations against issuance of a single-use, short-lived live dispatch reservation. A revocation committed before that reservation makes issuance fail. Each reservation binds the device/enrollment and boot session, authenticated principal/client, approval/intent digest, authority revision, fresh challenge nonce, and a narrow consumption deadline (at most ten seconds and never beyond the underlying approval or grant validity). The device verifies and consumes it only at the final dispatch gate, alongside the locally accepted revision, live eligibility, and any new local revocation barrier; stale/replayed reservations fail. This is not a global instantaneous revocation guarantee: a reservation issued before a central revocation may leave a brief in-flight exposure before the device observes the change or the reservation expires. The administrator UI must report such remote enforcement as unconfirmed and separately show dispatch/termination evidence. Non-approval offline work remains governed by the independently scoped five-minute freshness ceiling.

Applying revocation invalidates affected credentials/sessions, grants, queued actions, approvals, leases, handle/continuation access, and cached-result access. Initiate termination for affected execution, keeping containment effective while termination is pending. Already completed side effects are not undone by revocation.

| State | Evidence and permitted claim |
| --- | --- |
| Configured change | Desired administrative settings; not yet a committed authority revision |
| Revocation/policy committed | Authority transaction committed and further authorization there is blocked; device enforcement unconfirmed |
| Snapshot delivered | Transport delivery only; not proof of policy enforcement |
| Authorization revoked on agent | Authenticated receipt after the agent installed the admission/resource-access barrier |
| Termination requested | Stop was requested for a verified owned process tree; no exit claim |
| Termination confirmed | OS observation establishes the intended owned tree exited |
| Cleanup verified | Checks establish the required temporary resources/handles were disposed of |
| Cleanup unverified or failed | Missing/failed observation; unresolved state remains visible |

These are distinct dimensions, not one green completion flag. Authentication or transport loss does not prove an exit. Receipts bind device identity, enrollment generation, boot/session identity, revision/sequence/digest, event identity, and observation time; reject stale/replayed acknowledgements as current evidence.

The UI must show connectivity, configured and committed revisions, delivered and agent-confirmed state, enforcement timestamps, expected authority expiry, and unresolved termination/cleanup failures. Unacknowledged devices remain visibly unconfirmed. Expected expiry is not observed enforcement; an old receipt is labeled last-confirmed, not live success.

Device-local emergency stop remains available offline under section 5.6. An organization administrator cannot remotely clear its latch or override local ceilings.

## 8. Exact-action approval and execution accounting

### 8.1 Canonical intent and human review

Only otherwise eligible, granted actions may enter REQUIRE_APPROVAL. The broker creates an opaque, tenant-owned approval record. The requester cannot mint or self-approve it. OAuth consent, pairing authorization, execution approval, and ForegroundLease are separate records and cannot substitute for each other.

Canonical intent binds organization, principal, authenticated client/session, device/enrollment generation, canonical capability, executable operation and resolved executable identity when relevant, arguments, resources and revisions, artifact/destination digests when relevant, execution profile/revision, authority revision, and required side-effect/approval scopes. For script/interpreter or executable-file actions, the approved executable identity must include immutable content identity (digest and stable source identity/revision) for the actual binary, entry script, inline code, and authorization-relevant executable/configuration inputs. Dependencies that can change the approved action must be pinned in a sealed versioned execution bundle or independently revalidated under an equivalent stable-handle/content guarantee. A mutable script path or an interpreter name alone is not an exact action. If the executable content cannot be bound and verified, no exact-action approval is issued.

Serialize typed intent using RFC 8785 JSON Canonicalization Scheme, UTF-8, and SHA-256. Reject duplicate object names, unsupported numeric representations, invalid Unicode, and ambiguous inputs; preserve string semantics. Use strings for identifiers, exact large counters, and values that cannot safely use the canonical numeric domain. Path spelling alone is not resource identity. Credential references may be bound with versions; secret material must not enter intent displays, logs, or low-entropy secret digests.

Producer, verifier, UI rendering, and idempotency equivalence consume the same immutable typed intent. The human-readable description must expose the real operation, affected resources, executable/arguments where applicable, recipients/amounts/destinations where applicable, profile restrictions, and consequential effects. Escape untrusted text and clearly distinguish it from security decisions. Model-written summaries do not replace authoritative intent. Ambiguous or incomplete descriptions are not approvable.

### 8.2 Approval lifecycle and separation of duties

States are pending, approved, denied, expired, cancelled, consumed/reserved, dispatched, and observed outcome (verified, failed, or uncertain). Pending requests expire within ten minutes; approval produces a single-use authorization valid for at most sixty seconds and no longer than underlying authority. Freshness renewal alone does not invalidate an unchanged authority revision; changes to bound intent, resources, authority, profile, session, or required approver eligibility invalidate the approval.

At decision and again at consumption, verify fresh human identity, active membership, current delegated approval scope, applicable local requirements, and separation of duties. Evaluate linked human identities and recorded service-principal sponsorship/credential control when checking protected self-escalation. A one-person organization cannot satisfy a required independent-human rule through another account or AI principal. Ordinary human approval of a separately scoped AI action remains possible where policy permits it.

The approving organization role cannot supply absent execution grants. Local approval and foreground lease must also be satisfied when required; human activity and resource conflicts remain vetoes.

### 8.3 Atomic consumption, live checks, and uncertain outcomes

Before dispatch, obtain live-authority verification, recheck broker policy, deadlines, resource and executable/script-content identity/revisions, profile availability, and approver eligibility. Use stable handles or equally strong OS-enforced identity checks to prevent replacement between that verification and launch. A service outage cannot be bypassed with a cached approval. A local authority must be genuinely provisioned and authenticated to satisfy the same check locally.

Atomically and durably consume the approval and reserve the associated idempotency identity, recording required audit intent in the same device security transaction. Concurrent consumers cannot both succeed. If required authorization/audit records cannot commit, fail closed before side effects. The organization service coordinates decisions; the device owns the execution-consumption transaction. This does not claim an atomic distributed transaction with an external website or process side effect.

Record dispatch and observed outcome separately. Crash or response loss after reservation/dispatch produces an uncertain record until reconciled. Never automatically replay uncertain execution. A later authorized retry can inspect an existing outcome; it cannot consume the permit twice or execute again because a response was lost. A deliberately new attempt requires a newly authorized intent after resolution of duplication risk.

Reconciliation must not infer success from command issuance, HTTP delivery, a queued event, or a tool-generated summary. It verifies resulting application/OS state where possible; otherwise uncertainty remains explicit.

## 9. Persistence, audit, backups, and recovery

### 9.1 Single-node transactional model

Initial management state uses SQLite on local disk with one active management-service writer and an exclusive lifetime ownership guard. Concurrent administrators remain supported through transactions, bounded contention handling, and optimistic revision checks. A second active service owner must refuse startup; this is not a high-availability or distributed multi-writer design.

The management node is an availability dependency. During its outage, devices have only their remaining individually authorized offline validity, approval-gated dispatch stops, and remote administrative changes cannot be confirmed. Backup and restart are recovery capabilities, not automatic failover.

Device security state also uses transactional local persistence for active policy/version barriers, stop state, principal/resource ownership, approval consumption, idempotency reservations, and required audit intent. Extend existing Plan A.5 job/checkpoint/audit interfaces; do not create separate competing job or policy abstractions. Move affected legacy JSON records through explicit validated migrations.

Use WAL with FULL synchronous durability for security transactions, enabled foreign-key enforcement, and tenant-qualified keys/references. The SQLite library **actually loaded by the service** must include the WAL-reset corruption fix: upstream SQLite 3.51.3 or a later supported release (excluding withdrawn 3.52.0 as an installation target), or a separately verified patched/backported build such as 3.44.6 or 3.50.7. At startup, verify the runtime library version/source identity and documented patch evidence, not merely the separately installed command-line client; refuse WAL-backed security service startup on an unverified vulnerable build. Test multi-connection WAL write/checkpoint, crash/recovery, and storage-full scenarios, recording the runtime version with acceptance evidence. Do not infer these settings from the existing auth adapter's defaults. Keep the authentication service's OIDC-state ownership separate. Backing files, journals, keys, and private artifacts require appropriate OS access controls; network/shared filesystems are not an initial supported SQLite deployment.

Commit authority mutation, revision, audit intent, and outbox publication atomically in the management store. Device admission/approval/idempotency commitments are atomic within the device store. Cross-store coordination uses authenticated revisioned messages and explicit acknowledgement, not an invented global transaction.

### 9.2 Audit integrity and bounded failure

Audit covers administrative changes, identity linking/recovery, delegation, sponsorship, credential lifecycle, grant publication/activation, approvals/consumption, requests/results, job/lease/checkpoint lineage, artifact exports, revocation/termination/cleanup, stop/recovery, and backup/restore operations.

Records bind organization, human/service principal, authenticated client/actor provenance, device/enrollment/boot identity, job/request/event IDs, relevant revisions/digests, decision, dispatch state, result, verification, and timestamps. Do not store hidden model reasoning, credentials, browser secrets, or unrestricted execution payloads. Use stable resource references and bounded redacted diagnostic data.

Maintain append-only application history, source event sequence and integrity digests/checkpoints sufficient to detect corruption, missing collection, duplicate/conflicting events, and discontinuity. Organization audit views require current scoped auditor authority; they do not automatically expose another principal's sensitive outputs. Audit export is separately authorized. Retention and size limits are explicit operational configuration; approaching limits must be visible, and required evidence must not be silently discarded to keep execution running.

Security-sensitive actions fail closed when their required audit or authorization record cannot commit. Do not preserve the existing log-only audit-failure behavior. Emergency stop, termination, and security recovery remain available; preserve any obtainable failure evidence and mark gaps honestly. Append-only application records do not claim protection against a malicious host administrator controlling storage and keys.

### 9.3 Consistent backups and trust-aware restore

Take transactionally consistent database snapshots using supported backup facilities. Protect backups, keys, private artifacts, and ownership metadata with access control and encryption where they contain recoverable secrets; keep them out of Git, dashboard payloads, and diagnostics. Copying an arbitrary live database file is not the backup procedure.

Restore starts blocked. Reconcile authority revisions, version high-water marks, signing-key trust, sessions/credential revocations, approval consumption, idempotency outcomes, stop state, and source audit continuity against trustworthy current state. Never reactivate an expired approval, invalid session, revoked permission, old credential, or superseded policy just because it exists in a backup.

An uncertain dispatch remains uncertain after restore. Require authenticated freshness synchronization and explicit local recovery/trust re-establishment where history cannot be proven. Preserve source snapshots and conflicts for investigation; do not reset counters, generate broad grants, clear the stop latch, or invent successful audit events to complete recovery. Document the single-node outage and restore limitations in the operator runbook.

## 10. Administrator UI and organizational workflows

### 10.1 Functional first-release surfaces

| Area | Functional behavior required for release |
| --- | --- |
| Organization context | Explicit selected organization, authenticated role/scope, and separate new context when switching |
| People, teams, and groups | Expiring invitations, authenticated acceptance, role/group changes, suspension/removal, ownership transfer, and delegation conflicts |
| AI/service principals | Sponsor acceptance/transfer/departure, independent credentials, authorized rotation, suspension/reactivation, and effective access |
| Devices | Intended-device enrollment, local ceilings, connectivity, supported profiles, pending changes, emergency/recovery instructions, and enrollment-generation transfer |
| Access | Complete grants, proposed versus agent-confirmed permissions, source of direct/group access, client/profile restrictions, offline eligibility, expiry, and deny explanations |
| Approvals and exports | Immutable human-readable intent, consequential side effects, eligibility/separation of duties, expiry, single-use outcome, and controlled artifact destination |
| Operations | Jobs/checkpoints/handoffs, execution verification, committed/delivered/applied revisions, revocation, observed process state, and cleanup failures |
| Audit and recovery | Authorized redacted search/export, source integrity/gaps, publication failures, key rotation, protected backup/restore, and unresolved recovery actions |

The dashboard must not expose service-principal credentials, policy-signing keys, device credentials, or sensitive execution payloads. Credential enrollment/rotation uses authenticated credential-safe mechanisms rather than dumping secrets into the UI. Administrative access does not imply access to all machine files or execution output.

### 10.2 Secure administration and truthful feedback

Every API request enforces authentication, organization scope, scoped authorization/delegation, and optimistic concurrency on the server. Do not rely on hidden controls or trusted browser parameters. Protect sessions and state-changing operations against CSRF, session fixation, credential exposure, injection, clickjacking, and cross-organization cache/context leakage. Fresh authentication is required for sensitive identity, ownership, credential, grant, and recovery operations. Membership/credential changes invalidate affected sessions.

Changing organization clears protected UI drafts and cached context; outstanding operations keep their original organization and cannot be retargeted. A stale edit returns resource_conflict with a safe refresh/review path, never last-writer-wins permission loss or escalation.

Display configured permissions, committed authority, delivered snapshots, agent-confirmed enforcement, and observed execution separately. Include revision IDs, enforcement timestamps, connectivity, last-confirmed versus current state, and unresolved acknowledgement/termination/cleanup failures. Saving or delivery cannot produce an enforced-success indicator. No automatic success toast, expected expiry calculation, or mockup counts as device evidence.

### 10.3 End-to-end organizational workflows

1. Bootstrap the first owner securely; establish organization trust without implicit computer authority.
2. Invite and authenticate members; apply independently scoped roles/groups under current delegation.
3. Enroll the intended device into one organization, confirm identity locally, and configure its ceilings/profile attachments.
4. Create human/service grants and inspect proposed effects; publish and observe agent-confirmed application.
5. Execute a permitted workflow while another principal or tenant receives deterministic denial.
6. Request, review, approve, consume, and verify an exact action; reject stale or conflicting requests and substitutions.
7. Produce a private artifact, separately authorize export, verify destination and bytes, and retain lineage.
8. Transfer a service sponsor before departure; otherwise suspend/revoke, visibly track enforcement, and require review before reactivation.
9. Revoke membership/credentials/grants, cancel affected queued work and leases, observe process exit, and verify cleanup.
10. Exercise device-local emergency stop during an authority outage; recover only through authenticated local action and valid authority.
11. Rotate signing keys and credentials, back up consistently, restore while blocked, and reconcile trustworthy history before resumption.
12. Transfer ownership without leaving an ownerless organization or moving an active device's old state into another tenant.

All workflows require working server and agent behavior with independent verification, not UI-only representations.

## 11. Legacy installation and data migration

Migration is a separately reviewed, explicitly authorized operation after specification/plan approval and the necessary operational authorization. This document does not authorize touching installed agents, tasks, security settings, pairings, or credentials.

Inventory and preserve existing device identities, pairings, credentials, installation files, task definitions, human-owned resources, jobs, and audit records. Explicitly map accounts/principals/devices/jobs to organization ownership and review local ceilings and access. Unknown mappings, incompatible agents, missing ownership, corrupt/unverifiable records, and uncertain dispatch state fail closed. No broad compatibility grant, silent default tenant, credential reset, or re-pairing shortcut may make migration appear successful.

Leno's legacy installation receipt does not prove ownership of every installed script or managed file. Do not manufacture a new receipt, infer ownership from a directory name or old PID, or automatically replace an unverified file. Reconcile historical package/file/task evidence and preserve unexpected or concurrently changed bytes. A valid code signature does not prove file ownership. Follow the existing Windows ownership-preserving upgrade/rollback contract without weakening it.

Perform data conversion against protected, consistent staged copies first. Review the explicit mapping and changes, validate integrity and revocation/approval history, and preserve originals until authorized acceptance. Interrupted conversion or concurrent changes must not partially enable new organization authority. Restored identity and configuration are not fresh authenticated execution proof.

Trusted Windows signing remains independent. The user reports a submitted free SignPath Foundation inquiry with eligibility/approval pending; this specification does not claim a signing-provider response or accepted Windows trust. Preserve Smart App Control and all existing security controls. No cost, provider provisioning, installed-agent replacement, service activation, external message, publication, or device other than Leno is authorized by this architectural work.

## 12. Operational acceptance and requirement traceability

Every acceptance item below is **required and not yet demonstrated by this specification**. Its identifier is the traceability key for later TDD plans and release evidence. This section defines outcomes and failure cases, not implementation tasks or test code.

| ID | Required independent evidence | Covers |
| --- | --- | --- |
| AC-01 | Concurrent real management/API/agent end-to-end workflows for at least two organizations, multiple human users, and AI/service principals; all required administrator workflows functional | First-release multi-user/multi-organization scope; sections 1-3 and 10 |
| AC-02 | Cross-tenant negative access through routing, sessions, files, search, browser/desktop resources, jobs/checkpoints, handles, scratch/artifacts, continuations, cached results, approvals, audit queries/exports, and reconnect state | Tenant isolation across all resources/state; sections 3-5 |
| AC-03 | Both-identity linking proof or independent recovery; matching-email nonmerge; single-use authenticated first-owner bootstrap, concurrent/remote claim rejection and no open recovery reset; pending/revoked invitation denial; session invalidation after credential/membership changes | Secure identity and administration; sections 3 and 10 |
| AC-04 | Every role/group/team/invitation/service/sponsor/credential change obeys scoped delegation; self-escalation, aliases, controlled services, fragmented grants, and absent/independent-approver attempts denied | Independent roles, complete grants, least privilege and separation of duties; sections 3-4 and 8 |
| AC-05 | Sponsor suspension/departure initiates service suspension/revocation; accepted reassignment and reviewed reactivation preserve limits; last-owner protection and ownership transfer function | Service accountability and human ownership; sections 3 and 10 |
| AC-06 | Actual Windows processes perform useful read-only-workspace/private-scratch work and verified export; off-root reads/writes, workspace mutation, alternate/reparse paths, race substitutions, forbidden runtime resources, and unauthorized export fail | OS containment, filesystem safety, controlled export; section 5 |
| AC-07 | Actual Windows children/descendants cannot escape, inherit privileged handles/environment/credentials/agents, access another sandbox, contact network/loopback or privileged IPC, observe human keystrokes, clipboard, window/accessibility/screen state or influence human UI, or survive outside the required confinement after supervisor crash; setup failure never launches untrusted code | Pre-execution controls, OS tenant separation, secure inheritance and lifecycle; section 5 |
| AC-08 | Same containment/effect denial through batch, file/search/document helpers, browser upload/download, credential helpers, and service endpoints; no host ACL weakening or weaker-shell/PTY fallback | Cross-tool and safe filesystem integration; sections 4-5 |
| AC-09 | Cross-language DSSE/JCS exact-byte signature and digest interoperability, forged/noncanonical/ambiguous, wrong-audience/type/tenant/device, expired/frozen/reordered/conflicting snapshots, unknown requirements, counter corruption, signing-key rotation/revocation, and stale acknowledgements are handled without authority expansion | Authenticated distribution and anti-rollback; sections 6-7 |
| AC-10 | Five-minute maximum freshness and individually scoped offline work verified under outage, duplicate delivery, clock rollback, suspend/resume, restart, restore, and uncertain time; no expiry extension or cached approval dispatch | Clock-safe expiry/offline limits; section 6 |
| AC-11 | Authority-side revocation/dispatch-reservation ordering and bounded in-flight race confirmed; tightening/revocation beats renewals and queued actions; UI distinguishes configured, committed, delivered, enforced, termination requested/confirmed, and cleanup verified/unverified; lost acknowledgements never become success | Revocation consistency and honest status; sections 6-7 and 10 |
| AC-12 | Cross-language canonical-digest agreement; intent/binary/script/runtime-content/resource/profile/revision substitution fails, including mutable script replacement; trustworthy human preview; ten-minute requests and sixty-second single use; live verification, current approver scope, and all applicable approval/foreground requirements | Exact-action approvals and timings; section 8 |
| AC-13 | Concurrent approval consumption and crash/power-loss fault injection preserve atomic durable approval/idempotency/audit reservations; lost responses and uncertain execution never auto-replay | Durable execution accounting; sections 8-9 |
| AC-14 | Audit source sequence/integrity, tenant filtering, redaction, exports, collection gaps, storage-full/corruption failures, security-sensitive fail-closed behavior, and emergency/recovery exceptions verified | Audit integrity and failure recovery; section 9 |
| AC-15 | Patched loaded SQLite library/version verified with concurrent WAL checkpoint and failure tests; consistent protected backups and blocked restore reconcile revisions, key rotation, credentials, sessions, consumed approvals, uncertain effects, stop latch, and audit continuity; coordinated-history limitations documented | SQLite durability, availability and trust-aware restore; sections 6 and 9 |
| AC-16 | Explicit staged migration preserves legacy identities/pairings/credentials and human bytes; missing/forged/incomplete receipts, unknown ownership, incompatible agents and concurrent changes block adoption; no invented receipt or broad grant | Leno legacy ownership and migration; section 11 |
| AC-17 | Device-local emergency stop functions without the authority/audit service, remains latched after restart, cannot be cleared remotely, rejects PID-reuse/unverified ownership, and truthfully reports exit/cleanup uncertainty | Offline stop and authenticated local recovery; sections 5 and 7 |
| AC-18 | Server checks concurrent/unauthorized first-owner claims, direct/tampered requests, CSRF, fixation, cross-organization context, stale concurrent edits, and sensitive-operation reauthentication; dashboard/diagnostics expose no credentials, keys, or sensitive payloads | Secure functional administration; section 10 |
| AC-19 | Fresh authorized human-active coexistence evidence shows unchanged active tab/window, cursor, clipboard, human resources and processes; lease expiry/conflict/restoration verified where separately authorized | background_only and human-first coexistence; sections 1 and 5 |
| AC-20 | Exactly six default MCP tools, canonical provider-neutral semantics, model/controller independence, policy checks on batch/retry, bounded deltas/continuations, measured resource use, and supported-platform/profile matrix | Canonical architecture, model efficiency and honest compatibility; sections 1-5 |
| AC-21 | Clean supported self-hosted installation with verified patched SQLite runtime, concurrent administration under one writer, exclusive-owner rejection, outage and recovery runbook, complete repository gates at the exact candidate commit, independent security review, and explicit blocker report | Operational acceptance and single-node limitations; sections 9-12 |

Tests use synthetic non-secret fixtures and Tetherplane-owned resources. Cross-tenant/device fixtures do not authorize operating Surface, Vaulter, RTX, or another real computer. Real Windows evidence must name the exact OS/build, runtime/program versions, execution profile, source commit, positive and negative results, and verification method. Piped results do not establish PTY support; mocks do not establish OS containment.

A usable supported Windows profile passing both positive and negative gates is a first-release requirement. Denying all restricted process execution is an initial safety milestone, not completed isolation. Unknown or unsupported combinations remain unavailable and explicitly documented.

Human-active acceptance needs fresh, scoped operator authorization and an observed test window; no foreground lease or physical control is implied. Green CI, a historical acceptance waiver, or a signing test cannot waive the new containment, tenancy, or coexistence requirements. Hosted tests do not prove acceptance on Leno. Windows trust/signing and live installation recovery remain independent release gates.

Publish evidence against the exact candidate revision, with test totals, supported guarantees, measured performance, limitations, and unresolved failures. No release-ready claim is allowed from code changes, mockups, tool summaries, anonymous discovery, or partial tests. Benchmarks remain measurements; initial canonical resource targets are not claims of achievement.

## 13. Review boundaries and deferred scope

Functional organizations, multiple users/tenants, independent roles, scoped grants, containment, approval workflows, audit, revocation, safe recovery, and essential administration are mandatory. Initial scope excludes cross-organization resource sharing, nested groups, a custom-role designer, automated enterprise provisioning/SCIM, rich analytics, multi-node high availability, and unverified full desktop/process parity. These exclusions do not reduce first-release organization functionality.

The next authorized artifact after this document is an implementation plan **only after the user explicitly approves this written specification**. The implementation plan must subsequently receive its own review/approval and execution-method selection before implementation. It must use strict RED-to-GREEN TDD, independently verified increments, fresh complete applicable repository gates, and the acceptance identifiers above. This document supplies no task-by-task implementation plan and no implementation authorization.

Conversational approval, written-specification approval, plan approval, operational migration/deployment authorization, and publication authorization are distinct. No approval of an earlier artifact is interpreted as approval of an artifact that did not yet exist.

## 14. External references

These primary sources support mechanisms and review criteria; they do not establish that Tetherplane has implemented them.

- [OpenID Connect identity stability](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability): issuer/subject identity and email limitations.
- [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html): cryptographic verification, purpose/type and audience separation.
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html): canonical JSON for deterministic action and policy payload bytes.
- [DSSE specification](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md): type-bound signed envelope and exact-byte signature verification.
- [The Update Framework specification](https://theupdateframework.github.io/specification/latest/): version, expiry, trust-transition and rollback/freeze defense patterns; this design does not claim a TUF implementation.
- [Microsoft AppContainer/LPAC launch guidance](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer): OS token/DACL isolation candidate.
- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) and [process startup attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute): lifecycle, inheritance, and launch constraints.
- [Microsoft AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation): isolation scope and resource considerations.
- [SQLite WAL and WAL-reset fix](https://www.sqlite.org/wal.html#the_wal_reset_bug), [SQLite 3.51.3 release](https://www.sqlite.org/releaselog/3_51_3.html), [synchronous configuration](https://www.sqlite.org/pragma.html#pragma_synchronous), and [consistent backup facilities](https://www.sqlite.org/backup.html): patched-version requirements, persistence and operational limitations.
- [OWASP authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) and [transaction authorization](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html): per-request checks, trustworthy intent, and final execution authorization.

## 15. Specification review record

Self-review performed on 2026-10-18 before the documentation commit: checked placeholders, internal contradictions, ambiguous authority boundaries, first-release versus deferred scope, source references, and coverage of all approved additions. Resolved three ambiguities explicitly: local commissioning is separate from administrative self-granting; offline scratch housekeeping cannot imply destructive host-file authority; and authorization expiry does not assert instantaneous removal of rights held by running code. Added the concrete single-node outage consequence.

| Conversational approval | Clarifications preserved | Specification sections | Acceptance coverage |
| --- | --- | --- | --- |
| Section 1 | Full-state tenancy; authenticated/expiring/revocable/rollback-protected grants; demonstrated OS containment; no execution authority from administration; first-release organization/approval/audit scope; canonical invariants | 1-2, 4-7, 12-13 | AC-01, AC-02, AC-04, AC-06 through AC-11, AC-14, AC-19 through AC-21 |
| Section 2 | Both-identity linking/recovery; scoped delegation including invitations/groups/services/rotation; accountable sponsor departure/reassignment; reauthorization of jobs/handles/continuations/cached results/approvals; complete grants and independent roles | 3-4, 8, 10 | AC-02 through AC-05, AC-12, AC-18 |
| Section 3 | Verified controls before execution; OS tenant separation; separate artifact export; confined descendants and clean inheritance; actual Windows compatibility; no unrelated ACL weakening; honest revocation/exit/cleanup and cross-tool tests | 5, 7-8, 11-12 | AC-06 through AC-08, AC-11 through AC-13, AC-16, AC-17, AC-19, AC-20 |
| Section 4 | 300/60/600/60-second bounds; monotonic/signed expiry and restart sync; individually scoped offline work; crash-surviving containment; tightening priority; local emergency stop; canonical exact-action approvals; atomic durable consumption; fail-closed records and recovery tests | 5-9 | AC-07, AC-09 through AC-15, AC-17 |
| Section 5 | Server scope/delegation/concurrency; CSRF/fixation/session/credential protection; truthful revision/timestamp/connectivity states; SQLite concurrency and single-node limits; trust-aware restore; preservation of Leno's incomplete receipt and existing identities; latched stop/PID-reuse safety; functional independently verified workflows | 5-7, 9-12 | AC-01 through AC-05, AC-11, AC-14 through AC-21 |

After the initial documentation commit, a follow-up independent specification review identified gaps in precise signed-snapshot bytes, approval-bound executable content, human-input observation, central revocation/dispatch ordering, first-owner bootstrap, and patched SQLite WAL runtime versions. The documentation-only revision specifies DSSE/JCS byte contracts, immutable execution inputs, human-input confidentiality, bounded reservation races, authenticated one-time bootstrap, and startup-verified SQLite fixes; the affected AC-03/07/09/11/12/15/18/21 gates were extended. The implementation and operational proof remain unperformed.

This is a specification consistency self-review, not an independent security acceptance or user approval. All operational acceptance items remain unproved. The written-specification review and implementation-plan gates remain closed until their respective explicit approvals.
