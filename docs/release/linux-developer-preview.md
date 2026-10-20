# Linux-first developer preview — acceptance and publication contract

Status: **NO-GO for publication**. This document is a staged acceptance plan, not a release authorization.
Candidate branch: `feature/linux-preview-readiness-20261020` (pin the exact SHA before trials).
Target: Ubuntu 22.04/24.04 x86_64, headless-capable. Other distributions and macOS are not yet claimed.

## What is already verified

- On 20 October 2026, authenticated Control Center `device.status` succeeded on VAULTER, Leno, Surface and RTX. All four are **Windows**; this does not prove Ubuntu onboarding.
- One independent RTX `device.help` request was rejected with `permission_denied`, demonstrating a specific live capability boundary, not a full threat-model audit.
- Control Center origin regression was fixed and synthetic boundary CI passed in draft PR #36, stacked on draft PR #35. Neither change is merged or deployed by this plan.
- Leno currently runs an **unsigned** tetherd while earlier Smart App Control Event 3077 entries show Windows blocked it. Windows distribution remains an independent signing gate.
- The existing `.github/workflows/release.yml` triggers on **every** `v*` tag and publishes a Windows archive. **Do not push a `v*` tag for a Linux preview** until the publication workflow has been reviewed and separated.

## What Linux CI can actually establish

The `Linux headless developer-preview gate` runs on Ubuntu 22.04 and 24.04 hosted runners. It performs Rust fmt, Clippy, complete Rust tests, builds a Linux release `tetherd`, builds the Compact MCP adapter, and starts a local stdio MCP session against the built binary in a disposable directory. Exactly six tools must be listed.

**This is not** a remotely paired device, clean physical-machine test, unattended startup test, or authorized publishable installation package. CI status alone is insufficient.

## Preview release gates (must all pass)

| Gate | Evidence | Result |
| --- | --- | --- |
| 1. Source and checks | Pinned clean commit, Linux matrix checks green; six-tool MCP smoke; secret scan | Pending fresh CI |
| 2. Artifact and install | Versioned immutable Linux package with SHA-256 manifest, verifiable provenance, no embedded secrets, per-user install from clean Ubuntu | Not implemented |
| 3. Authorized onboarding | New device identity, explicit pairing approval, account-scoped OAuth client (no scope widening or registration substitution) | Not tested on Linux |
| 4. Least privilege | Local policy denies unauthorized capability, disallowed roots, foreground actions, and cross-account routing | Not independently verified on Linux |
| 5. Recovery | Agent reconnects after reboot/network interruption; in-flight mutation is **not automatically replayed** | Not tested on Linux |
| 6. Rollback | Failed upgrade restores prior binary/launch configuration without losing pairing state, credentials, user files, or another device | Not tested on Linux |
| 7. Usability | Unfamiliar authorized developer completes installation and first authenticated `device.status` in under five minutes, stopwatch recorded | Not tested |
| 8. Independent acceptance | A second operator reviews hashes, client/relay boundaries, installer logs, denial evidence and repeatability | Pending |
| 9. Explicit publish approval | Approved platform-specific version, published artifacts and release notes reviewed; tag workflow verified before use | Not granted |

If any gate fails, record the failing boundary and keep publication blocked. Do **not** weaken the local Policy Broker, register replacement OAuth clients, disable Smart App Control, or widen scopes as a workaround.

## Release track separation

1. **Linux developer preview (P0):** first deliver a narrowly scoped headless Ubuntu install and test it on a clean authorized device. No Windows hardware or Code Integrity result is required for a Linux-only preview, but authentication and recovery tests are mandatory.
2. **Windows preview (P1):** finish signed-artifact Smart App Control acceptance, startup recovery and rollback using the existing signing kit, without touching live agents until staged tests pass.
3. **Cross-platform stable:** advertise only platforms with independently passing real-device installation and denial evidence.

The current `v0.1.0` Windows procedure in `docs/live-acceptance.md` remains authoritative for that release track. This plan does not replace its human-observed Leno requirements.

## Evidence receipt for each clean-machine acceptance

Record only: source commit SHA; artifact digest; OS/kernel/architecture; package version; elapsed setup time; operator approval timestamp (not OAuth code); MCP device status; denial error code; reboot duration; offline/reconnect behavior; rollback receipt; result and reviewer. Never retain secrets, bearer tokens, cookies, code verifiers, device-credential contents, private keys or raw `/oauth/callback` URLs.

## Next engineering slices

- Create a reproducible Linux per-user package/installer and a safe uninstall that preserves state, then add CI smoke for install/upgrade/rollback.
- Exercise live Linux device pairing to the **existing** relay with least-privilege local principal; do not modify protected TetherAuth infrastructure.
- Run an operator-observed clean Ubuntu installation, reboot/reconnect, denial and rollback acceptance.
- Review a Linux-specific publication workflow that does not accidentally invoke the existing `v*` Windows workflow.
