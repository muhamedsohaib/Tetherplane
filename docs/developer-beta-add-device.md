# Add a Windows device — developer-beta acceptance workflow

Status: **review candidate, not a released or independently accepted installer**. Never disable Smart App Control, elevate privileges, override Windows security, register replacement OAuth clients, or replace an existing Tetherplane identity.

## The two distinct authorizations

1. **Add a machine to an account:** a new, consenting Windows x64 owner opens the developer-beta ZIP; the new machine generates its own credential, sends only a hash to the existing relay, and shows a short code. The authenticated owner explicitly approves that code in **Tetherplane Control Center → Device Authority**. The local wizard checks the existing relay's WSS upgrade proof before saving credentials or launching `tetherd-agentw.exe`. The relay authorizes device membership; the local Policy Broker still controls what the agent may do.
2. **Let an AI work with a browser tab:** after device connection, the local user must separately approve the exact Edge tab and duration in the Tetherplane extension. The account/device pairing never grants blanket browser access. Revoking a device and revoking a tab grant are different operations.

## Minimal end-user procedure (no pasted commands)

1. Obtain the review ZIP from an authorized Tetherplane owner. Independently compare the ZIP SHA-256 against the reviewed artifact. Extract it into a new empty folder on a **new, consenting, non-sensitive Windows x64 device**.
2. Double-click `START HERE.cmd`. The bundled official signed Node.js runtime verifies the package's recorded file hashes and launches the GUI-subsystem Tetherplane setup. Node.js, Rust, pnpm and PowerShell commands are **not** required of the tester.
3. Confirm the approved `wss://.../device` relay address, unique device ID and the suggested `Tetherplane Shared` folder, or select an intended existing directory. Do not choose a sensitive home directory by default.
4. Click **Request owner approval**, copy the generated short code, and let the existing account owner approve it in the authenticated Control Center. The wizard automatically retries verification without accepting a mere button click as authorization.
5. The operator independently calls authenticated `device.status` for the exact new ID, then performs one harmless permitted operation and one intentionally denied operation. Record elapsed consent-to-connection and time to first useful action. A process appearing in Task Manager is **not** connectivity proof.
6. When finished, click **Stop this session's agent** on the new computer, then revoke its identity in owner Device Authority if it should not reconnect. Verify denial after revocation.

## How the owner prepares an identical, isolated review ZIP

The source-only, manual workflow `Developer Beta Add Device Lab (review-only ZIP)` builds `tetherd-agentw.exe`, `tetherplane-setupw.exe`, stages the existing pairing wizard with owner-approval polling, includes a verified signed Node runtime and its official distribution license, generates a `developer-beta.json` hash manifest, checks it, and retains the ZIP as a short-lived Actions review artifact. No GitHub release is created. The source SHA is pinned to the workflow run.

To prefill a *non-secret* relay endpoint for a specific owner, the builder supports `-PublicRelayUrl wss://<owner-authorized-host>/device`; a private token or OAuth credential must never be passed. This is an operator-level packaging option, **not** an access grant. The short-code approval is still mandatory.

Source files: `scripts/developer-beta/Build-DeveloperBeta.ps1`, `scripts/developer-beta/stage-beta-wizard.mjs`, and `packaging/developer-beta`. Tests: `tests/release/developer-beta-add-device.test.mjs`. Neither the Store state directory nor prior Tetherplane installations are modified by the beta wizard.

## Explicit limits

- This is an **unsigned developer beta**, intentionally not a Store/MSIX/SignPath initiative. A file checksum is not code signing or manufacturer trust.
- Reopen the launcher to reuse an existing approved identity; startup tasks are disabled by default and there is no silent background installation.
- It stops and refuses another running Tetherplane agent to prevent duplicate device identity on an already connected machine. Damaged saved credentials are preserved and require owner review.
- Automatic local startup after verified owner approval is **not** proof that the relay shows the device online. A separate owner-authenticated status check is required.
- Approval in the remote Control Center is still an owner action. There is no safe design in which a third party can give Tetherplane access to someone else's machine without that machine owner's consent.
- Before broader distribution, run an independent first-use trial on an authorized clean machine and verify connection, local authorization denials, revocation, restart, rollback, exact hashes, and no OS security bypass. Until then: **NO-GO for public customer rollout**.
