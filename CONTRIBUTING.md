# Contributing to Tetherplane

## Development contract

For multi-step changes, write or update a plan first. Implementation follows strict TDD:

1. write a failing test;
2. verify the failure is for the intended missing behavior;
3. implement the minimum behavior;
4. verify the focused test passes;
5. refactor only while green;
6. run repository gates before claiming completion.

## Architecture boundaries

Keep Capability Kernel, Providers, Adapters, Transport, and Policy Broker separate.

Canonical capability semantics must remain provider-neutral. Compatibility naming stays in adapters.

The default Compact MCP interface remains exactly six tools: device, files, process, browser, desktop, and batch.

## Human coexistence

Human use takes precedence. Background automation must not steal focus, move the physical cursor, overwrite the system clipboard, or mutate human-owned browser/desktop resources. Physical desktop fallback requires the ForegroundLease boundary.

## Security

Never commit credentials, tokens, cookies, private keys, or real customer secrets. Do not add tests that print secrets. Prefer credential files/environment references and existing authenticated mechanisms.

Auth, policy, ownership, idempotency, routing, and foreground-control changes require explicit negative tests.

## Verification

Before a release candidate, run:

    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings
    cargo test --workspace
    pnpm -r typecheck
    pnpm -r test
    pnpm -r build

On Windows also run tests/release/windows-package-smoke.ps1.

## Pull requests

Keep commits focused on one plan task when practical. Describe the invariant being changed, the failing test that motivated it, and fresh verification evidence. Do not hide known benchmark misses or unsupported platform claims.
