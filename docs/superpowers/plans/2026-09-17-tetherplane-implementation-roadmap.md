# Tetherplane Implementation Roadmap

> **For agentic workers:** This roadmap sequences independently testable implementation plans. Each executable plan must use TDD, preserve the canonical design invariants, and end with a reviewable working increment.

**Goal:** Deliver Tetherplane v1 as a lightweight, self-hostable AI computer-control plane with a six-tool MCP surface, local-first execution, verified browser automation, Remote Desktop Commander compatibility, secure remote routing, Windows semantic desktop control, and hard human-coexistence guarantees.

**Architecture:** A Rust device agent owns the capability kernel, providers, policy enforcement, handles, and local authority. TypeScript owns the MCP edge, relay, browser extension/bridge, and compatibility adapters. External schemas translate into the canonical capability protocol rather than defining it.

**Tech Stack:** Rust, Tokio, Serde, TypeScript, Node.js, pnpm, current MCP TypeScript SDK, Chromium extension APIs/CDP, WebSocket/TLS, Windows UI Automation, Vitest, Cargo test, Playwright for fixture testing only.

**Spec:** `docs/superpowers/specs/2026-09-17-tetherplane-design.md`

## Delivery Order

### Plan A — Local Core and Compact MCP

File: `docs/superpowers/plans/2026-09-17-tetherplane-local-core-plan.md`

Produces a working local Tetherplane that exposes exactly six default MCP tools and can perform real filesystem, search, persistent-process, and batch work through the Rust kernel. This establishes the protocol, policy skeleton, handles, response budgets, JSONL local RPC, TypeScript MCP edge, and the first performance/conformance gate.

Exit proof:

- `device`, `files`, `process`, `browser`, `desktop`, and `batch` are the only default tools.
- Files/search/process operations execute through the Rust kernel.
- `browser` and `desktop` accurately report unavailable providers rather than fabricating capability.
- Allowed-directory policy is enforced locally.
- Persistent process handles produce incremental output.
- Batch executes safe independent operations concurrently.
- Local end-to-end MCP contract tests pass.

### Plan A.5 — Model-Neutral Principal and Job Control Plane

Spec: `docs/superpowers/specs/2026-09-19-tetherplane-model-neutral-control-plane.md`

Produces authenticated principal binding, scoped principal grants, durable job/checkpoint state, execution leases, audit lineage, and a generic non-MCP model-client proof without changing provider semantics or privileging any model vendor.

Exit proof:

- Caller-supplied model/controller identity cannot override the authenticated principal.
- The same controller under two principals receives different deterministic authorization.
- Two different controllers under one principal receive identical authorization.
- A sandboxed principal can discover capabilities, inspect/write only its granted root, and run only granted process operations.
- Job/checkpoint state survives controller replacement and can be read by a permitted second principal.
- An execution lease never expands capability authority.
- Audit lineage records the authenticated principal and canonical job/request IDs.
- A generic non-MCP model client can drive the same canonical protocol used by the MCP adapter.

### Plan B — Browser Coexistence Engine

Produces Tetherplane Bridge and the browser provider with extension-first authenticated-profile operation, CDP fallback, ownership, accessibility snapshots, semantic references, `browser.act`, semantic waits, uploads/downloads, checkpoints, verified actions, diagnostics, stale-reference reacquisition, and the synthetic SaaS fixture lab.

Exit proof:

- Background Tetherplane-owned tab automation does not activate or navigate a human-owned tab.
- Cursor, clipboard, active window, and active tab remain unchanged in `background_only` mode.
- Form actions are verified against resulting application state.
- SPA rerenders and stale references recover safely or fail as `stale_reference`.
- Async saves, validation failures, uploads/downloads, and two-tab edit conflicts are covered by fixtures.

### Plan C — RDC Compatibility

Produces an adapter that maps observed Remote Desktop Commander device/configuration/file/search/process behavior to the canonical kernel without leaking legacy semantics into providers.

Exit proof:

- Core device/file/search/process compatibility suite passes.
- Existing RDC-shaped workflows can migrate by changing the MCP endpoint rather than their high-level behavior.
- Unsupported or intentionally safer behavior is documented explicitly.

### Plan D — Remote Plane

Produces `tether-relay`, pairing, user/client/device identity, outbound authenticated WSS, Streamable HTTP MCP routing, revocation, reconnect semantics, idempotency protection, and self-host deployment.

Exit proof:

- A machine behind NAT accepts no inbound port yet can be controlled through a paired relay.
- The relay cannot override a local policy denial.
- Disconnect/reconnect does not duplicate non-idempotent actions.
- Cross-account and cross-device routing tests fail closed.
- Local mode continues to work with no relay.

### Plan E — Windows Semantic Desktop

Produces Windows UI Automation observation/action support, resource ownership, human-activity collision detection, private Tetherplane clipboard, and scoped foreground leases for physical fallbacks.

Exit proof:

- Semantic Invoke/Value/Selection actions do not move the physical cursor.
- Human-owned windows cannot be activated, moved, closed, or typed into without authorization.
- Foreground leases are resource-scoped, capability-scoped, expiring, and restoration-tested.
- Physical control is fallback-only.

### Plan F — Hardening and Public Release

Produces security/chaos suites, installers/service packaging, benchmark evidence, self-host documentation, contribution policy, license finalization, release automation, and public-facing compatibility/security documentation.

Exit proof:

- Threat-model fixtures cover prompt injection, path traversal, junction/symlink escape, approval forgery, secret redaction, replay, routing isolation, and foreground takeover.
- Sleep/wake, relay loss, browser restart, process survival, and client retry scenarios pass defined recovery behavior.
- Resource benchmarks are published as measured results rather than design targets.
- A clean machine can install, pair or run locally, and uninstall Tetherplane using documented steps.

## Cross-Plan Gates

Every plan inherits these non-negotiable design rules:

1. Local agent is the final policy authority.
2. `background_only` is the default coexistence mode.
3. Semantic control precedes physical control.
4. Human-owned resources are protected by default.
5. External communication, financial actions, destructive local actions, privileged system actions, and foreground-disruptive actions are policy-classified rather than inferred from prompt wording alone.
6. Compact responses are the default and continuation handles bound large output.
7. State-changing actions use idempotency where meaningful.
8. No hosted relay is required for local operation.
9. No Chromium binary is bundled merely to automate an already installed compatible browser.
10. Compatibility adapters never define canonical kernel interfaces.

## Execution Strategy

Execute one plan at a time. Do not start the next plan until the current plan's exit proof is green and its interfaces are stable enough for the next consumer. Keep commits small enough that each capability can be reviewed or reverted independently.
