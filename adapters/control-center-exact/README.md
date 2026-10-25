# Tetherplane exact Control Center — Device Authority candidate

**Status (2026-10-25): isolated, unmerged source candidate. NOT DEPLOYED.**

This adapter serves the owner's existing five-card Control Center privately from numeric loopback, integrates it with the existing authenticated relay and provides an optional **Device Authority** panel. The panel is an additional **deny-only Control Center restriction overlay**, not a device-local permission editor, a grant of administrator rights, or an alternative identity provider. The device agent's policy and the existing OAuth/relay authorization remain final.

## Original owner artwork

The **current owner-approved candidate HTML bytes** installed locally on Leno as public/index.html have SHA-256:

**4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8**

The exact source HTML is **excluded from Git and distribution**. The installer, verifier and integration regression agree on that fingerprint. The server injects a separately loaded script in the HTTP response; it does not write to, regenerate, or normalize the HTML on disk. The ASCII illustration, shine, animation timings, theme transitions and original layout must not be edited.

**Provenance caution:** The October 23 historical integration documentation names an older HTML fingerprint, **36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82**. Another named Leno functional-copy reference also differs. These are distinct files: **no equivalence or silent upgrade is assumed**. Confirm the intended artwork and rights, and inspect VAULTER's existing on-disk source before any promotion.

Install the currently pinned owner-supplied HTML only if explicitly available and authorized:

~~~powershell
.\scripts\Install-ApprovedHtml.ps1 -SourceHtml 'C:\path\to\approved-owner-page.html'
node .\tools\verify-original.mjs
~~~

The installer refuses any wrong fingerprint and any attempt to overwrite a different existing HTML. It does not fetch or create artwork.

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
- auditKey: separately generated 32-byte private HMAC key in base64, never committed or logged.
- issuer and resource: the exact existing trusted issuer and relay MCP resource.
- adminSubjects: explicit allowlist of already-validated OAuth subjects. An empty list makes the panel **read-only**, not administrator-by-default.

The authority HTTP endpoints are GET /api/authority/:device and owner-confirmed POST /api/authority/:device/change and /rollback. POST requires an authenticated server-side session, exact same origin, CSRF, exact device confirmation, a reason and a non-stale revision. Pairing ownership is verified via the existing relay before observation or mutation. When a restriction is active, process, batch and non-observational device operations are conservatively denied through this Control Center. A restriction of filesystem operations also denies the Control Center browser tool to reduce cross-capability bypass. The local agent still evaluates all forwarded requests independently.

**The authority overlay is not a fleet-wide device policy.** Other clients and agent-local policy are unaffected. Advertised capability discovery does not prove the current principal can invoke every operation.

Keep the authority audit journal and key protected with operating-system permissions and backups. HMAC chaining detects modified/truncated journal entries; it does **not** by itself prevent removal of the entire journal across a service restart. Loss-of-journal recovery and secure local provisioning must be independently assessed before any production administrator activation.

## Testing

~~~powershell
node --test test/*.test.mjs
node .\tools\verify-original.mjs
python .\test\browser-authority-qa.py
~~~

The Node tests use synthetic accounts, relay or HTTP fixtures and security boundaries. The optional Python test requires Playwright and Edge, starts a temporary loopback server with synthetic test-only key/configuration, exercises the current worktree panel, rollback, non-owner denial and out-of-order device responses, and terminates the test server. **It performs no real device policy change.** Tests cannot be represented as live production permission acceptance.

## Release hold

Before any protected merge or VAULTER promotion:

1. Obtain authorized **read-only** hashes, runtime version and actual source provenance for the VAULTER port 8791 deployment; reconcile newer fleet presence, OAuth and integration code file by file. Do not bypass a denied remote capability.
2. Confirm the precise owner HTML version and preserve the existing original artwork and rights.
3. Validate actual authenticated Control Center sessions, expiry, correct denials, four-device discovery and clean rollback without unsafe live mutations.
4. Provide a protected audit key/journal location, backup and recovery plan; independently check fail-closed behavior, file protection and journal-loss handling.
5. Verify production-package provenance, trusted signing, clean install/upgrade/uninstall and operational rollback on an authorized Windows machine.

Do not merge, deploy, change protected identity settings, or replace the running VAULTER listener without explicit approval.
