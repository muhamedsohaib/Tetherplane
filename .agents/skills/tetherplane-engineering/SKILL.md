---
name: tetherplane-engineering
description: Engineering protocol for Tetherplane. Use whenever designing, implementing, debugging, reviewing, testing, or releasing any Tetherplane capability.
---

# Tetherplane Engineering

Tetherplane is an open-source control plane for AI-operated computers.

## Canonical repository

C:\Users\Sohaib\source\Tetherplane

Do not create another persistent working copy.

Before architectural or implementation decisions, read:

- docs/superpowers/specs/2026-09-17-tetherplane-design.md
- docs/superpowers/plans/2026-09-17-tetherplane-implementation-roadmap.md
- docs/superpowers/plans/2026-09-17-tetherplane-local-core-plan.md

Also inspect relevant newer plans before changing their subsystem.

## Architecture

Maintain separation between:

- Capability Kernel
- Providers
- Adapters
- Transport
- Policy Broker

Canonical capability semantics must remain provider-neutral.

The default AI-facing MCP interface exposes exactly six tools:

- device
- files
- process
- browser
- desktop
- batch

Do not expand this surface without an approved design change.

## Human coexistence

Default mode is background_only.

Human activity takes precedence.

Without explicit scoped authorization, never:

- steal focus
- move the physical cursor
- type using OS-level simulation
- overwrite clipboard
- change unrelated human tabs
- close human tabs
- move/minimize/maximize human windows
- terminate human-origin processes

Human browser tabs remain human-owned unless explicitly shared through the local approval interface.

## Browser contract

Prefer:

accessibility tree
→ DOM
→ screenshot
→ coordinates

Browser actions should be transactional:

observe
→ act
→ semantic wait
→ verify
→ return compact delta

Use stable semantic handles.

Do not hijack unrelated tabs.

## Security

Never expose:

- passwords
- cookies
- authorization headers
- access tokens
- refresh tokens
- browser bridge credentials
- device credentials
- GitHub tokens

Never run:

gh auth token

Do not place credentials into chat, source, logs, tests, fixtures, or Git history.

## Git

Use feature branches.

Before substantial work inspect:

git status
git branch --show-current
git log --oneline --decorate -10
git remote -v
git diff

Do not force-push main.

Do not rewrite published history.

Do not create a release tag without explicit human approval.

## Execution

Proceed autonomously through reversible engineering work.

When a failure occurs:

1. reproduce it
2. inspect evidence
3. identify root cause
4. write regression test
5. implement smallest justified fix
6. rerun targeted test
7. rerun broader gate

Do not paper over errors.

## Completion report

For substantial execution report:

- Completed
- Verification
- Git state
- Remaining work / blockers