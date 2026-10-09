# Vaulter staged-auth fallback cutback — source-only implementation plan

**Date:** 2026-10-10
**Branch:** `feature/tether-auth-vaulter-migration-20261009`
**Precondition:** Protected runner v2 is installed on disk but running S4U parent still uses v1. Existing Auth0 relay, port 8788, public JWKS and four private ports must remain untouched.

## Problem

If a guarded supervisor refresh fails through the verified-v1 recovery path, an intentionally launched staged Node authorization server may keep loopback port 8790 healthy while the exact S4U task is disabled. Offline v1 rescue correctly refuses to operate on an occupied port; stopping the staged process based only on command-line resemblance would risk human-owned or unknown resources.

## Engineering scope (no live Vaulter changes)

1. Persist a protected, minimal **staged-fallback ownership record** only after the recovery code has directly launched and independently verified the exact Node PID, process creation time, loopback binding, CLI/config identity, disabled S4U task and unchanged public/relay identity. No tokens, secrets, command lines or signing material enter the record. Do not retroactively adopt an unrelated or legacy staged process without proof.
2. Provide a separate, read-only-by-default **cutback script**. Its explicit action may terminate only the listener whose PID + creation time and executable/configuration exactly match the protected record, with fresh task/ownership/health guards immediately before termination.
3. On confirmed vacant port, use the existing independent offline-rescue operations for trusted v1 bytes, separately re-enabling the exact named S4U task and verifying its fresh listener. Never re-register a task or rewrite protected auth state.
4. On any failed cutback after the owned listener is stopped, first fail closed on unknown listeners; attempt a verified return to staged auth without killing unrelated processes. Report a **cutback failure** even if a healthy staged rollback succeeds. If staged recovery cannot be independently established, report **ROLLBACK UNVERIFIED** and preserve evidence.
5. Keep Gate C (live supervisor activation) and Gate D (automatic crash recovery) separately authorized, with a fresh read-only Vaulter preflight before either.

## TDD and verification

- Red: Windows PowerShell 5.1/7 contract fails when staged cutback contract/ownership proof implementation is missing; check preflight no-mutation, process identity refusal, correct transaction ordering, staged fallback, and unverified rollback.
- Green: add minimum code; confirm targeted Windows 5.1/7 contracts, Windows/Ubuntu staging and full repository CI at the resulting GitHub HEAD.
- Preserve existing runner/v1 backup bytes, private ACLs, Auth0 metadata, unchanged signing keys and no duplicate listeners.
- No production use or maintenance execution is authorized by these source changes.

## Explicit live stop conditions

Missing/invalid stage ownership evidence; S4U task not Disabled or unexpectedly modified; PID or process creation time mismatch; foreign or multiple listeners; any port other than 127.0.0.1:8790; Auth0 resource metadata or local/public JWKS mismatch; unknown task/process provenance; broken offline v1 backup or ACL; unverified rollback; any change in shared Funnel/private-port state. In these cases do not stop a process or attempt a second listener.

## Later operator gates

After source and CI gates: read-only preflight on Vaulter showing task identity, owner, installed runner version, protected v1 backup/ACL, current listener identity, local/public health, Auth0/JWKS and Tailscale routes. Only then seek a scoped maintenance approval for Gate C; reserve fault injection, reboot and OAuth issuer cutover for separate approvals.
