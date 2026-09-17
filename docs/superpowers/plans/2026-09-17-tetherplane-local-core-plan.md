# Tetherplane Local Core and Compact MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working Tetherplane vertical slice: a Rust capability kernel with local policy enforcement, filesystem/search/persistent-process providers, batching and handles, connected to a TypeScript stdio MCP edge exposing exactly six compact tools.

**Architecture:** The Rust binary `tetherd` owns canonical capability execution and communicates with the TypeScript Compact MCP adapter over newline-delimited JSON on child-process stdio for the first local slice. The TypeScript MCP process translates six compact tools into canonical invocation envelopes and never implements machine capabilities itself. Browser and desktop tools exist from day one but truthfully return `capability_unavailable` until their providers are installed.

**Tech Stack:** Rust workspace with Tokio, Serde, Serde JSON, UUID, Thiserror, Tracing, Clap, Ignore/Globset, Regex, and portable PTY support; TypeScript workspace with Node.js, pnpm, the current `@modelcontextprotocol/sdk`, Ajv, generated TypeScript protocol types, Vitest, and Execa; JSON Schema for cross-language protocol fixtures.

**Spec:** `docs/superpowers/specs/2026-09-17-tetherplane-design.md`

## Global Constraints

- Default AI-visible MCP surface is exactly six tools: `device`, `files`, `process`, `browser`, `desktop`, `batch`.
- `background_only` is the default coexistence mode.
- Local agent is the final authority for policy decisions.
- Compact response mode is the default.
- Large outputs use continuation/state handles rather than unbounded tool results.
- Human-origin processes are not terminable by default.
- Allowed-directory enforcement must reject traversal and symlink/junction escapes.
- Local mode must require no relay.
- Initial performance targets remain design targets until measured: idle agent memory below 50 MB and cold start below 250 ms on representative hardware.
- No browser binary is bundled in this plan.
- Canonical internal semantics do not use Remote Desktop Commander tool names.

## File Structure

Create this structure during the tasks below:

```text
Tetherplane/
├── Cargo.toml
├── rust-toolchain.toml
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── agent/
│   ├── tether-core/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── envelope.rs
│   │       ├── error.rs
│   │       ├── router.rs
│   │       ├── handles.rs
│   │       ├── budget.rs
│   │       └── policy.rs
│   ├── providers/
│   │   ├── filesystem/
│   │   ├── search/
│   │   └── process/
│   └── tetherd/
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs
│           └── stdio_rpc.rs
├── adapters/
│   └── compact-mcp/
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts
│       │   ├── agent-client.ts
│       │   ├── compact-tools.ts
│       │   └── translate.ts
│       └── test/
├── protocol/
│   ├── package.json
│   ├── schemas/
│   │   ├── invocation.schema.json
│   │   ├── result.schema.json
│   │   ├── error.schema.json
│   │   └── capability.schema.json
│   ├── fixtures/
│   │   ├── invocation-device-status.json
│   │   ├── result-device-status.json
│   │   └── error-capability-unavailable.json
│   ├── scripts/
│   │   └── generate-types.mjs
│   └── generated/
│       └── types.ts
├── tests/
│   └── e2e/
│       ├── package.json
│       └── local-compact.test.ts
└── .github/
    └── workflows/
        └── ci.yml
```

The Rust crates are small by responsibility. Provider crates depend on `tether-core`; `tether-core` must not depend on provider crates. The TypeScript MCP adapter depends on protocol types but has no direct filesystem/process implementation.

---

### Task 1: Bootstrap the Polyglot Workspace and Quality Gates

**Files:**
- Create: `Cargo.toml`
- Create: `rust-toolchain.toml`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `.github/workflows/ci.yml`
- Test: workspace metadata commands and empty test runners

**Interfaces:**
- Consumes: approved design spec only.
- Produces: a Rust Cargo workspace and pnpm TypeScript workspace that all later tasks add to without changing workspace conventions.

- [ ] **Step 1: Write the workspace files with strict defaults**

`Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = [
  "agent/tether-core",
  "agent/providers/filesystem",
  "agent/providers/search",
  "agent/providers/process",
  "agent/tetherd",
]

[workspace.package]
edition = "2024"
license = "MIT OR Apache-2.0"
version = "0.1.0"

[workspace.lints.rust]
unsafe_code = "deny"

[workspace.lints.clippy]
all = "warn"
pedantic = "warn"
```

`rust-toolchain.toml`:

```toml
[toolchain]
channel = "stable"
components = ["clippy", "rustfmt"]
profile = "minimal"
```

`package.json`:

```json
{
  "name": "tetherplane-workspace",
  "private": true,
  "packageManager": "pnpm@10",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "protocol"
  - "adapters/*"
  - "tests/*"
```

- [ ] **Step 2: Create minimal crate/package manifests so metadata commands have real members**

Create each Rust member `Cargo.toml` with package metadata inherited from the workspace and a minimal `src/lib.rs` or `src/main.rs`. Create minimal TypeScript package manifests for `protocol`, `adapters/compact-mcp`, and `tests/e2e` with `build`, `test`, and `typecheck` scripts.

- [ ] **Step 3: Run workspace validation and verify the baseline passes**

Run:

```bash
cargo metadata --no-deps
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm install
pnpm -r typecheck
pnpm -r test
```

Expected: all commands succeed with zero tests or only bootstrap smoke tests.

- [ ] **Step 4: Add CI that runs the same gates on Linux and Windows**

`.github/workflows/ci.yml` must run Rust formatting, Clippy, Rust tests, pnpm install with frozen lockfile, TypeScript typecheck, and TypeScript tests on `ubuntu-latest` and `windows-latest`.

- [ ] **Step 5: Commit the bootstrap**

```bash
git add Cargo.toml rust-toolchain.toml package.json pnpm-workspace.yaml tsconfig.base.json .gitignore .editorconfig .github agent adapters protocol tests pnpm-lock.yaml
git commit -m "build: bootstrap Tetherplane workspace"
```

---

### Task 2: Define the Versioned Canonical Protocol

**Files:**
- Create: `protocol/schemas/invocation.schema.json`
- Create: `protocol/schemas/result.schema.json`
- Create: `protocol/schemas/error.schema.json`
- Create: `protocol/schemas/capability.schema.json`
- Create: `protocol/fixtures/invocation-device-status.json`
- Create: `protocol/fixtures/result-device-status.json`
- Create: `protocol/fixtures/error-capability-unavailable.json`
- Create: `protocol/scripts/generate-types.mjs`
- Create: `protocol/generated/types.ts`
- Create: `agent/tether-core/src/envelope.rs`
- Create: `agent/tether-core/src/error.rs`
- Modify: `agent/tether-core/src/lib.rs`
- Test: `agent/tether-core/tests/protocol_fixtures.rs`
- Test: `protocol/test/schema.test.ts`

**Interfaces:**
- Consumes: no runtime dependency from later tasks.
- Produces: `InvocationEnvelope`, `ResultEnvelope`, `CapabilityError`, `ResponseMode`, `VerificationStatus`, and JSON Schema documents used by every adapter/provider boundary.

- [ ] **Step 1: Write failing schema tests for the canonical fixture set**

The TypeScript test must load the four schemas with Ajv and assert that the three fixtures validate against their intended schema and fail when required fields are removed.

Example assertion:

```ts
expect(validateInvocation(invocationFixture)).toBe(true);
const invalid = { ...invocationFixture } as Record<string, unknown>;
delete invalid.request_id;
expect(validateInvocation(invalid)).toBe(false);
```

- [ ] **Step 2: Run the protocol test and verify it fails because schemas are absent**

Run:

```bash
pnpm --filter @tetherplane/protocol test
```

Expected: FAIL because schema/fixture files cannot be loaded.

- [ ] **Step 3: Implement the canonical JSON Schemas**

`InvocationEnvelope` must contain:

```text
protocol_version: string
request_id: UUID string
device_id: string | null
capability: string
arguments: object
actor: { id: string, kind: "human" | "ai_client" | "system" }
session_id: string | null
response_mode: "compact" | "normal" | "debug"
idempotency_key: string | null
preconditions: array
expectations: array
```

`ResultEnvelope` must contain:

```text
protocol_version: string
request_id: UUID string
status: "success" | "error"
data: object | null
delta: object | null
error: CapabilityError | null
verification: "not_applicable" | "verified" | "executed_unverified" | "failed"
continuation: object | null
policy: object | null
timing: { duration_ms: integer }
```

`CapabilityError.code` enum must include every category from design section 14.

- [ ] **Step 4: Generate TypeScript types from the schemas**

`protocol/scripts/generate-types.mjs` must generate deterministic TypeScript declarations into `protocol/generated/types.ts` and fail if generation produces an empty file.

Run:

```bash
pnpm --filter @tetherplane/protocol build
```

Expected: generated types include `InvocationEnvelope`, `ResultEnvelope`, and `CapabilityError`.

- [ ] **Step 5: Write failing Rust fixture round-trip tests**

Test pattern:

```rust
#[test]
fn invocation_fixture_round_trips() {
    let raw = include_str!("../../../protocol/fixtures/invocation-device-status.json");
    let parsed: InvocationEnvelope = serde_json::from_str(raw).unwrap();
    assert_eq!(parsed.capability, "device.status");
    let encoded = serde_json::to_value(parsed).unwrap();
    assert_eq!(encoded["protocol_version"], "1.0");
}
```

- [ ] **Step 6: Implement Rust protocol types with Serde**

Use explicit enums with `snake_case` serialization. `CapabilityError` must carry:

```rust
pub struct CapabilityError {
    pub code: ErrorCode,
    pub message: String,
    pub recovery_hint: Option<String>,
    pub details: serde_json::Value,
}
```

Do not expose Rust backtraces in the serialized error type.

- [ ] **Step 7: Run protocol tests in both languages**

Run:

```bash
cargo test -p tether-core --test protocol_fixtures
pnpm --filter @tetherplane/protocol test
```

Expected: PASS.

- [ ] **Step 8: Commit the protocol contract**

```bash
git add protocol agent/tether-core
git commit -m "feat(protocol): define canonical capability envelopes"
```

---

### Task 3: Build the Capability Router and Provider Boundary

**Files:**
- Create: `agent/tether-core/src/router.rs`
- Create: `agent/tether-core/src/provider.rs`
- Modify: `agent/tether-core/src/lib.rs`
- Test: `agent/tether-core/tests/router.rs`

**Interfaces:**
- Consumes: `InvocationEnvelope`, `ResultEnvelope`, `CapabilityError`.
- Produces:

```rust
#[async_trait::async_trait]
pub trait CapabilityProvider: Send + Sync {
    fn namespace(&self) -> &'static str;
    async fn execute(&self, invocation: &InvocationEnvelope) -> Result<ProviderResult, CapabilityError>;
}

pub struct CapabilityRouter { /* private registry */ }
impl CapabilityRouter {
    pub fn new() -> Self;
    pub fn register(&mut self, provider: Arc<dyn CapabilityProvider>) -> Result<(), CapabilityError>;
    pub async fn execute(&self, invocation: InvocationEnvelope) -> ResultEnvelope;
}
```

- [ ] **Step 1: Write failing router tests**

Cover:

- registered namespace receives `filesystem.read`;
- unknown namespace returns `capability_unavailable`;
- duplicate namespace registration fails;
- provider errors become `ResultEnvelope.status = error` with the original request ID.

- [ ] **Step 2: Run the router tests and confirm failure**

```bash
cargo test -p tether-core --test router
```

Expected: FAIL because `CapabilityRouter` does not exist.

- [ ] **Step 3: Implement the minimal provider trait and router**

Split capability name at the first `.`; route `filesystem.read` to provider namespace `filesystem`. Reject names without a namespace separator as `invalid_arguments`.

- [ ] **Step 4: Add per-request monotonic timing**

`CapabilityRouter::execute` records elapsed milliseconds and populates `result.timing.duration_ms` for success and error paths.

- [ ] **Step 5: Run tests and commit**

```bash
cargo test -p tether-core --test router
cargo clippy -p tether-core --all-targets -- -D warnings
git add agent/tether-core
git commit -m "feat(core): add capability router"
```

---

### Task 4: Implement the Local Policy Broker and Path Authorization

**Files:**
- Create: `agent/tether-core/src/policy.rs`
- Create: `agent/tether-core/src/ownership.rs`
- Modify: `agent/tether-core/src/router.rs`
- Test: `agent/tether-core/tests/policy.rs`

**Interfaces:**
- Consumes: `InvocationEnvelope` before provider dispatch.
- Produces:

```rust
pub enum PolicyDecision {
    Allow,
    Deny { reason: String },
    RequireApproval { reason: String, approval_scope: ApprovalScope },
}

pub trait PolicyBroker: Send + Sync {
    fn evaluate(&self, invocation: &InvocationEnvelope) -> PolicyDecision;
}
```

and `LocalPolicyConfig` containing `allowed_directories`, `background_only`, and operation-class rules.

- [ ] **Step 1: Write failing policy tests for safe defaults**

Required cases:

```text
filesystem.read inside allowed directory -> allow
filesystem.read outside allowed directory -> deny
filesystem.delete -> require approval
process.terminate human-origin -> deny
browser.* with no provider -> policy does not fabricate availability
foreground_disruptive without lease -> require foreground lease at the relevant provider stage
```

- [ ] **Step 2: Write failing canonicalization tests**

Use temporary directories to prove these inputs cannot escape an allowed root:

```text
allowed/../secret.txt
allowed/link-to-outside/secret.txt
mixed path separators on Windows
nonexistent child under an allowed canonical parent
```

The test must compare the resolved/canonical parent chain, not use string-prefix authorization.

- [ ] **Step 3: Implement `LocalPolicyBroker` and path-scope helper**

Implement explicit side-effect classes and route filesystem path checks through a single helper. Existing paths must canonicalize before authorization. New paths must canonicalize the nearest existing parent and append normalized child segments only after rejecting `..` escapes.

- [ ] **Step 4: Insert policy evaluation before provider execution**

`CapabilityRouter` must return `permission_denied` or `approval_required` without invoking the provider. Add a mock-provider assertion proving the provider call count remains zero on denial.

- [ ] **Step 5: Run policy tests and commit**

```bash
cargo test -p tether-core --test policy
cargo test -p tether-core
git add agent/tether-core
git commit -m "feat(policy): enforce local capability policy"
```

---

### Task 5: Add Stable Handles and Response Budgets

**Files:**
- Create: `agent/tether-core/src/handles.rs`
- Create: `agent/tether-core/src/budget.rs`
- Modify: `agent/tether-core/src/lib.rs`
- Test: `agent/tether-core/tests/handles.rs`
- Test: `agent/tether-core/tests/budget.rs`

**Interfaces:**
- Produces:

```rust
pub struct HandleRegistry<T> { /* private */ }
impl<T> HandleRegistry<T> {
    pub fn insert(&self, kind: &'static str, value: T) -> String;
    pub fn with<R>(&self, handle: &str, f: impl FnOnce(&T) -> R) -> Result<R, CapabilityError>;
    pub fn remove(&self, handle: &str) -> Option<T>;
}

pub struct ResponseBudget {
    pub mode: ResponseMode,
    pub max_bytes: usize,
    pub max_items: usize,
}
```

- [ ] **Step 1: Write failing tests for opaque typed handles**

Assert handles have a kind prefix such as `proc_`, are unique, and a missing handle returns `invalid_arguments` rather than panicking.

- [ ] **Step 2: Implement a thread-safe handle registry**

Use UUID-backed opaque handles and an internal `RwLock<HashMap<...>>`. Do not encode raw pointers, OS PIDs, paths, or credentials into handles.

- [ ] **Step 3: Write failing response-budget tests**

Compact mode must truncate a 100 KB synthetic output, return a continuation object, and preserve UTF-8 boundaries. Debug mode may return a larger bounded slice but is never unbounded.

- [ ] **Step 4: Implement byte/item budgeting helpers**

Return a struct containing delivered content plus a continuation cursor/handle. The helper must never split inside a UTF-8 code point.

- [ ] **Step 5: Run tests and commit**

```bash
cargo test -p tether-core --test handles --test budget
git add agent/tether-core
git commit -m "feat(core): add handles and response budgets"
```

---

### Task 6: Implement the Filesystem Provider

**Files:**
- Create: `agent/providers/filesystem/Cargo.toml`
- Create: `agent/providers/filesystem/src/lib.rs`
- Create: `agent/providers/filesystem/src/read.rs`
- Create: `agent/providers/filesystem/src/write.rs`
- Create: `agent/providers/filesystem/src/list.rs`
- Create: `agent/providers/filesystem/src/patch.rs`
- Test: `agent/providers/filesystem/tests/filesystem.rs`

**Interfaces:**
- Consumes: canonical `filesystem.*` invocations after policy authorization.
- Produces operations:

```text
filesystem.read
filesystem.read_many
filesystem.write
filesystem.append
filesystem.patch
filesystem.list
filesystem.info
filesystem.mkdir
filesystem.move
```

Provider output is structured JSON and uses `tether-core` response-budget helpers.

- [ ] **Step 1: Write failing read/list/info tests**

Use `tempfile::TempDir`. Cover:

- line-bounded UTF-8 reads;
- negative/tail reads;
- multi-file reads where one file fails without suppressing successful entries;
- depth-bounded directory listing;
- metadata containing size, modified time, type, and text line count.

- [ ] **Step 2: Implement read/list/info with no shell commands**

Use Rust filesystem APIs directly. Do not invoke `cat`, `type`, `dir`, `ls`, or PowerShell.

- [ ] **Step 3: Write failing write/append/mkdir/move tests**

Assert parent-missing errors are machine-readable and moving onto an existing destination fails unless the request explicitly enables replace semantics.

- [ ] **Step 4: Implement atomic writes**

Write a sibling temporary file, flush it, and rename/replace according to the request. Append mode may use append-only file opening but must remain path-authorized.

- [ ] **Step 5: Write failing exact-patch tests**

Required behavior:

```text
one exact match + expected_replacements=1 -> success
zero matches -> precondition_failed
multiple matches + expected_replacements=1 -> precondition_failed
expected_replacements=2 and exactly two matches -> success
```

- [ ] **Step 6: Implement guarded exact patching**

Read the current file, count exact matches, reject mismatch before writing, then atomically replace. Return changed byte/line ranges rather than the full file in compact mode.

- [ ] **Step 7: Run provider tests and commit**

```bash
cargo test -p tether-filesystem
cargo clippy -p tether-filesystem --all-targets -- -D warnings
git add agent/providers/filesystem
git commit -m "feat(files): add native filesystem provider"
```

---

### Task 7: Implement Progressive Native Search

**Files:**
- Create: `agent/providers/search/Cargo.toml`
- Create: `agent/providers/search/src/lib.rs`
- Create: `agent/providers/search/src/session.rs`
- Test: `agent/providers/search/tests/search.rs`

**Interfaces:**
- Consumes canonical operations:

```text
search.start
search.read
search.stop
search.list
```

- Produces a `search_*` handle and paginated/progressive unseen matches. Compact MCP maps these behind `files(op="search" | "search_read" | "search_stop" | "search_list")`.

- [ ] **Step 1: Write failing filename-search tests**

Create a fixture tree containing hidden files, mixed-case names, and nested directories. Test regex, literal, case-sensitive/insensitive, hidden-file inclusion, and max-result behavior.

- [ ] **Step 2: Write failing content-search tests**

Cover literal and regex search, file glob filters, bounded context lines, binary-file skipping, and UTF-8 error handling.

- [ ] **Step 3: Implement search using native libraries**

Use `ignore`/`globset`/`regex` traversal and matching. Do not shell out to ripgrep in the canonical provider. Run search work on bounded blocking workers so the async runtime remains responsive.

- [ ] **Step 4: Add progressive session semantics**

`search.start` returns immediately with a handle. Search results accumulate in a bounded queue. `search.read` returns results not previously delivered to that session cursor. `search.stop` marks cancellation and terminates traversal promptly.

- [ ] **Step 5: Test cancellation and bounded queues**

Generate a tree large enough that cancellation can occur before completion. Assert queue growth remains bounded and cancellation transitions the session to a terminal state.

- [ ] **Step 6: Run tests and commit**

```bash
cargo test -p tether-search
git add agent/providers/search
git commit -m "feat(search): add progressive native search"
```

---

### Task 8: Implement Persistent Process and REPL Sessions

**Files:**
- Create: `agent/providers/process/Cargo.toml`
- Create: `agent/providers/process/src/lib.rs`
- Create: `agent/providers/process/src/session.rs`
- Create: `agent/providers/process/src/output.rs`
- Test: `agent/providers/process/tests/process.rs`

**Interfaces:**
- Consumes canonical operations:

```text
process.run
process.read
process.input
process.list_sessions
process.list_system
process.terminate
```

- Produces opaque `proc_*` handles. Session reads return only output newer than the caller's current cursor unless an absolute/tail offset is requested.

- [ ] **Step 1: Write failing short-command and long-command tests**

Required behavior:

```text
short command -> exit code + complete bounded output + running=false
long command with initial wait budget -> proc handle + initial output + running=true
```

Use platform-neutral test helpers that select `cmd.exe /C` on Windows and `/bin/sh -c` on Unix.

- [ ] **Step 2: Implement process spawning and session registration**

Start child processes without blocking the Tokio runtime. Capture stdout/stderr into separate bounded ring buffers with monotonically increasing line/byte cursors.

- [ ] **Step 3: Write failing incremental-read tests**

A process that prints `one`, pauses, then prints `two` must yield `one` on the first read and only `two` on the second default read.

- [ ] **Step 4: Implement incremental output cursors and tail/absolute reads**

Store output sequence numbers independently of MCP transport. Compact reads default to unseen output and use continuation metadata when budget limits are hit.

- [ ] **Step 5: Write failing interactive-input test**

Start an interactive REPL/line echo session, send input through `process.input`, and assert the response appears in the next incremental read.

- [ ] **Step 6: Add PTY-backed interactive sessions**

Use portable PTY/ConPTY support so REPLs that require a terminal behave correctly. Keep non-interactive commands on cheaper piped stdio when PTY is not requested.

- [ ] **Step 7: Add ownership and termination tests**

Tetherplane-created processes are `origin=tetherplane`. System process enumeration marks discovered processes `origin=human_or_external`. `process.terminate` must reject non-Tetherplane-origin PIDs under default policy.

- [ ] **Step 8: Implement graceful then forceful termination semantics**

Terminate a Tetherplane session gracefully when supported, wait a bounded interval, then force terminate only when the request/policy permits. Session metadata records the terminal reason.

- [ ] **Step 9: Run tests and commit**

```bash
cargo test -p tether-process
git add agent/providers/process
git commit -m "feat(process): add persistent process sessions"
```

---

### Task 9: Assemble the Agent Runtime and JSONL Stdio RPC

**Files:**
- Create: `agent/tetherd/src/main.rs`
- Create: `agent/tetherd/src/stdio_rpc.rs`
- Create: `agent/tetherd/src/runtime.rs`
- Modify: `agent/tetherd/Cargo.toml`
- Test: `agent/tetherd/tests/stdio_rpc.rs`

**Interfaces:**
- Consumes: one JSON-serialized `InvocationEnvelope` per stdin line in `--stdio-rpc` mode.
- Produces: exactly one JSON-serialized `ResultEnvelope` per stdout line with the same `request_id`. Human-readable logs go to stderr only.

- [ ] **Step 1: Write failing stdio RPC integration test**

Spawn the compiled `tetherd --stdio-rpc` binary, send a `device.status` fixture line, and assert one parseable result line returns with the same request ID.

- [ ] **Step 2: Implement runtime registration**

Register providers under canonical namespaces:

```text
device -> built-in device provider
filesystem -> filesystem provider
search -> search provider
process -> process provider
browser -> unavailable provider descriptor
desktop -> unavailable provider descriptor
```

Policy broker wraps the router.

- [ ] **Step 3: Implement JSONL framing**

Read stdin by line, reject malformed JSON with an error result when a request ID can be recovered, and never mix logs into stdout. Flush stdout after every response.

- [ ] **Step 4: Add concurrent request correlation test**

Send multiple requests rapidly. The protocol may return in completion order, but each result must carry the correct request ID and no response body may interleave at the byte level.

- [ ] **Step 5: Add `device.capabilities` and `device.status`**

Capabilities return the installed provider/operation inventory and explicitly mark browser/desktop unavailable. Status returns agent version, OS/arch, process uptime, and policy mode without leaking usernames, environment variables, or credentials.

- [ ] **Step 6: Run tests and commit**

```bash
cargo test -p tetherd
cargo build -p tetherd --release
git add agent/tetherd
git commit -m "feat(agent): add local capability runtime"
```

---

### Task 10: Build the TypeScript Agent Client

**Files:**
- Create: `adapters/compact-mcp/src/agent-client.ts`
- Create: `adapters/compact-mcp/test/agent-client.test.ts`
- Modify: `adapters/compact-mcp/package.json`

**Interfaces:**
- Consumes: generated `InvocationEnvelope`/`ResultEnvelope` protocol types.
- Produces:

```ts
export class AgentClient {
  static spawn(options: { tetherdPath: string }): Promise<AgentClient>;
  call(invocation: InvocationEnvelope): Promise<ResultEnvelope>;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write failing correlation tests with a fake JSONL child**

The fake child intentionally returns request B before request A. Assert `AgentClient.call(A)` resolves with A and `call(B)` resolves with B.

- [ ] **Step 2: Implement child spawning and line parser**

Use `execa` or Node child-process primitives. Maintain `Map<requestId, {resolve,reject}>`. Parse one JSON object per stdout line. Treat stderr as diagnostics, never protocol data.

- [ ] **Step 3: Add crash/disconnect tests**

If the child exits, reject all pending calls with a typed `disconnected` error and reject new calls until a new `AgentClient` is spawned.

- [ ] **Step 4: Validate results against protocol schema in test/debug mode**

Use Ajv so protocol drift is detected during development. Production compact mode may skip repeated validation once both sides are trusted local components.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @tetherplane/compact-mcp test -- agent-client
pnpm --filter @tetherplane/compact-mcp typecheck
git add adapters/compact-mcp
git commit -m "feat(adapter): add local agent client"
```

---

### Task 11: Expose Exactly Six Compact MCP Tools

**Files:**
- Create: `adapters/compact-mcp/src/compact-tools.ts`
- Create: `adapters/compact-mcp/src/translate.ts`
- Create: `adapters/compact-mcp/src/index.ts`
- Test: `adapters/compact-mcp/test/compact-tools.test.ts`
- Test: `adapters/compact-mcp/test/translate.test.ts`

**Interfaces:**
- Consumes: `AgentClient.call()`.
- Produces exactly these MCP tool names:

```text
device
files
process
browser
desktop
batch
```

Tool inputs always include `op`. Optional common fields include `response_mode`, `device`, and `idempotency_key` where relevant.

- [ ] **Step 1: Write a failing tool-list test**

Start the MCP server in-process and assert the sorted tool names equal exactly:

```ts
["batch", "browser", "desktop", "device", "files", "process"]
```

No seventh diagnostic/schema helper tool is allowed.

- [ ] **Step 2: Define small top-level schemas**

Each tool schema exposes only common fields plus `op`. Do not inline every operation-specific field into the default schema. Example:

```ts
{
  op: z.string(),
  args: z.record(z.unknown()).optional(),
  response_mode: z.enum(["compact", "normal", "debug"]).default("compact")
}
```

`device(op="schema", args={ namespace, operation })` is the schema-on-demand path, keeping the visible tool count at six.

- [ ] **Step 3: Write failing translation tests**

Required mappings:

```text
files op=read -> filesystem.read
files op=search -> search.start
files op=search_read -> search.read
process op=run -> process.run
device op=status -> device.status
browser any unsupported op -> browser.<op> then capability_unavailable from agent
desktop any unsupported op -> desktop.<op> then capability_unavailable from agent
```

- [ ] **Step 4: Implement translation and request envelope construction**

Generate UUID request IDs, default actor kind `ai_client`, pass session ID from MCP connection context, default `response_mode=compact`, and forward idempotency keys unchanged.

- [ ] **Step 5: Implement MCP result translation**

Compact success responses should serialize the smallest useful structured payload. Errors preserve machine-readable `code`, `message`, `recovery_hint`, and approval/policy metadata. Do not turn capability errors into vague generic MCP failures.

- [ ] **Step 6: Implement `device(op="capabilities")` and `device(op="schema")`**

Capabilities are queried from the agent. Schema requests read the operation schema catalog shipped with the adapter/protocol package and return only the requested operation definition.

- [ ] **Step 7: Run adapter tests and commit**

```bash
pnpm --filter @tetherplane/compact-mcp test
pnpm --filter @tetherplane/compact-mcp typecheck
git add adapters/compact-mcp
git commit -m "feat(mcp): expose six-tool compact interface"
```

---

### Task 12: Implement Server-Side Batch Execution

**Files:**
- Create: `agent/tether-core/src/batch.rs`
- Modify: `agent/tether-core/src/router.rs`
- Modify: `agent/tether-core/src/lib.rs`
- Test: `agent/tether-core/tests/batch.rs`
- Modify: `adapters/compact-mcp/src/translate.ts`
- Test: `adapters/compact-mcp/test/compact-tools.test.ts`

**Interfaces:**
- Consumes `batch.execute` with:

```json
{
  "mode": "parallel",
  "operations": [
    {"capability": "filesystem.read", "arguments": {"path": "..."}},
    {"capability": "filesystem.read", "arguments": {"path": "..."}}
  ]
}
```

or `mode="sequential"`. Each child operation is independently policy-checked by routing through the normal router path.

- [ ] **Step 1: Write failing parallel batch timing test**

Register two test providers that each sleep for the same bounded interval. Assert parallel mode completes materially faster than sequential mode without requiring exact millisecond equality.

- [ ] **Step 2: Write failing child-policy test**

One allowed child and one denied child must return separate child results; a denied child must never invoke its provider.

- [ ] **Step 3: Implement bounded parallel execution**

Use a semaphore to cap concurrency. Preserve input order in returned child result array even when execution completion order differs.

- [ ] **Step 4: Implement sequential stop policy**

Support `stop_on_error: true|false`, default `true` for sequential mode. Parallel mode always reports all started child results.

- [ ] **Step 5: Add Compact MCP batch mapping and run tests**

```bash
cargo test -p tether-core --test batch
pnpm --filter @tetherplane/compact-mcp test
git add agent/tether-core adapters/compact-mcp
git commit -m "feat(core): add bounded batch execution"
```

---

### Task 13: Add Local End-to-End MCP Conformance Tests

**Files:**
- Create: `tests/e2e/local-compact.test.ts`
- Create: `tests/e2e/helpers/start-local.ts`
- Modify: `tests/e2e/package.json`

**Interfaces:**
- Consumes: release/debug `tetherd` plus Compact MCP adapter.
- Produces: black-box proof that an MCP client can use the six-tool surface to perform real local work.

- [ ] **Step 1: Write an end-to-end test that starts both processes**

Create a temporary allowed root. Start `tetherd --stdio-rpc --allow <tempdir>` through the Compact MCP adapter and connect an MCP client over stdio.

- [ ] **Step 2: Assert exact six-tool discovery**

Fail if any tool is missing or any seventh tool is visible.

- [ ] **Step 3: Exercise a real file lifecycle**

Through MCP only:

```text
files.write -> files.read -> files.patch -> files.info -> files.move -> files.list
```

Assert every operation succeeds and that a path outside the allowed root returns `permission_denied`.

- [ ] **Step 4: Exercise progressive search**

Create multiple files, start a content search, read unseen results, then stop/list sessions. Assert duplicate results are not redelivered on the default cursor.

- [ ] **Step 5: Exercise a persistent process**

Start a command that emits output twice with a delay. Assert the first and second `process.read` calls deliver non-overlapping output and the session reaches a terminal state.

- [ ] **Step 6: Exercise batch**

Read at least three files in one `batch` call and assert ordered child results.

- [ ] **Step 7: Assert unavailable browser/desktop behavior is truthful**

`browser(op="capabilities")` and `desktop(op="capabilities")` must return structured unavailability/provider status, not success pretending actions can run.

- [ ] **Step 8: Run the end-to-end suite and commit**

```bash
cargo build -p tetherd
pnpm --filter @tetherplane/e2e test
git add tests/e2e
git commit -m "test: prove local compact MCP workflow"
```

---

### Task 14: Measure the First AI-Efficiency and Runtime Baseline

**Files:**
- Create: `scripts/bench-local.sh`
- Create: `scripts/bench-local.ps1`
- Create: `docs/benchmarks/local-core-baseline.md`
- Test: benchmark scripts themselves run without mutating user files outside a temporary directory

**Interfaces:**
- Consumes: completed local core.
- Produces measured baseline for startup time, idle RSS, tool count, typical result size, and MCP round trips for core workflows.

- [ ] **Step 1: Write benchmark scripts that use temporary state only**

Measure:

```text
tetherd cold start to first device.status response
idle RSS after 10 seconds
visible MCP tool count
bytes returned for a 1,000-line file in compact/normal/debug modes
round trips for one shell command
round trips for three-file inspection using batch
```

- [ ] **Step 2: Run benchmarks on the current development machine**

Record OS, CPU architecture, build profile, Rust version, Node version, and commit SHA. Do not claim the design targets are achieved if measurements miss them.

- [ ] **Step 3: Add regression assertions only for deterministic invariants**

Automated CI may assert six tools and bounded response sizes. Do not put machine-dependent RSS/startup thresholds into generic hosted CI until representative runners are controlled.

- [ ] **Step 4: Document measured baseline**

`docs/benchmarks/local-core-baseline.md` contains the actual numbers, test method, and known measurement limitations.

- [ ] **Step 5: Commit the baseline**

```bash
git add scripts docs/benchmarks
git commit -m "perf: record local core baseline"
```

---

### Task 15: Final Local-Core Verification Gate

**Files:**
- Modify only if verification exposes a defect in files owned by prior tasks.
- Evidence: test command outputs and clean Git status.

**Interfaces:**
- Produces the stable foundation consumed by Browser Coexistence Plan B.

- [ ] **Step 1: Run all Rust gates**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: PASS.

- [ ] **Step 2: Run all TypeScript gates**

```bash
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

Expected: PASS.

- [ ] **Step 3: Run local E2E from a clean temporary directory**

```bash
pnpm --filter @tetherplane/e2e test
```

Expected: PASS with exact six-tool assertion, path-denial assertion, file lifecycle, progressive search, persistent process, and batch coverage.

- [ ] **Step 4: Run dependency and unsafe-code checks**

```bash
cargo tree --workspace
rg -n "unsafe\s*\{" agent || true
```

Expected: dependency tree is reviewable; no project-authored unsafe blocks exist under `agent/` because workspace lint denies unsafe code.

- [ ] **Step 5: Confirm clean working tree and record the handoff SHA**

```bash
git status --short
git rev-parse HEAD
```

Expected: no uncommitted files. Record the SHA in the execution report before beginning Browser Coexistence Plan B.

## Plan Exit Criteria

This plan is complete only when all of the following are true:

- The local Rust kernel is the sole machine-capability executor.
- Local policy rejects unauthorized paths before providers execute.
- Filesystem, progressive search, persistent processes/REPL input, and bounded batch operations work through MCP.
- Exactly six tools are visible by default.
- Large output is bounded and resumable.
- Browser/desktop absence is represented honestly and structurally.
- The entire local E2E suite passes on Windows and Linux CI where supported by the provider behavior in this plan.
- Baseline runtime/model-efficiency measurements are documented as measurements, not marketing claims.
