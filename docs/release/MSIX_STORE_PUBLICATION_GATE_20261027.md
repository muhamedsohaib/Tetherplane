# Microsoft Store release admission — Tetherplane

Revision: October 27, 2026. Owner-approved public release is **NO-GO**. Development branch `feature/msix-store-runtime-20261027` (draft PR #63, stacked on draft #60). Evidence links below are GitHub development CI results and do not authorize publication or production rollout.

## Verified in disposable GitHub-hosted Windows

- G2 package includes exact-source compiled Windows `tetherd.exe`, a **signed** Node.js runtime, its license, first-run wizard and production Compact MCP dependency tree.
- Windows MakeAppx pack/unpack hash verification, temporary development-only signing and signature verification, Add-AppxPackage and Remove-AppxPackage: **PASS**, [CI #40473813335](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40473813335).
- Installed developer package activation by Windows' `IApplicationActivationManager`, with returned process PID matching installed package executable: **PASS**, [CI #40475903024](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40475903024).
- First-run owner pairing unit tests including denied origins/requests, hash-only pairing, non-overwriting saved identity, stop/restart and simulated blocked executable: **PASS**, [CI #40475328918](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40475328918).
- Local first-run HTTP UI check from the installed activated package is a later **separate** CI gate; do not mark it passed until exact commit evidence is available.

## Must be verified before Store certification

- [ ] Partner Center account, app-name reservation and production package publisher identity. Dev-only identity `Tetherplane.StoreRuntime.DevOnly` must be replaced **after** authorized publisher association.
- [ ] Microsoft Store restricted `runFullTrust` capability justification and approval (needed because the remote-connectivity agent uses user-authorized Win32 capabilities). No unauthorized elevation, privileged Windows service, or blanket consent.
- [ ] Genuine screenshots, appropriate approved Tetherplane logo, accurate product description, support information, privacy-policy URL and regional content declarations.
- [ ] Windows 11 clean-install trial on a **new authorized** machine with Smart App Control *On*. Prove executable does not trigger Code Integrity block; note that a self-signed development package on a test runner does not demonstrate production trust.
- [ ] UI launched by a user from Start; no unexpected console windows. Actual browser form submission, code expiration, owner approval, authenticated WSS connection, six-tool discovery, authorized operation and denial of unauthorized routes.
- [ ] Credential file ACL/DPAPI or equivalent user-secret protection independently inspected on actual Windows filesystem. No plaintext secret in logs or report artifacts.
- [ ] User-chosen background auto-start and reboot/reconnect recovery; no task registration or access changes without user opt-in.
- [ ] Correct upgrade, rollback and removal, including preservation of old Canary identities/config. Never silently import, reset, re-pair or revoke an existing owner's device.
- [ ] Four-device operating model remains intact; test each currently required device separately, with explicit unauthorized-operation denial checks.
- [ ] Reproducible build, trusted artifact hashes, release provenance, and clean MSIX package flight with a valid production publisher identity.

## Rules

No production task, OAuth/DCR client, identity, pairing state, Tailscale/relay configuration, permission grant, Windows Smart App Control setting, or protected branch is to be changed as part of development acceptance. Owner approval is required before Store submission, spending money, changing identity/security privileges, merging protected branches or production migration.

References: [Microsoft — Store submission](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission); [Restricted capabilities](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations); [Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview).

## October 27 additional negative control

Hosted CI [#40476859001](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40476859001) passed native build, pack/unpack, development signature and MSIX installation, but the newly added *local HTTP setup probe* failed at PowerShell parsing before execution. The code mutation accidentally expanded a JavaScript string-replace special sequence (`$'`) into duplicate script content. This was a **test-source syntax defect**, not evidence that the MSIX payload could not install or launch.

Corrective candidate reconstructs the activation probe from the earlier passing version and uses a callback-safe string replacement. A **read-only Windows PowerShell 5.1 AST parse check now runs before native compilation** so the same class of failure will be caught quickly. The new exact-head CI result is required; do not mark local HTTP readiness as passed based on unit tests.
