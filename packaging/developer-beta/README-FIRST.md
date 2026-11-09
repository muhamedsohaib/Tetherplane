# Tetherplane developer beta — add one Windows computer

This is an **unsigned Tetherplane developer beta**, not a public customer installer or Microsoft Store package. It is designed only for a consenting, non-sensitive Windows x64 test device. **Do not disable Windows Smart App Control, antivirus or any signature checks.** If Windows blocks execution, stop and report the block; do not work around it.

## On the new computer

1. Receive the exact, owner-reviewed beta ZIP from the existing Tetherplane operator. Independently compare its SHA-256 with the hash supplied by that operator. Extract the entire ZIP to a new empty folder. Do not run on a machine with another Tetherplane agent.
2. Double-click **START HERE.cmd**. This verifies package file hashes before launching the existing GUI-subsystem `tetherplane-setupw.exe`. You do not need a separately installed Node.js or a PowerShell command.
3. The browser opens a **localhost-only** setup page. Confirm the secure `wss://…/device` connection address (prefilled if the operator prepared a personalized package). The unique device ID is generated locally; the recommended file permission is **Tetherplane Shared**, a separate folder created *only after you request pairing*. Do not choose your whole home folder.
4. Select **Request owner approval**. This creates only a short-lived code and locally generates a new credential. It does **not** grant access or run the agent yet.
5. Give the displayed code and device ID to the account owner through your normal trusted communication channel. **Never exchange OAuth tokens, passwords or device credentials.** Once the existing owner approves the exact code, the setup retries the existing relay's cryptographic approval proof and starts the local windowless agent.
6. The local page may say the agent has started. That **does not establish remote connectivity**. The owner must verify **device.status** for the exact new ID using the authenticated Tetherplane plugin/Control Center.

## On the existing owner computer

Open the authenticated **Tetherplane Control Center → Device Authority**. Review the new device ID and short-lived code, approve only the intended device, then verify that `device.status` succeeds. This is the same existing relay/account authorization; **do not register another OAuth client**, and do not disclose the relay's private tokens. A browser tab on this new device requires a **separate, explicit, expiring tab grant** from the Edge extension. Device pairing never approves all tabs.

## Browser payload in this review candidate

The reviewed ZIP includes the existing browser host, its runtime dependencies, the windowless browser launcher and the unpacked extension. Every included file is covered by the beta checksum inventory. **They are staged, not automatically enabled.** Device pairing does not enroll the extension, start persistent browser access, share human-owned tabs or grant origins.

There is no approved automatic browser-enrollment workflow in this developer-beta setup. A browser-first real-user trial remains **NO-GO** until the extension is connected through an independently verified, explicit owner-consent workflow and the complete installed browser candidate passes Windows, authorization/revocation, restart and trust gates. Do not manually load the unpacked extension into an ordinary personal browser profile based solely on the ZIP's presence.

## Reconnect / stop / revoke

Reopen **START HERE.cmd** on the new device to resume its saved identity. No startup task is silently installed. **Stop this session's agent** terminates only this local process. To remove remote access, the authenticated owner must **Revoke Device** under Device Authority and verify the call is denied afterward. Do not delete or replace saved credentials to force pairing. A damaged existing identity is blocked and preserved for review.

## Independent release gate

This file is a first-user workflow, **not evidence that onboarding succeeds**. Before any customer release, independently measure installation, owner approval, 30-second consent-to-connect target, 60-second time-to-first-task target, unauthorized-operation denial, revocation, restart/recovery, rollback and the correct four-device boundaries on a newly authorized Windows computer.

Source revision and component file hashes are in `developer-beta.json`. A hash check detects accidental changes but **is not an Authenticode signature or a guarantee that the original unsigned developer-beta binary is trustworthy**.
