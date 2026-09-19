# Tetherplane — Browser Coexistence Engine Implementation Plan

**Goal:** Deliver Plan B as a first-class browser capability that operates semantic browser state in the background without hijacking human-owned tabs, while keeping the Rust local agent as final policy authority.

**Spec:** `docs/superpowers/specs/2026-09-17-tetherplane-design.md`

## Architecture

The browser system has four layers:

1. **Canonical kernel surface** — `browser.*` capabilities remain provider-neutral.
2. **Rust browser provider proxy** — registered in `tetherd`; local policy/ownership checks happen before the bridge.
3. **TypeScript Tetherplane Browser Bridge** — owns semantic snapshots, stable references, verified actions, waits, checkpoints, diagnostics, extension/CDP backend selection, and bounded deltas.
4. **Browser backends** — preferred authenticated extension connection, then direct CDP to a Tetherplane-owned context/profile.

The bridge is not an authority boundary. It cannot widen local policy or convert human-owned resources into Tetherplane-owned resources by model assertion.

## Invariants

- `background_only` is the default.
- No browser operation may activate a human-owned tab in background mode.
- Human-owned tabs are observe-only unless an explicit scoped attachment exists.
- Tetherplane-owned tabs may be navigated/edited/closed.
- Extension-local authenticated state stays in the browser; cookies/tokens/authorization headers are never returned by default.
- Accessibility/semantic observation precedes DOM details; screenshots are supplemental.
- Coordinates, OS keyboard/mouse, file pickers, and global clipboard are not part of ordinary browser execution.
- Stable references are semantic identities, not raw DOM node IDs.
- Ambiguous stale-reference reacquisition fails as `stale_reference`.
- State-changing browser actions are idempotent where meaningful and verified against resulting application state.
- A bridge crash/restart must not silently replay a state-changing action.
- The default MCP surface remains exactly six tools.

## Task B1 — Browser contract, ownership model, and fixture lab

Create:

- `browser/bridge` TypeScript workspace package.
- `fixtures/browser-lab` synthetic SaaS fixture.
- canonical browser operation/action/result TypeScript types.
- ownership types: `human`, `tetherplane`, `shared-observe`, `shared-authorized`.
- semantic reference type with role, accessible name, ancestry, document/frame identity, snapshot revision.
- fixture routes/state for SPA rerender, validation, async save, nested frame, upload/download, conflict, slow/failing request.

TDD:

1. Human tab navigation/close denied in background mode.
2. Tetherplane-owned tab navigation permitted.
3. Shared-observe tab mutation denied.
4. Shared-authorized mutation allowed only for its explicit grant.
5. Fixture app deterministically exposes revision/state endpoints for verification.

## Task B2 — Semantic snapshot and stable-reference engine

Bridge operations:

- `browser.status`
- `browser.pages`
- `browser.snapshot`

Snapshot returns bounded semantic nodes with stable references and revision.

TDD:

1. Snapshot excludes secrets/hidden sensitive attributes by default.
2. Stable refs survive non-ambiguous SPA rerender.
3. Ambiguous reacquisition returns `stale_reference`.
4. Frames/document identity are part of ref matching.
5. Snapshot response is bounded and delta-friendly.

## Task B3 — Semantic actions, waits, and verification

Bridge operations:

- `browser.act`
- `browser.wait`

Action primitives initially:

- click/invoke;
- fill/set value;
- select;
- check/uncheck;
- focus semantic element only inside Tetherplane-owned/shared-authorized page;
- navigate owned page.

Verified action contract:

`observe → validate preconditions → act → semantic wait → verify expectations → return delta`

Expectations:

- URL;
- text;
- value;
- enabled/disabled;
- validation presence/absence;
- toast/alert;
- revision change;
- selected network success where backend supplies it.

TDD:

- async saves do not return verified before persistence;
- validation failures return machine-readable failure;
- SPA rerender reacquires target semantically;
- conflicting resource revision returns `resource_conflict`;
- unsupported/ambiguous refs fail without arbitrary action.

## Task B4 — Tetherplane Bridge extension backend

Create MV3 extension under `extension/browser`.

Extension requirements:

- connects outbound to localhost bridge using an ephemeral launch token;
- never exports cookies, authorization headers, saved passwords, or raw browser credentials;
- creates Tetherplane-owned background tabs with `active: false`;
- reports tab lifecycle/ownership;
- observes accessibility/DOM semantics needed by bridge;
- performs semantic tab-local actions;
- supports scoped attach/detach of human tabs;
- reconnects safely after service-worker suspension.

TDD/integration:

- background tab creation leaves active human tab unchanged;
- navigation of owned background tab leaves active human tab unchanged;
- human tab close/navigation rejected by ownership gate;
- reconnect preserves owned-tab identity where browser IDs still exist.

## Task B5 — CDP fallback

Add CDP backend for a Tetherplane-owned Chromium context/profile.

Rules:

- use installed compatible Chromium executable; do not bundle Chromium;
- never attach CDP to an unrelated human-owned tab/profile without explicit authorization;
- backend advertises reduced/actual capabilities truthfully;
- semantic snapshot/action contracts match extension backend.

Fixture tests run against CDP backend using the synthetic browser lab.

## Task B6 — Uploads, downloads, diagnostics, checkpoints

Operations:

- `browser.upload`
- `browser.downloads`
- `browser.diagnostics`
- `browser.checkpoint`

Requirements:

- native file-input upload; no foreground file picker;
- downloads get stable handles and local paths;
- console/network diagnostics are bounded/redacted;
- checkpoints capture URL/page identity, ownership, semantic/resource revision, pending download/form state without cookies/tokens;
- two-tab edit conflict detects revision mismatch.

## Task B7 — Rust browser provider proxy and local-agent integration

Create `agent/providers/browser`.

The Rust provider:

- launches/connects to configured local TypeScript bridge;
- translates canonical `browser.*` invocations to bridge RPC;
- preserves request IDs, principal/job context, idempotency keys, and structured errors;
- registers as available only when bridge handshake succeeds;
- reports unavailable truthfully otherwise;
- never grants ownership based on request arguments alone.

Add `tetherd` launch configuration for bridge path/profile/backend without changing default local-core behavior when browser is absent.

Compact MCP continues mapping `browser(op=...)` to canonical `browser.<op>`.

## Task B8 — Browser coexistence black-box proof

Run against the synthetic SaaS fixture and an installed Chromium-family browser.

Proof sequence:

1. Open one human-marked fixture tab and keep it active.
2. Create a Tetherplane-owned background tab.
3. Snapshot owned page semantically.
4. Fill and save an async form using stable refs.
5. Verify persisted server state.
6. Trigger SPA rerender and repeat action through semantic reacquisition.
7. Exercise validation failure.
8. Upload a fixture file without a file-picker dialog.
9. Track a download to a stable handle/path.
10. Create a checkpoint; mutate resource from second tab; verify conflict.
11. Attempt navigate/close of human tab and receive denial.
12. Assert active tab remains the original human tab throughout background operations.
13. Assert no global clipboard or physical input mechanism was used.

## Task B9 — Recovery, redaction, and performance gate

- bridge restart and reconnect;
- browser tab loss;
- browser restart;
- stale ref ambiguity;
- duplicate verified-action retry with idempotency key;
- diagnostics redaction fixtures;
- response budgets;
- measure ordinary semantic operation round trips.

## Verification gate

Before each Plan B commit:

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

Plan B is complete only when the browser coexistence black-box proof passes without activating, navigating, or closing the human-owned tab.
