# Tetherplane Project Rule

This rule applies to all work in this repository.

## Source of truth

The canonical repository is:

C:\Users\Sohaib\source\Tetherplane

GitHub and this repository are authoritative.

Do not treat temporary directories, generated sandboxes, copied repositories, or previous conversation claims as source of truth when the repository can be inspected.

Before architectural or implementation decisions, read:

- docs/superpowers/specs/2026-09-17-tetherplane-design.md
- docs/superpowers/plans/2026-09-17-tetherplane-implementation-roadmap.md
- docs/superpowers/plans/2026-09-17-tetherplane-local-core-plan.md

Inspect newer subsystem plans when relevant.

## Development method

For multi-step work:

- write/use a plan
- strict TDD
- systematic root-cause debugging
- verification before completion

Feature/defect cycle:

failing test
→ verify intended failure
→ minimum implementation
→ targeted pass
→ broader pass
→ refactor while green
→ repository gates

Never claim success solely from code changes.

## Architecture

Preserve strict separation of:

- Capability Kernel
- Providers
- Adapters
- Transport
- Policy Broker

Canonical internals are provider-neutral.

Default AI-facing MCP exposes exactly:

- device
- files
- process
- browser
- desktop
- batch

## Model efficiency

Prefer:

- semantic operations over screenshots
- accessibility tree before DOM
- DOM before screenshots
- screenshots before coordinates
- one inspect + batched action where safe
- compact deltas
- stable handles
- incremental output
- server-side batching
- automatic capability discovery

Avoid dumping large terminal output, DOM, or screenshots unless necessary.

## Human coexistence

Default:

background_only

Human activity takes precedence.

Without explicit foreground/shared authorization do not:

- steal keyboard focus
- move cursor
- simulate OS keyboard input
- overwrite clipboard
- change active human tab
- navigate unrelated human tabs
- close human tabs
- move/minimize/maximize human windows
- terminate human-origin processes

Conflicting concurrent modification should fail with resource_conflict.

## Browser

Browser actions should be verified:

observe
→ act
→ semantic wait
→ verify
→ return delta

Human tabs remain human unless explicitly locally shared.

Authenticated-profile access must be tab-scoped, operation-scoped, expiring and revocable.

Do not expose credentials from authenticated Chrome.

## Policy

The local Tetherplane agent is final authority.

Policy outcomes:

ALLOW
DENY
REQUIRE_APPROVAL

Stricter local policy cannot be overridden by cloud relay or AI client policy.

## Security

Never expose or print secrets.

Never run:

gh auth token

Never put credentials in:

- terminal output
- chat
- logs
- source code
- tests
- fixtures
- Git history

## External effects

Do not send communications, make purchases, perform financial actions, or publish releases without explicit human approval.

## Git

Use feature branches.

Do not force-push main.

Do not silently rewrite published history.

Before commit obtain fresh verification.

Push only verified branches.

Do not create or push release tags without explicit approval.

## Current release posture

Tetherplane is NOT release-ready merely because remote files/process operations work.

Release readiness requires fresh proof of all applicable planes, including browser integration, persistence, policy and coexistence.

## Completion

For substantial work report:

- Completed
- Verification
- Git state
- Remaining work / blockers