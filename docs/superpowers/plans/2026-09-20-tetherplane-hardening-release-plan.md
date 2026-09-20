# Tetherplane Plan F — Hardening and Public Release

**Goal:** Finish Tetherplane v1 as a verifiable, self-hostable release candidate without weakening the local-authority, coexistence, or six-tool contracts established by Plans A–E.

## F1 — Security conformance and threat-model evidence

Create a consolidated threat model and a Plan F security E2E suite.

The suite must prove or cross-reference fresh executable proof for:
- prompt-injection-shaped file/page content remains untrusted data and cannot mint authority;
- path traversal and link/junction escape fail closed;
- approval/identity forgery cannot expand authority;
- secrets are redacted or never persisted;
- retry/replay does not duplicate idempotent mutations;
- account/device routing remains isolated;
- physical foreground takeover requires a valid scoped lease and recent human activity blocks it.

Do not invent duplicate security mechanisms when existing tests already prove the invariant. The threat-model document must map each threat to its implementation boundary and exact test evidence.

## F2 — Recovery and chaos contract

Add missing recovery tests around agent/client loss.

Required evidence:
- browser restart invalidates or reacquires semantic references safely;
- relay loss fails in-flight requests without replay;
- client retry with idempotency key executes once;
- durable job/checkpoint state survives controller replacement;
- process handles are explicitly runtime-scoped: after agent restart an old handle fails safely rather than being rebound to an unrelated process;
- foreground lease expiry/release restoration remains deterministic.

Sleep/wake is documented as relying on monotonic/OS clock semantics where applicable; do not claim physical sleep/wake certification unless exercised on a suitable runner.

## F3 — Windows release packaging

Add a Windows packaging flow that creates a self-contained release directory containing:
- release tetherd binary;
- deployed Compact MCP Node package and runtime dependencies;
- launch scripts for local Compact MCP;
- optional relay deployment artifacts;
- version/commit manifest;
- license and security/readme documents.

No credentials may be packaged.

Use a deterministic staging directory and fail if required artifacts are missing.

## F4 — Windows install/uninstall and service packaging

Provide PowerShell install/uninstall scripts.

Default install scope is per-user and non-destructive.
Installer requirements:
- explicit install prefix;
- no PATH mutation unless explicitly requested;
- create data/config directories separately from binaries;
- install local launcher;
- optional background-agent service/task installation only when explicitly requested;
- preserve user data on ordinary uninstall unless purge is explicitly requested.

Uninstaller requirements:
- stop/remove only Tetherplane-owned service/task/process artifacts;
- remove installed binaries;
- never delete arbitrary user directories;
- purge state only under explicit flag.

Add isolated-prefix install -> local run -> uninstall smoke proof suitable for Windows CI.

## F5 — Public project documentation and policy

Add:
- root README with architecture, six-tool surface, quick start, local/remote modes, coexistence model, security boundaries, and measured limitations;
- LICENSE files consistent with workspace declaration MIT OR Apache-2.0;
- CONTRIBUTING.md with TDD, architecture boundaries, verification requirements, and secret handling;
- SECURITY.md with vulnerability reporting guidance and trust boundaries;
- release/self-host documentation linking existing remote docs;
- compatibility notes linking RDC adapter documentation.

Do not describe design targets as measured achievements.

## F6 — Benchmark refresh

Re-run release benchmarks on Leno after Plan E.

Publish:
- source commit;
- machine/environment;
- cold start;
- idle RSS;
- six-tool count;
- compact response bounds;
- browser benchmark where reproducible;
- desktop semantic observation/action measurements where deterministic.

The existing missed cold-start target remains a measured miss unless fresh evidence shows otherwise.

## F7 — CI and release automation

Strengthen CI to include:
- Rust fmt/clippy/test;
- TS typecheck/test/build;
- E2E;
- authored unsafe scan;
- six-tool assertion;
- Windows package/install/uninstall smoke.

Add a release workflow that builds platform artifacts on version tags without publishing secrets. Publishing a GitHub Release is automated by workflow configuration but is not triggered during Plan F unless the user explicitly requests a release tag.

## F8 — Release-candidate proof

On Leno run:
- complete repository gate;
- Plan F security/recovery tests;
- release package creation;
- isolated clean-prefix install;
- local six-tool MCP smoke from installed artifacts;
- uninstall and residue check;
- benchmark refresh;
- git diff hygiene.

Push the verified feature branch and verify the remote SHA.

A true separate clean-machine proof may additionally run on a fresh GitHub-hosted Windows runner through CI. Do not claim a physical second-machine clean install unless actually executed.
