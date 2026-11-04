# Owner-approved Windows enrollment experiment — 2026-11-04

## Why this work exists

Public developer prerelease devbeta-20261104.1 at source
896e965eb26cc4a2f5bb92bdfd99a092017b8268 was independently
validated in a clean Surface Windows 10 Sandbox for local six-tool MCP,
device.status (1115 ms in the supplied run), and out-of-root denial.

That evidence is NOT new-device authenticated remote onboarding. The shipped
START HERE.cmd intentionally does not enroll a device.

This isolated worktree adds **opt-in**, non-persistent helper commands to
make the existing two-party pairing protocol usable without reconstructing
OAuth identity infrastructure or copying another device's credentials.

## Protocol preserved

1. Operator explicitly supplies a trusted canonical HTTPS relay origin,
   a unique device ID and an allowed existing directory.
2. The new Windows device creates a fresh 32-byte random device credential,
   stores it in a uniquely named directory under the user's
   LOCALAPPDATA/Tetherplane/Enrollments folder and restricts the Windows
   directory ACL to the user and SYSTEM; only the SHA-256 hash is sent to
   the relay via POST /pair/start.
3. Relay returns a transient pairing code. The new device remains
   UNPAIRED until an existing authenticated owner identity separately
   approves it through POST /pair/approve.
4. A second explicit command, CONNECT APPROVED DEVICE.cmd, launches the
   real native agent in the foreground using --device-credential-file.
   No credential value enters command arguments or HTTP request bodies.
5. The local principal is bound to the new device ID, the chosen directory,
   and only device.status/device.capabilities. Remote access to files,
   processes, browser, desktop and batches remains denied by default.
6. An existing authenticated MCP client must perform a real remote
   device.status call to establish acceptance; local process launch alone
   is not enough.

No new OAuth clients, scopes, credentials for existing devices, scheduled
tasks, services, Windows execution-policy overrides, protected-agent
replacements, relay configuration changes or production identity changes
are performed.

## Validation evidence

- 11/11 focused tests passed on Leno, including real Windows
  tetherd.exe with an isolated synthetic principal.
- The independent native RPC test verified success of device.status
  and permission_denied for an attempted filesystem.read.
- Windows directory ACL helper was exercised on short-lived test
  directories and excluded Everyone/Users/Authenticated Users.
- Negative tests: plaintext HTTP and untrusted URLs refused, invalid
  device IDs refused, secret directory inside an allowed directory
  refused, malformed and expired pairing codes refused, failed
  pairing removes only its newly created directory, changed local
  capability profile refused.
- The builder was extended to include the two opt-in CMD launchers,
  bundled enrollment JavaScript, documentation and manifest declarations.

DO NOT call this remote onboarding proven merely because source/native
tests pass. No new live guest has yet been paired to a production relay
through this helper; an owner-confirmed first remote MCP operation,
same-device recovery, cross-account denial and measured elapsed times
remain release gates.

## Operator approval, persistence and rollback

- Owner must approve each new device through an already-authorized,
  resource-scoped identity. Pair/start never approves itself.
- Do not run this against a running protected device using its existing
  device ID, and do not use an existing device credential.
- Closing CONNECT APPROVED DEVICE.cmd stops the opt-in foreground agent.
- Before deleting a credential for an actually paired device, revoke the
  device from the authenticated owner account; deleting local files
  alone does not revoke the relay's durable account/device binding.
- No automatic elevated privileges or app-specific control privileges
  are granted by enrollment.

## Next acceptance experiment

In a fresh authorized Windows guest, using a test relay/owner account
with valid HTTPS and no collision with the existing four device IDs:

1. Run START HERE.cmd and record local proof.
2. Run PAIR NEW DEVICE.cmd, confirm credentials are owner-restricted,
   inspect POST /pair/start redacted metadata and count elapsed setup.
3. Before owner approval, prove WSS device authentication is denied.
4. Approve the user code from the existing authorized account; record
   exactly when the human completed approval.
5. Run CONNECT APPROVED DEVICE.cmd.
6. From an independent authenticated client, call device.status against
   the NEW device ID; attempt files.read and confirm permission_denied.
7. Disconnect and reconnect, verify owner isolation, then explicitly
   revoke in the authorized test account and confirm reconnect denial.
8. Record timings: extract-to-pair-request, waiting-for-human-approval,
   approval-to-first-authenticated-operation, end-to-end elapsed,
   rather than conflating local response with remote onboarding.

The current public prerelease is unchanged. Publish a revised prerelease
only after the required real-device acceptance and owner approval.
