# Tetherplane Windows Semantic Desktop Implementation Plan

**Goal:** Deliver Plan E: Windows semantic desktop observation/action through UI Automation, trusted resource ownership, human-activity collision avoidance, a private Tetherplane clipboard, and scoped expiring foreground leases for physical fallback.

**Canonical sources:** `2026-09-17-tetherplane-design.md`, `2026-09-17-tetherplane-implementation-roadmap.md`, and the model-neutral control-plane addendum.

## Hard boundaries

- `background_only` remains the default.
- Semantic UI Automation is preferred over mouse, keyboard, focus, coordinates, or global clipboard.
- Human-owned windows are observe-only by default.
- A caller cannot self-declare a human window as Tetherplane-owned.
- Desktop ownership derives from trusted local state such as Tetherplane-spawned process IDs or an explicit locally authorized sharing record.
- Semantic actions do not move the physical cursor and do not use OS-level keystroke simulation.
- Physical fallback requires a resource-scoped, capability-scoped, expiring foreground lease.
- Human activity blocks conflicting foreground work.
- Global clipboard access is not used by semantic operations; Tetherplane has a private internal clipboard.
- Local policy remains final authority.
- No authored unsafe Rust is introduced. The workspace `unsafe_code = deny` gate remains green.
- Default Compact MCP remains exactly six tools.

## E1 — Trusted ownership registry

Extend `tether-core` with a thread-safe local resource ownership registry.

Initial trusted resource keys:

- process ID;
- desktop window identity;
- desktop semantic resource identity.

Process ownership is registered by the process provider after Tetherplane successfully spawns a process. The registry is injected by `tetherd` and shared with the process and desktop providers.

Caller-supplied `origin` remains compatibility metadata only and must not grant desktop mutation authority.

Tests must prove:

- Tetherplane-spawned process IDs are registered locally;
- unknown/system process IDs are not treated as owned;
- caller-supplied origin cannot convert an unknown resource into owned authority;
- ownership survives only for the intended local runtime scope.

## E2 — Provider-neutral desktop semantic contract

Add `agent/providers/desktop` with a backend trait independent of Windows.

Canonical initial operations:

- `desktop.snapshot`
- `desktop.act`
- `desktop.private_clipboard_get`
- `desktop.private_clipboard_set`
- `desktop.foreground_lease_acquire`
- `desktop.foreground_lease_release`
- `desktop.foreground_lease_get`

Snapshot returns a bounded semantic tree/delta with opaque stable references and trusted ownership metadata.

Supported semantic actions:

- `invoke`
- `set_value`
- `select`
- `toggle`
- `expand`
- `collapse`

Window activation/move/resize/close are not part of the background semantic action set.

Provider tests use a deterministic fake backend first.

Required provider behavior:

- observe human and Tetherplane resources;
- mutate Tetherplane-owned resources semantically;
- deny mutation of human/unknown resources in background mode;
- verify the semantic post-state where the backend can report it;
- return `stale_reference` if a target cannot be safely reacquired;
- bound snapshots and report truncation.

## E3 — Windows UI Automation backend

Use a safe UI Automation wrapper on Windows. Build it with default features disabled and only semantic UIA pattern/control support enabled for this task.

Run UI Automation on a dedicated worker thread because COM UIA objects are thread-affine / not generally Send + Sync.

The worker owns:

- UIAutomation instance;
- tree walker;
- opaque reference cache;
- semantic reacquisition metadata.

Observation should capture bounded fields such as:

- role/control type;
- accessible name;
- automation ID;
- class name;
- process ID;
- enabled/focusable/focused state;
- bounding rectangle when available;
- supported semantic patterns;
- trusted origin;
- child relationships.

Do not expose raw COM pointers or unrestricted native handles to the AI.

Semantic action maps only to UIA patterns:

- InvokePattern.invoke
- ValuePattern.set_value
- SelectionItemPattern.select
- TogglePattern.toggle
- ExpandCollapsePattern expand/collapse

No physical input API may be called from these operations.

## E4 — Human activity collision detection

Add a local human-activity abstraction with a Windows implementation.

Track only bounded local collision-avoidance state:

- latest user input timestamp;
- active foreground window identity / change time.

Do not stream raw activity events or keystrokes.

Foreground-required action fails/defer as `human_activity_conflict` while the human is active inside the configured quiet interval.

Semantic background actions remain allowed when they do not require foreground disruption and target an authorized resource.

## E5 — Private Tetherplane clipboard

Implement an in-process private clipboard object supporting bounded:

- text;
- file path references;
- image/artifact references where available later.

Initial Plan E implementation must at least support text and file references without touching the Windows global clipboard.

Semantic Value actions may consume private clipboard text explicitly without copying it into the system clipboard.

Tests verify the Windows/global clipboard remains unchanged during private clipboard and semantic operations.

## E6 — Foreground leases and physical fallback boundary

Implement a local ForegroundLease store.

A lease contains:

- opaque lease ID;
- principal/actor lineage;
- target resource;
- permitted physical capability set;
- issued/expiry time;
- reason;
- restoration requirements;
- baseline foreground state where needed.

Rules:

- lease acquisition does not expand principal capability grants;
- lease is resource-scoped;
- capability outside lease scope fails;
- expired lease fails;
- human activity can suspend/block use;
- lease release/expiry triggers restoration bookkeeping;
- physical executor cannot be called without a valid lease.

Initial physical executor supports only the smallest fallback primitives required for deterministic proof. Semantic operations must never call it.

## E7 — Windows coexistence fixture and black-box proof

Use a deterministic Windows fixture application/process launched by Tetherplane, plus a separate human/external window.

Prove through real Compact MCP -> tetherd -> desktop provider:

1. desktop provider is truthfully available on Windows;
2. semantic snapshot finds the owned fixture;
3. Invoke/Value/Selection actions succeed without moving the physical cursor;
4. global clipboard remains unchanged;
5. active human window remains unchanged during background semantic work;
6. mutation of a human/external window is denied;
7. caller-supplied origin cannot bypass ownership;
8. stale reference fails safely or reacquires semantically;
9. private clipboard never overwrites the global clipboard;
10. physical fallback without foreground lease fails;
11. lease scope/expiry is enforced;
12. human activity blocks conflicting physical fallback;
13. restoration state is checked after lease release/expiry.

## E8 — Compact MCP and remote continuity

Expose the new desktop operations through the existing `desktop` compact tool and schema-on-demand.

Do not add a seventh default MCP tool.

Prove desktop calls work locally. Remote routing should require no desktop-specific relay changes because remote transport routes canonical capabilities.

## E9 — Final Plan E gate

Run:

- Rust fmt;
- Clippy with warnings denied;
- full Rust workspace tests;
- all TypeScript typechecks/tests/builds;
- complete E2E suite;
- desktop coexistence black-box tests;
- authored unsafe scan;
- Compact MCP six-tool assertion;
- git diff hygiene.

Plan E is complete only when semantic UIA actions are proven non-disruptive, human-owned windows remain protected, foreground lease rules are deterministic, and the entire existing A-D suite remains green.
