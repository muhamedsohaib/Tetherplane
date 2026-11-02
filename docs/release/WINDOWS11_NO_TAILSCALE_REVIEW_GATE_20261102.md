# Tetherplane — Windows 11-first, no mandatory Tailscale release gate

Date: 2026-11-02. **Status: REVIEW ONLY / NO PUBLIC INGRESS OR PRODUCTION CONFIGURATION CHANGED.**

## Scope and source provenance

The isolated integration worktree on Surface is stacked on draft PR #125 (Rust half-open WebSocket watchdog) and includes the reviewed portable Chrome-for-Testing test harness from PR #124. The broader ancestry includes PRs #116, #121 and #122; none are approved for protected merge or release. The new Store browser-owner enrollment path in this worktree is a **source candidate**, not a signed installation or accepted browser capability.

The product strategy is Windows 11-first for the Store MSIX. Older Surface/Vaulter Windows 10 agents remain supported only through their separately validated existing deployment path. Do not silently lower the Store manifest's Windows build requirement.

## Architecture (retains existing four-device trust model)

1. Authorized MCP client / ChatGPT -> public HTTPS `/mcp` -> existing OAuth/OIDC resource-server and relay boundary.
2. Stable externally resolvable public hostname (no Tailscale installation required on end-user devices) -> TLS terminator or reviewed ingress -> `tether-relay` on **same-host loopback only**.
3. Each paired device establishes its own **outbound** authenticated `wss://.../device` session. Inbound device ports, VPN membership, and router port forwarding are not required at the customer.
4. Owner-approved pairing preserves account/device binding. The relay sees transient MCP payloads; do not claim end-to-end data secrecy. The local principal/Policy Broker remains the final execution authority. Connection recovery never retries mutations automatically.
5. Local-only stdio MCP remains possible without any public relay.

**Important:** Today's Vaulter public endpoint is Tailscale Funnel. A Windows guest lacking Tailscale but using that endpoint proves only customer-side VPN independence; it does **not** prove infrastructure independence. A separate public ingress is required to prove both.

## Parallel canary, without changing production

Choose a provider and public hostname later, with owner approval for any DNS, billing, OAuth or infrastructure mutation. Two viable review options:

- A hosted TLS edge or Cloudflare Tunnel to a **separate, test-only** relay (no customer Tailscale). Low upfront configuration burden but retains provider and upstream tunnel dependencies.
- A small managed public host or VPS with TLS termination and a loopback-only relay. Potentially simpler transport failure boundary but introduces hosting cost, patching, backups and monitoring.

**Do not** simply proxy live Vaulter's existing production `8788/8790` ports to a second public hostname; the current OAuth issuer/resource identity, audience, forwarded auth semantics, device registry and TLS security policy need explicit review. Do not copy or expose live registry, device credentials, issuer secrets, customer file contents or bearer tokens into a canary.

Use a separate synthetic device/owner and nonproduction identity fixtures to validate HTTPS, WSS Upgrade, routing, 401/403 denial, scope and expiry. A production identity cutover needs a reviewed migration and rollback plan, not automatic token transformation.

## Mandatory network acceptance

On a clean authorized Windows 11 machine **without Tailscale installed**:
- Verify no Tailscale process/service/client and no local tailnet/NRPT routing; capture adapter, route, DNS and TLS evidence without private files.
- Verify all public DNS answers are reachable through ordinary internet HTTPS with trusted certificates.
- Perform actual authorized device registration/pair approval, direct outbound WSS, six-tool Compact MCP discovery, harmless allowed call, negative wrong-account/capability/root/origin tests, and revocation.
- Drop and restore internet access within a controlled test guest (never disturb Surface, Vaulter, Leno or RTX). Verify return to authenticated status automatically, with no duplicate mutation and bounded offline detection.
- Compare the non-Tailscale public edge against Vaulter's existing Funnel under controlled synthetic load, including measured error rate, reconnect median/p95, health checks, logs with no payload leakage, and tested rollback.

## Browser ownership and Store packaging gates

The Store browser payload alone (PR #122) is insufficient. This review candidate adds an explicit owner action to pin the installed extension ID and create two protected local tokens after device pairing. It conditions local agent `--browser-bridge` arguments on exact owner enrollment, and provides a manual windowless browser-host action. There is **no** automatic tab/origin grant; the extension must still be locally paired and a human must approve each owned tab/origin.

**Not finished:** independent native Store-installed browser pairing/permission and revocation tests; owner-controlled browser startup after logon; installer signature/certification and Windows 11 Smart App Control; manual host lifecycle resilience; production user guidance on reading the local pairing token without disclosure. Until these gates pass, do not claim browser-ready distribution.

## External and release dependencies

- Tailscale support opt-in (#21114) was requested for the current Funnel; no confirmed enablement or approved Tailscale restart yet.
- Microsoft Store Individual versus business-style publisher eligibility remains unresolved; the existing private support ticket is not included in public source.
- Store signing/certification is distinct from CI packaging smoke. Never import self-signed root certificates or bypass Windows security policy for testing.
- Public GitHub release.yml intentionally refuses unsigned publication. Do not change that guard without explicit separate approval.

## Acceptance decision

**NO-GO** for production, protected merge, Store submission or paid infrastructure deployment. All source work must remain in review branch; exact-head Windows/Ubuntu CI, browser denial tests, clean supported Windows installation and four-device regression still required. A synthetic lab pass never substitutes for external real-device evidence.
