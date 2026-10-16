# Tetherplane Free Official Agensi Starter Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a safe, independently installable, genuinely free official Tetherplane starter skill on GitHub and prepare an Agensi-compliant submission ZIP that proves the first local MCP interaction without changing core permissions or licensing.

**Architecture:** A plain `SKILL.md` with small supporting references teaches a capable AI client to discover the existing six Compact MCP tools, connect through a user-authorized local adapter, and demonstrate a read-only status call. Existing TypeScript MCP integration tests establish actual tool behavior; Python standard-library tests validate the skill's structure, safety guidance, and reproducible ZIP. Agensi is an optional distribution channel, not a runtime dependency.

**Tech Stack:** Markdown/YAML frontmatter, existing Rust `tetherd` and TypeScript Compact MCP, Node.js 22+/pnpm 10 test runner, Python 3 standard library `unittest` and `zipfile`. No new production Rust/TypeScript dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-open-source-commercial-distribution-design.md`

**Other required references:** `docs/superpowers/specs/2026-09-17-tetherplane-design.md`; `docs/superpowers/plans/2026-09-17-tetherplane-implementation-roadmap.md`; `docs/superpowers/plans/2026-09-17-tetherplane-local-core-plan.md`; `docs/remote/self-host.md`; `tests/e2e/helpers/start-local.ts`; `adapters/compact-mcp/src/compact-tools.ts`; `adapters/compact-mcp/src/schema-catalog.ts`.

## Global Constraints

- Tetherplane Core stays `MIT OR Apache-2.0`; do not switch it to a non-commercial license or impose a paid entitlement requirement.
- The default MCP tool names remain exactly `device`, `files`, `process`, `browser`, `desktop`, `batch`. The skill is instructions only, not another model-facing MCP tool.
- Capability Kernel, Providers, Adapters, Transport and Policy Broker retain their boundaries; the local agent is final authority.
- Default human-coexistence mode remains `background_only`. Never steal keyboard focus, move the physical cursor, overwrite the OS clipboard, commandeer human tabs, terminate human processes, or escalate permission after denial.
- The free starter remains accessible from the canonical GitHub repository independently of Agensi, payment, a hosted relay, or analytics.
- No hard-coded credentials, OAuth tokens, device credential strings, collected user commands, arbitrary download-and-execute instructions, or shell installation that modifies global machine configuration.
- Documentation must say local `device.status` is proven only when tested; a TCP connection is not proof of authenticated remote RPC. Never promise universal client compatibility or guaranteed speed.
- Marketplace packaging: a single folder `tetherplane-starter/` at ZIP root with `SKILL.md` immediately beneath; its YAML `name: tetherplane-starter` matches the folder; `description` must be specific and trigger-based. Bundle only allowlisted UTF-8 text files and license texts; no symlinks, binaries, dotfiles, user-specific paths or machine state.
- Do not create a marketplace submission, use Agensi creator login, connect a payout account, send external messages, or publish a skill/listing without the user's separate explicit approval.
- Verify commands and expected results are grounded in the current repository. If a missing feature is found, record the blocker and route it through the applicable Tetherplane core hardening plan, not a fabricated workaround.

## Review Focus

1. **MCP not installed or `tetherd` missing:** the instructions diagnose prerequisites and offer a non-destructive setup path, rather than reporting a successful connection. The scenario is pinned in Task 2 and the host acceptance in Task 5.
2. **`permission_denied` from a user-specified root:** the skill explains local policy and requests human review without rewriting `--allow`, modifying grants, printing credential files, or circumventing approvals. Pin in Task 2 and the real denial case in Task 3.
3. **Unsupported device `schema` or `capability_unavailable`:** the skill reports the actual response with compatible fallback guidance; no invented tool calls or fake success. Pin in Tasks 2 and 3.
4. **ZIP contains `.env`, binaries, nested roots, path escapes, or symlinks:** validation refuses the artifact, not merely hides those files. Pin with negative archives in Task 4.
5. **A claimed successful remote/other-agent integration has only local fixture evidence:** the publication draft marks it unverified, and no compatibility, uptime, install-time, promotion, or revenue claim is made without evidence. Pin in Task 5.

---

## Repository File Map

| Path | Responsibility |
| --- | --- |
| `skills/tetherplane-starter/SKILL.md` (new) | Small, agent-neutral activation and safe workflow instructions |
| `skills/tetherplane-starter/README.md` (new) | Free installation and supported-host guidance; explicit limitations |
| `skills/tetherplane-starter/references/operations.md` (new) | Exact six-tool Compact MCP mapping; `device.status` / `device.schema`; optional approved-root `files.list` |
| `skills/tetherplane-starter/references/setup.md` (new) | Prerequisites and non-destructive local setup; manual remote pairing reference |
| `skills/tetherplane-starter/references/troubleshooting.md` (new) | Denied, unavailable, offline and authentication recovery without privilege escalation |
| `skills/tetherplane-starter/examples/safe-first-run.md` (new) | Human-readable verified first-run interaction |
| `skills/tetherplane-starter/examples/first-run.json` (new) | Executable read-only MCP sample consumed by existing E2E harness |
| `tests/skills/package.json` (new) | Adds skill checks to existing `pnpm -r test` without adding dependencies |
| `tests/skills/test_starter_contract.py` (new) | Validate SKILL.md, trigger/frontmatter, security and operation references |
| `tests/skills/test_starter_guidance.py` (new) | Validate supported diagnosis and no unsafe escalation instructions |
| `tests/skills/test_starter_package.py` (new) | Verify ZIP topology, allowlist, deterministic output and rejected unsafe files |
| `tests/skills/test_listing.py` (new) | Ensure the draft is explicitly free, honest, and not already submitted |
| `tests/e2e/tetherplane-starter.test.ts` (new) | Run fixture calls through real local MCP, verify exact tools and denied case |
| `scripts/package_starter_skill.py` (new) | Produce deterministic minimal Agensi ZIP from vetted allowlisted files |
| `docs/distribution/agensi-starter-listing-draft.md` (new) | Prepared but unsubmitted marketplace description, limitations and permission declarations |
| `README.md` (modify) | Link the free official skill, not gate core functionality on its use |

Use the existing `tests/e2e/helpers/start-local.ts` and existing package configurations. `pnpm-workspace.yaml` already includes `tests/*`, so no workspace structural change is needed.

## Task 1: Minimal Skill Contract and Safe Operations

**Files:**
- Create: `skills/tetherplane-starter/SKILL.md`
- Create: `skills/tetherplane-starter/references/operations.md`
- Create: `tests/skills/package.json`
- Test: `tests/skills/test_starter_contract.py`

**Interfaces:**
- `SKILL.md` YAML frontmatter is exactly `name: tetherplane-starter` plus a specific `description` in the minimal required format; all operational instructions are ordinary Markdown.
- `references/operations.md` documents `device` with `op: status` and `args: {}`; `device` with `op: schema` and `args: {namespace: device, operation: status}`; `files` with `op: list` only for a human-approved allowed path.
- Test package identifier: `@tetherplane/starter-skill-tests`; `test` script runs `python -m unittest discover -s tests/skills -p "test_*.py"`.

- [ ] **Step 1: Write failing `test_starter_contract.py`**. `test_minimal_frontmatter_matches_folder` asserts first delimiters are `---`, name is `tetherplane-starter` and description is nonempty; `test_exact_six_mcp_tools_documented` compares declared tool names to `{device,files,process,browser,desktop,batch}`; `test_read_only_first_call_is_device_status` checks first-run semantics and no command execution or permission bypass.
- [ ] **Step 2: Run `pnpm --filter @tetherplane/starter-skill-tests test`** and confirm the intended failure is missing `SKILL.md` or `references/operations.md`, not a Python runner or setup error.
- [ ] **Step 3: Implement those two skill files** using existing operation names from `adapters/compact-mcp/src/translate.ts` and `schema-catalog.ts`. Keep the SKILL.md body concise (target under 180 lines) and refer to supporting files for detail. No runtime installer code.
- [ ] **Step 4: Rerun focused skill tests** and verify a zero exit status. Run `pnpm --filter @tetherplane/compact-mcp test` to detect a documented API mismatch.
- [ ] **Step 5: Commit** `git add skills/tetherplane-starter/SKILL.md skills/tetherplane-starter/references/operations.md tests/skills/package.json tests/skills/test_starter_contract.py && git commit -m "feat(skills): define free Tetherplane starter contract"`.

## Task 2: Setup, Human-Safe Examples and Failure Recovery

**Files:**
- Create: `skills/tetherplane-starter/references/setup.md`
- Create: `skills/tetherplane-starter/references/troubleshooting.md`
- Create: `skills/tetherplane-starter/examples/safe-first-run.md`
- Create: `skills/tetherplane-starter/README.md`
- Test: `tests/skills/test_starter_guidance.py`

**Interfaces:**
- `setup.md` consumes actual documented build requirements: Rust toolchain, Node.js 22+, pnpm 10, user-authorized `--allow` root, `tetherd` binary, `adapters/compact-mcp/dist/stdio-server.js`.
- `troubleshooting.md` consumes known codes `permission_denied`, `capability_unavailable`, and auth/relay failures. Produces a specific observation → cause → reversible next step without suggesting token disclosure.
- `safe-first-run.md` shows read-only `device.status` first; a permitted `files.list` example is optional and explicitly rooted in a user-approved path.

- [ ] **Step 1: Write failing guidance tests**: `test_missing_agent_requires_prerequisite_check`; `test_denied_operation_does_not_escalate`; `test_capability_unavailable_is_reported`; `test_auth_error_never_requests_credentials_in_chat`; `test_remote_tcp_is_not_described_as_authenticated_rpc`; `test_first_run_requires_read_only_status`. Tests inspect referenced sections and examples; do not assume static linting proves model behavior.
- [ ] **Step 2: Run `pnpm --filter @tetherplane/starter-skill-tests test`** and confirm the intended missing guidance failure.
- [ ] **Step 3: Write the four docs** grounded in `README.md`, `docs/remote/self-host.md` and the existing supported CLI. Keep all commands opt-in and never instruct changing principal grants or task scheduling as automatic remediation.
- [ ] **Step 4: Rerun targeted skill tests** and manually review every example against the current compact MCP schemas. Commit `git add skills/tetherplane-starter tests/skills/test_starter_guidance.py && git commit -m "docs(skills): add safe setup and recovery guidance"`.

## Task 3: Real Local MCP Example Executed End to End

**Files:**
- Create: `skills/tetherplane-starter/examples/first-run.json`
- Test: `tests/e2e/tetherplane-starter.test.ts`
- Reuse unchanged: `tests/e2e/helpers/start-local.ts`

**Interfaces:**
- `first-run.json` is a JSON array of two `{name: "device", arguments: ...}` MCP calls in order:
  1. `{name:"device", arguments:{op:"status",args:{}}}`
  2. `{name:"device", arguments:{op:"schema",args:{namespace:"device",operation:"status"}}}`
- Optional `files.list` is illustrated only in Markdown with an explicitly authorized root. The test intentionally attempts an outside-root `files.read` for the denial proof, without writing data.
- The E2E test calls `startLocalCompact()`, `client.listTools()` and `client.callTool()`, and reads `structuredContent` from results.

- [ ] **Step 1: Write failing `tetherplane-starter.test.ts`**. `starter_example_executes_read_only_and_preserves_policy` first loads `examples/first-run.json`, checks the exact six listed tools, runs both fixture calls, asserts success and an actual status/schema response, then calls `files.read` outside the harness's allowed root and asserts `isError === true` with `error.code === "permission_denied"`. No real machine files are read.
- [ ] **Step 2: Build the existing E2E prerequisites** with `cargo build -p tetherd` and `pnpm --filter @tetherplane/e2e build:deps`, then run `node --test tests/e2e/tetherplane-starter.test.ts`. The expected red is the absent example JSON, *not* missing binaries, blocked network or unrelated test infrastructure.
- [ ] **Step 3: Implement `examples/first-run.json`** matching the documented skill instructions and existing MCP contract; do not modify providers or policy simply to make a documentation test pass.
- [ ] **Step 4: Rerun the focused test, then `pnpm --filter @tetherplane/e2e test`**. If the underlying core is broken, capture exact evidence for a separate core hardening task; never fake a successful response in the fixture.
- [ ] **Step 5: Commit** `git add skills/tetherplane-starter/examples/first-run.json tests/e2e/tetherplane-starter.test.ts && git commit -m "test(skills): prove starter calls through local MCP"`.

## Task 4: Deterministic, Fail-Closed Agensi ZIP

**Files:**
- Create: `scripts/package_starter_skill.py`
- Test: `tests/skills/test_starter_package.py`

**Interfaces:**
- `build_starter_archive(repo_root: pathlib.Path, output_path: pathlib.Path) -> pathlib.Path`
- CLI: `python scripts/package_starter_skill.py --output dist/agensi/tetherplane-starter.zip`.
- Allowlisted skill files are precisely `SKILL.md`, `README.md`, `references/operations.md`, `references/setup.md`, `references/troubleshooting.md`, `examples/safe-first-run.md`, `examples/first-run.json` plus `LICENSE`, `LICENSE-MIT` and `LICENSE-APACHE` taken from canonical repository root.
- ZIP members have only one top-level folder `tetherplane-starter/`; relative paths and member names are sorted; metadata timestamps and permissions are fixed so repeated packaging in the same environment yields identical bytes.

- [ ] **Step 1: Write failing packaging tests**: `test_single_root_and_expected_members` asserts every member begins with `tetherplane-starter/` and `tetherplane-starter/SKILL.md` exists; `test_reproducible_bytes` compares SHA-256 for two builds from the same inputs; `test_rejects_unexpected_env_or_binary` injects `.env` or `evil.exe` into a temporary skill fixture and expects rejection; `test_rejects_symlink_and_path_escape` expects failure for a symlink or traversal entry; `test_bundles_full_dual_license_texts` compares ZIP license contents to root.
- [ ] **Step 2: Run `pnpm --filter @tetherplane/starter-skill-tests test`** and confirm missing `build_starter_archive` is the only new red, not environment failure.
- [ ] **Step 3: Implement the pure Python archiver** with strict positive file allowlist, real-path containment, no symlinks, text-only extensions and byte-size bounds. Refuse unexpected files rather than silently dropping them. Avoid absolute user paths in archive comments or metadata.
- [ ] **Step 4: Rerun tests** and execute the CLI twice; inspect member list and compare SHA-256. Commit `git add scripts/package_starter_skill.py tests/skills/test_starter_package.py && git commit -m "build(skills): package audited Agensi starter ZIP"`.

## Task 5: Free Distribution Copy and Host Acceptance

**Files:**
- Create: `docs/distribution/agensi-starter-listing-draft.md`
- Create: `tests/skills/test_listing.py`
- Modify: `README.md`

**Interfaces:**
- The distribution draft explicitly says `Free`, `Not submitted`, the exact supported six tools, non-destructive permissions, known limitations and a link to the canonical GitHub source. It contains proposed description, accurate categories/tags and permission declarations; excludes paid skill price, analytics guarantees and marketplace feature placement claims.
- The host acceptance record classifies each tested agent as `verified`, `blocked` or `not tested`, with relevant version and non-sensitive results. No generic "20+ agents" claim without tests.

- [ ] **Step 1: Write failing `test_listing.py`**. Assert `docs/distribution/agensi-starter-listing-draft.md` exists and declares free/unsubmitted; the main README contains a stable relative link to the skill; claims about supported hosts and live remote RPC require explicit evidence statuses; skill instructions do not depend on an Agensi account to function.
- [ ] **Step 2: Run `pnpm --filter @tetherplane/starter-skill-tests test`** and confirm failures are absent listing documentation and README link.
- [ ] **Step 3: Author the marketplace draft and link the starter from README**. Document the current Agensi Creator Dashboard submission flow without opening it or submitting. Include a checklist of screenshot/demo/permission disclosures only when verified, and a testing table with truthful statuses.
- [ ] **Step 4: Run real host acceptance** on at least one locally authorized agent; test a second distinct compatible agent where accessible. Record exact success/failure without credentials. Never change active human browser tabs or install to another device without explicit permission.
- [ ] **Step 5: Rerun focused tests**. Commit `git add docs/distribution/agensi-starter-listing-draft.md README.md tests/skills/test_listing.py && git commit -m "docs(skills): prepare free Agensi starter listing"`.

## Task 6: Final Candidate and Release Gate

**Files:**
- Update: `docs/distribution/agensi-starter-listing-draft.md` only to record fresh verification facts.
- No new core product code, no Agensi account/payout mutations, no release tag.

**Interfaces:** Candidate consists of reviewed GitHub sources, a reproducible ZIP, versioned documentation and a test evidence note; packaging/publication remain separate explicit actions.

- [ ] **Step 1: Run full repository gates**: `cargo fmt --all -- --check`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo test --workspace`; `pnpm -r typecheck`; `pnpm -r test`; `pnpm -r build`; `python scripts/check-no-unsafe.py`; `git diff --check`. Also run existing Windows package smoke on Windows, without changing live production tasks.
- [ ] **Step 2: Package and inspect** with `python scripts/package_starter_skill.py --output dist/agensi/tetherplane-starter.zip`. Record archive SHA-256, file count, license inclusion, security scan results and an independently reviewed excerpt of the skill. Do not submit ZIP to the marketplace to "test" it without approval.
- [ ] **Step 3: Verify new branch GitHub CI** on Linux and Windows for the exact commit. If current Rust 1.99 Clippy baseline failures persist, document them as blockers for the repository release; don't claim the full gate passed. Resolve only through the separately reviewed release-hardening plan.
- [ ] **Step 4: Separate local and remote proof**: report real local `device.status` result; remote devices require a verified authenticated device RPC before any cross-device compatibility claim. Transport TCP establishment alone never qualifies.
- [ ] **Step 5: Request user review of the candidate package and listing**. Obtain separate explicit permission for Agensi submission, payout setup, external communication and any GitHub release publication. No automatic submit/tag.

## Acceptance and handoff

The free starter is considered **ready to submit**, not published, when: SKILL.md/frontmatter and stable first-run workflow pass source tests; actual local MCP calls succeed and policy denial remains intact; ZIP is safe/reproducible with full dual-license texts; at least one supported host has real acceptance evidence; no secrets, permissions escalations or misleading claims appear; repository gates and CI status are reported accurately. If the broader repo remains red for an unrelated known issue, that status is explicit and prevents claiming full release readiness.

The free skill remains on GitHub with no paywall. The paid specialist skill and managed relay service are separate later projects needing individual design, evidence, and approval. The user must approve the final Agensi listing submission before publication.

## Current external source contracts

- Agensi SKILL.md reference: https://www.agensi.io/learn/skill-md-format-reference (name and description; folder slug must match)
- Agensi creator guide: https://www.agensi.io/learn/how-to-sell-skills-on-agensi (ZIP, free listing, security and manual review)
- Agensi submission security checklist: https://www.agensi.io/learn/skill-md-creator-checklist (single top-level folder, no binaries or symlinks)
- Agensi security scan: https://www.agensi.io/learn/how-agensi-security-scan-works (prompt injection, credential leakage, network and file integrity)

These are the public requirements inspected on 2026-10-14. Confirm them again before actual submission because marketplace rules may change.
