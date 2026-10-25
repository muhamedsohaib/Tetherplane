# Tetherplane exact Control Center — Device Authority candidate

**Status (2026-10-25): isolated, unmerged source candidate. NOT DEPLOYED.**

This adapter serves the owner's existing five-card Control Center privately from numeric loopback, integrates it with the existing authenticated relay and provides an optional **Device Authority** panel. The panel is an additional **deny-only Control Center restriction overlay**, not a device-local permission editor, a grant of administrator rights, or an alternative identity provider. The device agent's policy and the existing OAuth/relay authorization remain final.

## Original owner artwork

The **current owner-approved candidate HTML bytes** installed locally on Leno as public/index.html have SHA-256:

**4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8**

The exact source HTML and the original private font are **excluded from Git and distribution**. The local verification command pins the HTML above and the 40,404-byte private `public/tp-font.woff2` asset (SHA-256 `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e`). Both were recovered byte-for-byte from the previously approved local staging artifacts. Do not publish or substitute the font without verifying redistribution rights. The installer, verifier and integration regression agree on the HTML fingerprint. The server injects a separately loaded script in the HTTP response; it does not write to, regenerate, or normalize the HTML on disk. The ASCII illustration, shine, animation timings, theme transitions and original layout must not be edited.

**Provenance caution:** The October 23 historical integration documentation names an older HTML fingerprint, **36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82**. Another named Leno functional-copy reference also differs. These are distinct files: **no equivalence or silent upgrade is assumed**. Confirm the intended artwork and rights, and inspect VAULTER's existing on-disk source before any promotion.

Install the currently pinned owner-supplied HTML only if explicitly available and authorized:

~~~powershell
.\scripts\Install-ApprovedHtml.ps1 -SourceHtml 'C:\path\to\approved-owner-page.html'
node .\tools\verify-original.mjs
~~~

The installer refuses any wrong fingerprint and any attempt to overwrite a different existing HTML. It does not fetch or create artwork. The font must be provisioned separately from authorized local artwork; `verify-original.mjs` fails if that private asset is missing or altered. Headless Edge also verifies the actual `GET /tp-font.woff2` response rather than accepting a CSS fallback.

## Runtime and configuration

Prerequisites: Node.js 22+, the privately supplied exact HTML and an already-authorized relay endpoint. The local listener binds **127.0.0.1 only**. Do not publicly expose this operator Control Center.

Normal behavior (without authority configuration):

~~~powershell
node .\oauth.mjs --port 8790 --relay-url 'https://EXISTING-RELAY-ORIGIN' --oauth-config 'C:\protected\approved-oauth-client.json'
~~~

Optional Device Authority:

~~~powershell
node .\oauth.mjs --port 8790 --relay-url 'https://EXISTING-RELAY-ORIGIN' --oauth-config 'C:\protected\approved-oauth-client.json' --authority-config 'C:\protected\authority.json'
~~~

The OAuth configuration must refer to an **existing approved** client, issuer, exact resource, scope and loopback callback. The browser accepts only an HTTPS authorization destination from the server's already-validated issuer discovery; it contains no owner-specific hardcoded hostname. No new registration, scope expansion or replacement issuer is needed. The authority configuration requires:

- journalPath: absolute path to private append-only JSONL audit data.
- checkpointPath: different absolute path for a private MAC-authenticated history checkpoint.
- auditKey: separately generated 32-byte private HMAC key in base64, never committed or logged.
- issuer and resource: the exact existing trusted issuer and relay MCP resource.
- adminSubjects: explicit allowlist of already-validated OAuth subjects. An empty list makes the panel **read-only**, not administrator-by-default.

**First-use bootstrap (before starting the portal):** in a private, non-production directory with carefully protected configuration, execute `node tools/provision-authority-audit.mjs --authority-config C:\\protected\\authority.json`. This explicitly creates an empty journal and matching authenticated checkpoint. It refuses to overwrite even partially existing audit storage. The server does not auto-initialize or auto-reset missing audit history; it refuses to start with authority enabled until both files match. Never use the provisioning command to recover a lost production journal. Restore a verified matching journal/checkpoint pair from backup after a reviewed recovery decision.

The authority HTTP endpoints are GET /api/authority/:device and owner-confirmed POST /api/authority/:device/change and /rollback. POST requires an authenticated server-side session, exact same origin, CSRF, exact device confirmation, a reason and a non-stale revision. Pairing ownership is verified via the existing relay before observation or mutation. When a restriction is active, process, batch and non-observational device operations are conservatively denied through this Control Center. A restriction of filesystem operations also denies the Control Center browser tool to reduce cross-capability bypass. The local agent still evaluates all forwarded requests independently.

**The authority overlay is not a fleet-wide device policy.** Other clients and agent-local policy are unaffected. Advertised capability discovery does not prove the current principal can invoke every operation.

Keep the authority audit journal, checkpoint and key protected with operating-system permissions and independently verifiable backups. Local authority mutations acquire an exclusive create-new writer lease beside the journal before replay+append+checkpoint, refuse a second writer, and release it only after the operation completes. A stale lease after a crash must be reviewed and resolved by an authorized operator; it is never removed automatically. The checkpoint binds the expected journal digest, record count and HMAC-chain head; missing, truncated or mismatched files now fail closed across process restarts, including after a crash between journal append and checkpoint advance. Restore only a matching verified pair. **Limit to one authorized writer:** interprocess serialization, filesystem ACLs, crash recovery and out-of-band backup restoration still require operational acceptance. A privileged actor controlling both files and the audit key remains outside this local tamper-evidence guarantee. Do not enable production administrators until those requirements are independently verified.

## Testing

~~~powershell
npm test                         # Full repository-aware suite
npm run test:standalone          # Self-contained adapter tests
npm run test:browser             # Synthetic Edge browser acceptance
npm run verify:artwork           # Private HTML and WOFF2 hashes
~~~

The Node tests use synthetic accounts, relay or HTTP fixtures and security boundaries. The optional Python test requires Playwright and Edge, starts a temporary loopback server with synthetic test-only key/configuration, exercises the current worktree panel, rollback, non-owner denial and out-of-order device responses, and terminates the test server. **It performs no real device policy change.** Tests cannot be represented as live production permission acceptance.

## Release hold

Before any protected merge or VAULTER promotion:

1. **Source reconciliation complete 2026-10-25.** VAULTER's 20,808-byte server is exactly reconstructed by reversing only the authority hook; recovered OAuth and integration source hashes match the production receipt. The permanent `deployed-base-parity.test.mjs` protects this baseline. Before deployment, reconfirm the production hashes; do not bypass any remote principal restriction.
2. Confirm the precise owner HTML version and preserve the existing original artwork and rights.
3. Validate actual authenticated Control Center sessions, expiry, correct denials, four-device discovery and clean rollback without unsafe live mutations.
4. Provide a protected audit key/journal location, backup and recovery plan; independently check fail-closed behavior, file protection and journal-loss handling.
5. Verify production-package provenance, trusted signing, clean install/upgrade/uninstall and operational rollback on an authorized Windows machine.

**VAULTER read-only provenance helper:** `scripts/Collect-ControlCenterReadOnlyReceipt.ps1` accepts an explicitly selected existing portal source root and an explicitly approved absolute JSON output path. It hashes only whitelisted script/artwork files, reads listener/process metadata for port 8791, excludes OAuth config/credentials and process command lines, and refuses to overwrite receipts. Its smoke test was run on Leno, and an authorized VAULTER operator subsequently ran it on October 25, 2026 with a single loopback listener on port 8791 and ten file fingerprints. The user-supplied receipt has been reconciled with the candidate in the release handoff. It does not establish deployed JavaScript source identity solely from the Node executable checksum.

The concise verified closeout and production-promotion gate are recorded in `../../docs/release/CONTROL_CENTER_DEVICE_AUTHORITY_CLOSEOUT_20261025.md` from the repository root. Do not merge, deploy, change protected identity settings, or replace the running VAULTER listener without explicit approval.
