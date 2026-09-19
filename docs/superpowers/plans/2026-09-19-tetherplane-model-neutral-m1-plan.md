# Tetherplane — Model-Neutral Control Plane Milestone 1 Plan

**Goal:** Prove that execution authority belongs to a Tetherplane principal rather than a model brand, then establish the durable state needed for model handoff.

**Spec:** `docs/superpowers/specs/2026-09-19-tetherplane-model-neutral-control-plane.md`

## Invariants

- The Rust local agent remains final policy authority.
- Provider semantics remain model/vendor-neutral.
- Existing six-tool MCP remains an adapter; no seventh default tool.
- Principal identity is transport-authenticated and cannot be self-asserted by model output.
- A lease never widens a principal's capability grant.
- No private chain-of-thought is persisted.
- First proof is sandboxed and reversible.
- No new inbound listener or firewall exposure is required for the first DeepSeek proof.

## Task M1A — Canonical principal context

Files:
- modify protocol invocation schema/generated types;
- modify `tether-core` envelope;
- add principal authorization types/policy tests;
- modify `tetherd` launch/runtime/stdio binding;
- modify Compact MCP translation only as needed.

TDD sequence:

1. Add a failing contract test that serializes/deserializes `principal_id`.
2. Add a failing test proving a caller-provided principal claim is overwritten by the launch-bound principal.
3. Add a failing test proving capability denial occurs before provider execution.
4. Add a failing test proving device mismatch is denied.
5. Add a failing test proving filesystem access remains constrained to the principal's roots.
6. Implement the minimum principal profile/grant model.
7. Preserve a compatibility principal for current local MCP/e2e tests.
8. Run full Rust/TypeScript/e2e gates.

Initial local principal profile shape:

```json
{
  "principal_id": "model:deepseek-engineer",
  "kind": "ai_client",
  "allowed_devices": ["Leno"],
  "allowed_capabilities": [
    "device.status",
    "device.capabilities",
    "filesystem.list",
    "filesystem.read",
    "filesystem.write",
    "process.run",
    "process.read"
  ],
  "allowed_roots": ["<isolated sandbox>"]
}
```

Exact capability grants only in M1A. No unrestricted wildcard.

## Task M1B — Durable job/checkpoint/lease state

Files:
- add `job_id` to canonical invocation;
- add local job state module/store;
- add canonical `job.*` kernel operations;
- add compact aliases under existing six-tool surface where needed;
- add deterministic job/lease tests.

Minimum job operations:

- `job.create`
- `job.get`
- `job.checkpoint`
- `job.acquire_lease`
- `job.release_lease`

Minimum persisted state:

- job ID;
- objective;
- target device;
- creator principal;
- permitted principals;
- explicit status;
- latest checkpoint;
- active execution lease;
- created/updated timestamps.

Lease M1:

- one scoped execution lease per job;
- lease ID;
- principal ID;
- expiry;
- explicit release;
- no authority escalation.

Tests:

1. principal without job access cannot read job;
2. permitted second principal can read checkpoint after first releases lease;
3. second principal cannot acquire while live lease is held;
4. expired/released lease can be reacquired;
5. acquiring lease does not permit a capability absent from principal grants.

## Task M1C — Append-only audit lineage

Files:
- add local audit writer/store;
- thread principal/job context through runtime result recording;
- add bounded audit read operation for authorized principals.

Minimum audit record:

- event ID;
- timestamp;
- authenticated principal ID;
- actor/controller metadata;
- job ID;
- request ID;
- device;
- capability;
- result/error code;
- verification state.

Tests:

- audit principal comes from bound principal, not caller claim;
- no full arguments or raw secrets are written by default;
- job request lineage is queryable deterministically.

## Task M1D — Generic non-MCP intelligence client

Location: adapter/SDK layer outside kernel.

The client:

- accepts an OpenAI-compatible endpoint/model through configuration;
- contains no DeepSeek-specific execution semantics;
- asks the model for structured next action;
- validates that action against a small schema;
- submits canonical Tetherplane invocations;
- returns structured results to the model;
- cannot grant itself capabilities.

The first version may run on Leno and connect outbound to an existing RTX model endpoint. It must not open an inbound Leno control port.

## Task M1E — DeepSeek sandbox proof

Principal: `model:deepseek-engineer`.

Allowed:
- device status/capabilities;
- read/list/write inside one temporary proof root;
- harmless process run/read;
- required job/checkpoint/lease/audit operations.

Denied:
- arbitrary filesystem roots;
- filesystem delete;
- process terminate;
- browser/desktop mutation;
- credentials;
- external communication;
- production mutation.

Proof:

1. create isolated root;
2. authenticate/bind principal;
3. create job;
4. acquire lease;
5. discover capabilities;
6. inspect root;
7. run harmless command;
8. create/read artifact;
9. checkpoint;
10. verify audit lineage;
11. release lease;
12. reconnect with a second permitted principal and read the same job/checkpoint.

## Task M1F — Controller-independence and Contrarian tests

Deterministic tests:

- controller label A and B under one principal -> same authorization;
- same controller label under high- and low-authority principals -> different authorization;
- `model:arcus-contrarian` read-only profile can inspect but cannot write/run;
- prompt/body fields claiming approval or another principal have no effect.

## Verification gate

Before every commit:

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm -r typecheck
pnpm -r test
pnpm -r build
pnpm --filter @tetherplane/e2e test
git diff --check
```

No milestone is complete until the relevant black-box proof passes on Leno.
