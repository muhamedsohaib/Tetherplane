# Tetherplane exact Control Center: backend-only adapter (DRAFT)

This package wires **the owner's original exact HTML** to the existing account-scoped Tetherplane relay and six compact MCP tool families. It does **not** redesign, rebuild, or redistribute that HTML. The user-supplied HTML (SHA-256 `36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82`) is the immutable visual baseline; the external `tp-integration.js` is injected into served HTML at runtime, not written into the source file. The original ASCII glyphs, animation, themes, five-card layout and CSS must remain untouched.

**Distribution hold:** this public code branch deliberately excludes `public/index.html`. Redistribution of the original artwork requires a separate decision. The included `test/fixture.html` is ONLY a contract-test fixture; it is not the product visual.

## Install the exact owner-supplied frontend on Windows

Prerequisites: Node.js 22+ and the exact original `Tetherplane_Product_UI_Exact_Portal(1).html` from the user's approved archive. From this package directory:

```powershell
.\scripts\Install-ApprovedHtml.ps1 -SourceHtml 'C:\path\to\Tetherplane_Product_UI_Exact_Portal(1).html'
npm run verify:artwork
npm test
node .\server.mjs --relay-url 'https://YOUR-EXISTING-RELAY-HOST'
```

Use the existing authorized HTTPS relay origin, **not** `/mcp` or a public `:10000`. Open `http://127.0.0.1:8790`. Listener is 127.0.0.1 only; do not forward it through a tunnel, reverse proxy or public server. The installer refuses to replace a divergent HTML file and checks SHA-256 before and after copying. Nothing is installed on any device or production relay.

## Live integration surface

- Sign in using an **already-issued, account-scoped relay bearer credential**. Local 15-minute in-memory sessions use opaque HttpOnly SameSite=Strict cookies and same-origin CSRF checks. Do **not** extract ChatGPT tokens, paste secrets into the repository or register another OAuth client.
- `GET /devices`: account-scoped directory. Pairing is NOT health, presence or permission evidence; unknown transport is `not_reported`.
- `POST /pair/approve`: device-initiated hexadecimal `XXXX-XXXX` code plus owner confirmation; single-use and expiry enforced by existing relay.
- `POST /devices/:id/revoke`: explicit typed ID; account ownership is checked before forwarding; device-local policy unaffected.
- `POST /mcp`: the original six compact tool names only (`device`, `files`, `process`, `browser`, `desktop`, `batch`) via existing MCP negotiation. Local Policy Broker remains final authority, denies remain denials. The mini-console accepts `mcp device status Leno {}` (read-only). New MCP sessions are explicitly deleted after every call, including denials.
- Refreshed, expired, invalid and uncertain mutations fail closed; never automatically retry a pairing/revocation/command whose outcome is unknown.

## Tests and acceptance gates

`npm test` runs synthetic HTTP security, CSRF, relay pairing/revocation, session expiry and MCP lifecycle tests. When the real HTML is present, the suite also checks its exact byte-level SHA-256. When absent, CI uses `test/fixture.html` **only** to exercise server semantics and injection; it cannot certify visual fidelity. On a machine carrying the approved HTML, also run `npm run verify:artwork`, visual browser QA and actual read-only device acceptance.

This is not yet distribution-ready. **Blocked:** approved browser OAuth/PKCE client and scopes for an actual portal account, independently verified device access on Vaulter/Leno/Surface/RTX, external security review, and artwork rights. A compatible relay access credential is a prerequisite for live browser usage. Do not merge or deploy under these open gates.

This package is isolated from the existing `adapters/control-center` draft and does not modify protected identity, relay, Rust agent, Windows packaging or user worktrees.
