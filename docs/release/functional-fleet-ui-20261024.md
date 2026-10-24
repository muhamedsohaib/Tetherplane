# Tetherplane functional fleet UI / 2026-10-24

Owner scope: preserve the exact animated HTML, metallic background, theme transition and glass controls. Remove artwork-view controls and onboarding slider. Show real account directory, relay connectivity, session expiry and explicit read-only device.status actions. No fabricated health or broadened device authority.

Source-only implementations:
- Live-compatible isolated branch feature/control-center-live-ui-20261024 based on 72c4e2b.
- Forward branch feature/control-center-functional-fleet-ui-20261024 based on PR 57 at 71e565f.
- Both change only public/tp-integration.js and test/functional-home.test.mjs. The owner HTML is ignored/private and unchanged.
- Approved artwork SHA-256: 36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82.

Test evidence:
- New tests RED before the fix; the art control remained, and device status function was absent.
- New tests GREEN (2/2) both branches. Forward branch existing UI-state tests passed 6/6.
- Live-compatible full Control Center suite passed 22/22. Node syntax, artwork verifier and git diff checks pass.
- Forward branch full suite had a pre-existing PowerShell pairing-client parse failure (30/31 before change, 32/33 after). The new UI tests pass.
- Headless Edge through the SSH context returned no DOM; final visual acceptance requires operator inspection.

Security: existing authenticated account directory and manual MCP device.status calls only; no shell capability granted in the browser. RTX remains disconnected. PR 57 owner authority is not deployed; effective relay has no --authority-config flag.

Leno to VAULTER administrator access uses an independent authorized SSH channel. Existing dedicated private key was already present; added Leno host alias vaulter-admin with strict host verification. VAULTER account is in enabled Administrators group with High Mandatory Level. No new SSH key, privilege grant, OAuth client or MCP policy change.

Live UI-only rollout can use a hash-verified atomic script replacement with preserved backup and no process restart. Production authority changes remain separately gated.
