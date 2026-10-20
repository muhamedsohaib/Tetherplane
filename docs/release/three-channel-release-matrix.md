# Tetherplane: three-channel release contract (2026-10-20)

**Status: DRAFT / NO-GO for publication.** This is a release plan, not an agent update. It does not modify device identity, TetherAuth, current relay configuration or the six-tool kernel.

## Principle

Release **one versioned `tetherd` capability engine with three separately testable client integrations**, not three divergent daemons. Preserve `device`, `files`, `process`, `browser`, `desktop`, `batch`, local policy authority, `background_only`, stable paired-device IDs and protected OAuth/DCR registrations.

| Phase | Client | Transport | Client-specific deliverable | Proof |
| --- | --- | --- | --- | --- |
| **1 — developer** | OpenCode, Claude Code, Codex | Local stdio MCP -> existing Compact adapter -> `tetherd`; remote optional by separate authorization | Validated version-pinned client configuration, signed Windows kit or separately gated Linux developer-preview package | Real client-originated calls on clean authorized test machine; status + allowlisted read + outside-root denial; reconnect and rollback |
| **2 — desktop** | ChatGPT installed app | Local desktop MCP plugin where supported, no mandatory relay | Desktop plugin package and explicit policy/default path selection | Actual desktop plugin install, status, denial, restart, uninstall; provider submission eligibility independently confirmed |
| **3 — web** | ChatGPT browser | HTTPS Streamable MCP -> existing OAuth relay -> device outbound WSS | Remote ChatGPT plugin with stable endpoint and OAuth registration | Real browser OAuth PKCE + exact issuer/audience/scope, six tools, four authorized device statuses, forbidden operation denial, revocation/reconnect |

Identity remains split between account identity, MCP client identity, paired device identity, invocation/session identity and scoped approval authority. A plugin ID does not grant local device rights.

## Phase 1 first — acceptance gate

Existing `tests/release/windows-package-smoke.ps1` already proves temporary package/install, six tools and ordinary state-preserving uninstall in CI. Do not confuse this with real client or public distribution proof.

Capture a **separate evidence receipt for each client and tested OS**, containing immutable source SHA, package SHA-256 and version, tested client's exact version, OS/architecture, approved local policy mode, redacted tool results, total first-status setup time and independent reviewer. Pass requires:

1. Clean source-bound artifact and verified checksum; Windows requires valid approved Authenticode trust under Smart App Control.
2. Genuine clean-device installation into authorized/test-owned prefix, without replacing live Leno, Surface, RTX or Vaulter tasks/state.
3. All six tools discovered by the **actual** OpenCode/Claude Code/Codex client, not merely an SDK fixture.
4. Real `device(op=status)` returning installed agent OS, version, policy; permitted `files(op=read)` within test root.
5. `files(op=read)` outside allowed root denied as `permission_denied`; no filesystem data escapes.
6. Approved disconnect/reconnect or test-device restart with **no automatic replay** of mutations.
7. State-preserving uninstall/rollback; no user files, pairing credentials or unrelated tasks removed.
8. Independently reviewed sanitized logs/results. Target: <=300 seconds from clean install to first client-originated successful status; record a miss, never classify it as pass.
9. Windows additionally: background human-coexistence and actual signed-kit/trust acceptance.

The first OpenCode real-workflow success was **owner-reported** on 20 October 2026; no independent clean-first-use measurement is claimed.

## Implementation plan

1. Provide a non-mutating config-preview generator for OpenCode MCP JSON, Claude Code `mcpServers` JSON and Codex `mcp_servers` TOML, using only explicit absolute package/executable/allowed-root/policy paths. Do **not** overwrite existing client config or perform OAuth registration.
2. Provide a fail-closed evidence-bundle checker for exact gates, SHA-256 evidence integrity, path/symlink safety, operator/reviewer distinction and setup timing. A format/hash pass **never** substitutes for real-world independent acceptance.
3. Add synthetic contract tests on Windows and Linux, then run actual client calls on a new authorized test device. Keep phase 1 rollout platform-specific: Linux-preview work already exists in draft PR #37; Windows signing/recovery issues are separate.
4. After real Phase 1 sign-off, implement and test the desktop plugin independently; after authentication security review, complete the ChatGPT web plugin.

## Existing blockers

- The current `.github/workflows/release.yml` on `main` publishes a Windows release automatically on any `v*` tag. **Do not create or push tags** until the approval-gated workflow is reviewed (draft PR #34).
- Leno Smart App Control blocked unsigned agent historically; signed-kit acceptance in PR #16 is incomplete.
- Surface loss/recovery evidence in PR #21 still reports a failure to autonomously restart after a specific virtual-adapter fault.
- TetherAuth resource-scoping correction is still draft PR #25; public metadata and exact ChatGPT issuer issues must be resolved without replacing existing clients.
- Draft Linux developer preview #37 is CI-only until clean installation, pairing, denial, reboot/recovery, rollback and independent acceptance pass.
- ChatGPT desktop-only plugin distribution depends on current OpenAI eligibility; do not promise public marketplace listing.

**Authority:** canonical design and source-of-truth docs, current repository implementation/test status, then read-only platform observations. This release matrix does not supersede `docs/live-acceptance.md` or authorize merges/deployments.

No production identity, relay, device, Windows service, credential or policy modification is authorized by this document.
