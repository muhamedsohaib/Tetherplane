# Tetherplane - Authenticated Browser Profile Mode Plan

Date: 2026-09-22
Branch: feature/authenticated-browser-profile

## Goal

Allow an explicitly authorized Chrome tab in the user's existing authenticated profile to be controlled through the existing browser extension backend without exporting cookies, passwords, authorization headers, or raw credentials. Isolated Tetherplane-owned browsing remains the default.

## Invariants

- background_only remains the default.
- Human tabs remain human unless explicitly attached by the local Chrome extension UI.
- AI clients cannot mint an attachment grant.
- Attachment is per-tab, operation-scoped, and expiring.
- Expired grants fail closed and revert the tab to human ownership.
- Close is denied unless the local grant explicitly includes close.
- Detach is always available to the human from the extension UI.
- Sensitive browser state never leaves the extension.
- Default MCP surface remains exactly six tools.

## Tasks

1. TDD scoped grant expiry in browser ownership and extension controller.
2. TDD a local extension approval message for share-current-tab and detach-current-tab.
3. Keep attach/detach off the AI-facing browser operation surface.
4. Add a short-lived loopback pairing broker so the extension can obtain its launch token locally without printing or copying the secret.
5. Build the extension and run browser/extension/e2e gates.
6. Install/load the extension in Leno Chrome with one explicit human step.
7. Run a visible Chrome proof: approve one authenticated tab, semantic action through Tetherplane, detach, verify unrelated tabs remain untouched.

## Verification

pnpm --filter @tetherplane/browser-bridge typecheck
pnpm --filter @tetherplane/browser-bridge test
pnpm --filter @tetherplane/browser-extension typecheck
pnpm --filter @tetherplane/browser-extension test
pnpm --filter @tetherplane/e2e test
pnpm -r build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
git diff --check
