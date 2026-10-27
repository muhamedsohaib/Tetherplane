# Tetherplane G3: evidence-gated first-device acceptance

**Recorded:** 2026-10-27 (UTC/Gulf day). **Candidate:** `501614a95a4150e2aeacd93240bfb6709e4a7f26` on draft PR #63, based on draft PR #60. **Release decision: NO-GO.** This is an independent development trial, not Store certification or deployment.

## Verified on GitHub-hosted disposable Windows

Evidence: [MSIX G2 + real-agent acceptance workflow #40481110997](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40481110997).

- **PASS**: 25/25 first-run unit, authorization and packaging-contract tests.
- **PASS**: exact-source `cargo build --release --locked -p tetherd`.
- **PASS**: new temporary device identity requests pairing; unauthenticated approval is denied; a synthetic owner account approves through the **actual** relay control HTTP API.
- **PASS**: compiled native `tetherd.exe` authenticates to the **actual** isolated relay over loopback WS in the project's explicit insecure-localhost *test-only* mode.
- **PASS**: authenticated MCP client discovers six tools and calls the real native `device.status` successfully.
- **PASS**: a different account is denied the test device. Unauthenticated MCP initialization is rejected without a session.
- **PASS**: stopped native agent disconnects; restarting the same executable and identity reconnects without re-pairing.
- **PASS**: owner revocation disconnects the live agent and invalidates the same device credential; subsequent requests are denied.
- **PASS**: Windows PS5.1 parse gate, signed Node runtime and license validation, Compact MCP production dependency assembly, MSIX pack/unpack and file hashes, temporary development signature, signature verification, package install, native AUMID activation, localhost first-run page, cleanup/removal.

No real owner token, real device credential, production identity, private device network, existing Canary or Windows security setting was accessed or modified. Synthetic identities were generated for the runner and deleted after testing; logs do not print credentials.

## Product risk repaired

The G2 wizard previously persisted a newly generated credential when the user clicked `I APPROVED THIS DEVICE`, even when owner approval was not verified by the relay. An early click could poison local first-run state.

G3 adds `probeApprovedDevice` using a native Node.js HTTPS request to the **existing** `/device` WebSocket endpoint. It sends the device credential only in a TLS-protected Device authorization header, checks `101 Switching Protocols` **and** the expected RFC6455 `Sec-WebSocket-Accept` challenge, then closes the temporary test socket. New device state is saved only on successful server-authenticated upgrade; an unapproved code preserves pending setup for retry.

This WSS approval path has **synthetic handshake tests**, not yet an independent real WSS live-relay trial. The separate compiled-agent acceptance above intentionally uses an isolated loopback WS relay, not a public TLS endpoint. Neither proves that a new human user completed production onboarding.

## Reproducible clean-new-device acceptance — hard release gate

Run only on a **new authorized** Windows 11 client (not existing Leno, Surface, VAULTER or RTX) with Smart App Control **On**, after the Store private-audience identity and signed package are approved.

1. Confirm clean Windows state, app package identity, Smart App Control status, and publisher signature. Do not disable Windows security.
2. Install the genuine Microsoft-signed Tetherplane MSIX from the approved private Store audience. Record installation success, exact version and SHA/provenance.
3. Launch from Start; confirm no unexpected terminal windows, real setup screen and working browser controls.
4. Select the existing owner-authorized relay WSS `/device` endpoint, a **new** device ID and explicitly chosen permitted folder. Do not import an existing Canary credential.
5. Attempt start **before** owner approval; assert no local persisted identity, no connected device and a visible recoverable refusal.
6. Approve the displayed code in the existing authenticated Control Center; then start and verify the *same* new credential is accepted. No OAuth client registration or scope change.
7. Independently invoke `device.status` from an authorized client; discover exactly six MCP tools. Verify allowed read-only operations and explicit denial of unauthorized account, out-of-scope folder and revoked credentials.
8. Close the UI, reopen, and restart/reboot only under documented user-consented lifecycle control. Prove one agent instance, authenticated recovery and no duplicate pairing or leaked terminal shells.
9. Exercise revoke, rollback and uninstall. Demonstrate preservation of unrelated device identities and that no credentials, startup tasks or files outside the dedicated installation were changed.
10. Record event-level test results with timestamps, logs **redacted of secrets**, Windows Code Integrity verdict, version, expected/actual result and reproducible reproduction steps for any failure.

### Additional blockers
- Production Partner Center publisher association/app-name reservation; restricted `runFullTrust` capability review; official Microsoft Store signing and private-audience certification.
- Store artwork/screenshots, public privacy/support policy, correct package identity and metadata.
- Windows per-user credential ACL/DPAPI evaluation and actual revocation/race recovery; single-instance runtime and opt-in startup with measured reboot recovery.
- One new authorized machine acceptance, followed by required four-device coexistence and recovery; do not modify any existing access levels or identity to force a pass.
- Existing draft Windows PowerShell MCP work in PR #61 remains a separate release integration boundary.

**Decision rule:** Green hosted CI establishes development feasibility, **not** permission to merge, publish, grant privileges or migrate an existing device. Require actual clean-install and owner acceptance evidence plus explicit owner approval before a protected release.


## Smart App Control source-code trust risk (additional preflight)
Microsoft Store signing attests the **MSIX package**, but an installed Tetherplane operation launches a *separate* native Rust `tetherd.exe` and bundled Node runtime. The hosted test already confirms Node's valid Authenticode signature; it did **not** check the Rust executable's independent Authenticode status. Microsoft advises evaluating **all** loaded app binaries and scripts under Smart App Control, not only the outer package. Therefore Store certification is not sufficient evidence that a previously SAC-blocked native agent will work on a clean Windows 11 computer. Sources: https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control and https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control .

The disposable MSIX report now records the exact native PE's `Get-AuthenticodeSignature` status alongside the signed Node status and retains `smart_app_control_enforcement_test = NOT_RUN`. If the Rust binary is unsigned or otherwise untrusted, do not claim a Store MSIX wrapper fixes the SAC error. Require Microsoft-signed Store private flight, actual SAC **On** evidence, full tool-operation test and relevant CodeIntegrity 3077 block checks. Do **not** change users' SAC setting, enroll new OAuth clients, or sign arbitrary artifacts with unapproved credentials.
