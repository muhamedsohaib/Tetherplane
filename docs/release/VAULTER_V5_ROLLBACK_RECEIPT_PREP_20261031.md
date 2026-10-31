# VAULTER V5 owner rollback and cutover receipt — PREPARATION ONLY
Date: 2026-10-31 (Dubai). Status: **NOT AN EXECUTED BACKUP OR RELEASE AUTHORIZATION**.

## Scope / invariant

Release candidate is an additive Leno-only relay authority and Control Center extension. Protect the existing four-device registry and the running V5 Control Center. Production authentication, DCR/OIDC clients, device credentials, Tailscale, the browser bridge and the accepted V5 artwork are outside this candidate. Never replace or rotate any of them to fix a narrow relay issue.

Current local source:
- candidate branch: work/v5-leno-owner-scoped-20261031
- original implementation: 0876878029d5238a00c426548eb42983be1b90f3
- restart regression: 85ae4347f51e28eea12e3b7af48af36761607af5
- synchronized release safeguard: 853509fe9d52a731031dcf18d0fe31dd3dd448cc
- main source at audit: fc8590a7e997c01878ca4d85469d6ba8eae23882

## Inventory receipt fields — MUST be filled from VAULTER owner-admin locally

Use docs/release/VAULTER_READONLY_PRODUCTION_PREFLIGHT_20261031.ps1 locally on VAULTER, inspecting the code first. It does not make changes. Never paste raw process arguments, access tokens, pairing credentials or config contents to chat.

- [ ] UTC acquisition time, VAULTER host, Windows version and operator.
- [ ] Ports 8788 relay / 8790 auth / 8791 V5 portal each bound to the expected process and interface; PID, executable script path, SHA-256, and read-only task status.
- [ ] Existing relay and portal known-good deployment directory checksums, install provenance, runtime Node version, startup mechanism and service/task account (sensitive arguments withheld).
- [ ] Exact current V5 HTML SHA-256 4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8 and private font SHA-256 18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e; do not distribute private assets.
- [ ] Fingerprint + ACL checks of auth configuration, device registry, policy/audit files; **private data and device hashes must never be posted**.
- [ ] Verify existing owner-editor account/client/principal binding locally; only a scoped fingerprint or true/false observation may be shared.
- [ ] Identify current protected task actions/configs from native Task Scheduler XML, **store them encrypted in owner-controlled offline storage**, not Git or chat.
- [ ] Baseline authenticated device.status and device.capabilities for Leno, VAULTER, Surface, RTX when RTX owner releases it; separately verify unauthorized operations are denied. RTX is deferred by owner instruction.
- [ ] Record a restore artifact's verified SHA-256 in an owner-only receipt. Backup is not trusted until successfully restored in an isolated Windows environment.

## Rehearsal and activation sequence — explicit owner approval required

1. In disposable Windows staging only, restore the known-good V5 relay/portal from the protected rollback package, with synthetic registry/credentials and synthetic OAuth clients. Confirm health, browser route policy, and audit.
2. Launch new candidate as an **alternate instance** on isolated loopback ports with disposable state and credentials; no access to VAULTER production registry, authenticators, TLS keys or device agent IDs.
3. Test owner session expiry/CSRF/method denials; verify no owner-authority-config retains legacy behavior; verify fail-closed when policy config missing or corrupted.
4. Stage TRUST Leno for exactly one verified observed AI client on current pairing, refresh state to verify enabled=false, enforcedDevices=[], and a single Leno Full Control grant.
5. Separately type ENFORCE Leno GRANTS, refresh and verify enabled=false, enforcedDevices=["Leno"], single exact grant. Check explicit authorized and unauthorized operations, revocation, restart, rollback and isolation of other devices.
6. Exercise RESTORE Leno LEGACY ACCESS at current policy revision. Assert enforcedDevices=[], enabled=false, and legacy Leno routing restored; changes on other devices are not allowed.
7. Perform a disposable offline restore with the original production-like task actions, binaries, configs and registry (synthetic only). Verify all four simulated routes and negative authorization tests after the restore. Preserve evidence.
8. Only after all gates and fresh owner approval may an independently observed production cutover be planned; first ensure the owner-local break-glass restore is available **without** the ChatGPT plugin.

## Safe offline rollback design (NOT a tested live command)

If protected owner portal remains accessible: use typed, revision-bound restore and verify result by a fresh GET, not by the POST response alone. If portal or relay is inaccessible: the authorized owner/operator must recover from the saved, independently inspected V5 task action and binary/config package using the existing Windows operator channel. Do not create OAuth clients, disable authentication, edit token scopes, delete registry/pairing files or run an unrestricted remote shell. Reverify relay, auth and portal listener identity/hashes and device routes before declaring recovery.

## Release decision

**NO-GO.** Validated synthetic policy tests, Windows TypeScript checks and the independent unsigned-publication source contract do not equal a signed Windows build, production rollback receipt, VAULTER runtime provenance or four-device physical acceptance. Browser provider remains unavailable on Leno. RTX remains untouched pending owner availability.
