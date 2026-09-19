# Tetherplane — Model-Neutral Control Plane Addendum

**Status:** Active architecture requirement
**Date:** 2026-09-19
**Extends:** `2026-09-17-tetherplane-design.md`

## 1. Corrected system boundary

Tetherplane is not a system in which ChatGPT controls a computer. Tetherplane is a deterministic control plane that accepts authenticated intentions from replaceable intelligence clients and executes them through one canonical capability protocol.

The intelligence source is never the execution authority. A controller may be a cloud model, local model, human-operated client, deterministic program, or higher-level agent framework. Tetherplane owns validation, authorization, execution, state, leases, idempotency, audit, recovery, and machine coexistence.

MCP remains an important adapter. It is not the canonical execution model.

## 2. Current architecture assessment

### 2.1 Already model-neutral

The current implementation already has the right core boundaries:

- `tether-core` defines provider-neutral invocation/result envelopes and capability routing.
- Providers implement filesystem, search, and process semantics without model-vendor concepts.
- The Rust local agent is the final policy authority.
- External MCP schemas translate into the canonical invocation envelope.
- Local JSONL RPC between the adapter and `tetherd` is independent of MCP semantics.
- Capability names, device IDs, response budgets, handles, preconditions, expectations, and idempotency keys are model-independent.
- Compact MCP exposes only six AI-visible tools while preserving canonical internal namespaces.
- Browser/desktop absence is represented truthfully instead of fabricated by the adapter.
- Batch child operations cross the same local policy path as ordinary operations.

### 2.2 Still too weak for multi-controller authority

The current implementation has these gaps:

1. `actor.id` is supplied by the caller and therefore cannot be treated as authenticated authority.
2. The Compact MCP adapter hardcodes `actor.id = "compact-mcp"`, erasing the actual controlling principal.
3. Allowed filesystem roots are runtime-global rather than principal-scoped.
4. There is no principal registry with capability/device/resource grants.
5. The existing `idempotency_key` is transported but not enforced.
6. There is no durable canonical job record, checkpoint store, handoff state, or controller lease.
7. There is no append-only audit lineage joining principal, job, request, policy decision, and result.
8. There is no event subscription surface for job/process/state transitions.
9. Local JSONL is transport-capable but has no authenticated connection binding.
10. MCP is currently the only finished external intelligence-facing adapter even though the kernel itself is not MCP-dependent.

These are extension points, not reasons to replace the verified kernel.

## 3. Principal identity

Authority belongs to an authenticated principal, never to a model-family string.

A principal record contains:

- stable `principal_id`;
- principal kind;
- authentication binding;
- allowed devices;
- allowed canonical capabilities;
- resource constraints such as filesystem roots;
- approval requirements inherited by local policy;
- optional handoff peers;
- audit metadata.

Examples are descriptive identifiers only:

- `human:sohaib`
- `model:deepseek-engineer`
- `model:qwen-general`
- `model:arcus-contrarian`
- `service:project-zero`

A model name must never grant authority. The same model may be bound to multiple principals with different grants.

### 3.1 Actor versus principal migration

Protocol v1 already has `actor`. Preserve it for controller/provenance compatibility, but stop using it as the security identity.

Add a canonical `principal_id` field to authenticated invocations. Trusted transports inject or overwrite this field from connection authentication. Policy evaluates `principal_id`, not a model claim in request arguments or prompt text.

`actor` answers “what client/controller submitted this?”
`principal_id` answers “whose authority is this request executing under?”

## 4. Canonical execution contract

Continue using `InvocationEnvelope` rather than creating vendor-specific execute functions.

The next compatible extension is conceptually:

```text
protocol_version
request_id
principal_id
device_id
job_id
capability
arguments
actor
session_id
response_mode
idempotency_key
preconditions
expectations
```

`principal_id` and `job_id` are orthogonal:

- principal identity controls authority;
- job identity controls durable work state and handoff lineage.

Adapters translate external forms into this contract. Providers never receive model-vendor APIs.

## 5. Adapter architecture

Canonical internal execution remains Rust capability routing.

Supported edges evolve independently:

- Compact MCP;
- future Streamable HTTP MCP;
- canonical authenticated REST/JSON;
- generic JSONL/local client;
- Python SDK;
- TypeScript SDK;
- OpenAI-compatible function/tool adapter;
- compatibility adapters.

A local-model integration may run an intelligence gateway process that talks to an OpenAI-compatible model endpoint and then submits canonical Tetherplane invocations. The gateway is not part of the execution kernel and cannot grant itself more authority.

## 6. Capability authorization

Principal authorization is evaluated before ordinary side-effect policy.

The effective decision is the intersection of:

1. authenticated principal grants;
2. target device scope;
3. capability scope;
4. resource/path constraints;
5. ownership/coexistence policy;
6. side-effect/approval policy;
7. lease requirements;
8. operation preconditions.

A principal grant can narrow authority but never widen the local device policy.

Exact canonical capabilities are preferred in the first milestone. Wildcards, if later supported, must be constrained namespace patterns and covered by denial tests.

## 7. Jobs, checkpoints, and handoff

Tetherplane owns durable job state. A job record contains observable execution state only:

- job ID and objective;
- target device;
- creator principal;
- permitted handoff principals;
- status/current explicit step;
- artifact references;
- checkpoint payloads;
- request/result lineage;
- lease state;
- last structured error;
- timestamps.

Do not store model chain-of-thought or hidden reasoning.

A controller may checkpoint and release its lease. Another authenticated principal with job access may acquire the lease and continue from canonical state.

## 8. Control leases

Foreground leases remain a separate human-coexistence mechanism.

Model-neutral control introduces job/resource leases for concurrency. Long-term lease modes:

- read;
- write;
- interactive;
- exclusive execution.

The first implementation milestone needs only a scoped expiring execution lease attached to a job. It must record principal, lease ID, expiry, and release state. A principal cannot mint a lease for a job it cannot access.

## 9. Idempotency

The existing `idempotency_key` becomes enforceable for mutation-capable operations.

Idempotency storage is keyed by at least:

- principal ID;
- device ID;
- canonical capability;
- idempotency key.

A retry with the same key and equivalent request returns the prior result. A conflicting request reusing the key fails rather than silently executing a different mutation.

Implementation should start at the local agent, then remain valid through future relay reconnects.

## 10. Audit and events

Audit is append-only and machine-readable. Minimum lineage:

- audit event ID;
- timestamp;
- principal ID;
- controller/actor metadata;
- job ID when present;
- request ID;
- target device;
- capability;
- policy decision;
- result status/error code;
- verification state.

Do not log secrets or unbounded payloads.

Job events derive from explicit state transitions such as:

- job created;
- lease acquired/released/expired;
- checkpoint created;
- request completed/failed;
- job blocked/completed/cancelled.

The first milestone may expose polling/read APIs. SSE/WebSocket event streaming follows once the canonical event contract is stable.

## 11. Authentication

Authentication is transport-specific; principal identity is not.

First local proof uses a trusted local launch binding:

- owner supplies a principal profile to `tetherd`;
- the OS process boundary is the authentication mechanism;
- `tetherd` injects the bound principal into every invocation;
- caller-supplied principal claims cannot override it.

Future remote transports bind the same principal abstraction through OAuth/OIDC, mTLS/device credentials, signed service tokens, or other reviewed mechanisms.

No API token or model brand is embedded into capability semantics.

## 12. Security boundary

An abliterated or prompt-injected model cannot escalate itself because:

- model output is untrusted input;
- the transport binds the principal;
- principal grants are owner-controlled local configuration;
- policy runs locally before providers;
- filesystem paths are canonicalized against granted roots;
- disallowed capabilities fail before provider execution;
- approvals are opaque external authority, not model assertions;
- job leases do not expand capability grants;
- secrets are never granted merely because a model asks;
- audit lineage records the authenticated principal, not a prompt claim.

A low-authority Contrarian principal can therefore inspect allowed state while being structurally unable to write files, execute processes, communicate externally, or obtain credentials.

## 13. Minimal migration plan

### Milestone M1A — authenticated local principal boundary

- add `principal_id` to the canonical invocation contract;
- add local principal profiles and exact capability/device/path grants;
- bind one principal at `tetherd` launch;
- ensure caller claims cannot override the bound principal;
- enforce principal grants before providers;
- preserve all existing local-core behavior under a default compatibility principal.

### Milestone M1B — durable jobs, lease, checkpoint, audit

- add `job_id` to invocation context;
- add local durable job store;
- add job execution lease acquire/release;
- add checkpoint and job read operations;
- append bounded audit lineage;
- prove two principals can inspect the same canonical job state without sharing a chat transcript.

### Milestone M1C — generic non-MCP model client

- add a small generic OpenAI-compatible intelligence client outside the kernel;
- configure endpoint/model externally;
- authenticate it as a dedicated principal;
- use only canonical Tetherplane operations.

### Milestone M1D — first local-model proof

Use `model:deepseek-engineer` against an isolated sandbox on Leno:

1. authenticate through the launch-bound principal profile;
2. create a job and acquire its execution lease;
3. discover granted capabilities;
4. list/read sandbox state;
5. run a harmless command;
6. create and read a sandbox artifact;
7. checkpoint;
8. verify audit lineage;
9. release lease;
10. reconnect using a second principal and inspect the same job record.

No unrestricted machine access is granted.

### Milestone M1E — low-authority Contrarian proof

Bind `model:arcus-contrarian` to read/inspect-only grants and deterministically prove write/process-execute attempts are denied before providers run.

## 14. Deterministic contract tests

Required tests separate intelligence identity from authority:

1. Two different controller names bound to the same principal receive identical authorization.
2. The same model/controller name bound to two different principals receives different authorization.
3. Caller-supplied `principal_id` cannot override the transport-bound principal.
4. A principal denied `process.run` never reaches the process provider.
5. A filesystem grant is confined to configured canonical roots.
6. Principal device scope rejects a different target device.
7. A low-authority principal cannot acquire authority through a job lease.
8. An idempotent retry does not re-execute the underlying mutation.
9. Reusing an idempotency key for a different mutation fails.
10. Job checkpoint/handoff state contains explicit observable state but no private reasoning field.
11. A second permitted principal can read the same checkpoint after the first releases its lease.
12. Audit lineage records the authenticated principal regardless of controller/model label.

## 15. First proof architecture

The preferred DeepSeek proof does not require opening an inbound control port on Leno.

```text
DeepSeek V4 endpoint on RTX
        |
        | OpenAI-compatible inference API
        v
generic Tetherplane model client on Leno
        |
        | canonical local invocation protocol
        v
tetherd bound to model:deepseek-engineer
        |
        v
principal authorization -> policy -> capability router -> providers
        |
        v
isolated Leno sandbox
```

This proves model independence without making the model the execution system and without exposing Leno to a new unauthenticated network listener.

The generic model client is configuration-driven. Replacing DeepSeek with Qwen, Claude, Gemini, or another compatible intelligence does not modify `tether-core`.

## 16. Non-goals

This work does not turn Tetherplane into an agent framework or model router.

Tetherplane does not own prompts, planning algorithms, hidden reasoning, model selection, or autonomous-agent personalities. It remains the deterministic execution/control substrate beneath those systems.
