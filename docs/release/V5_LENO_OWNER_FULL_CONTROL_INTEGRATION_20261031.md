# V5-preserving Leno Owner Full Control integration — 2026-10-31

## Decision and exact source

**Disposition: isolated source candidate, production cutover NO-GO.** This does not
constitute a live Leno Full Control grant or a Windows/browser access expansion.

- Accepted V5 VAULTER Control Center source: 09ea09b7ba5bbe66a23851ef6f3248c799050008.
- Accepted V5 documentation head / integration clone baseline:
  6f03bad28a3d272d60d316f55bdccd7a027caf99.
- Earlier independent owner-only source candidate: 701c1bdf26f851f6de63f2486788cf584c6c71bc.
- This integration has been built **from V5**, not by replacing V5 with the
  older owner-grant branch. The existing production version/hash currently
  running on VAULTER has **not** been independently verified in this work.
- Local isolated workspace:
  C:\Users\Sohaib\source\Tetherplane-v5-leno-scoped-integration-20261031.
- Branch: work/v5-leno-owner-scoped-20261031.
- No push, deployment, tag, OAuth client creation, agent restart, relay
  replacement or protected policy mutation was performed.

## Architectural reconciliation

V5 controls portal-only deny overlays, V5 effective-access review and
locally approved permission request export. Those are NOT authorization grants.

The additive candidate introduces an optional exact authenticated relay
OwnerDeviceAuthority, separate from V5's existing portal audit and editor.

- No flag supplied: old relay behavior is unchanged. No default owner grant.
- New flag: --owner-authority-config [absolute path]. The JSON contains only
  exact owner account/client/principal metadata plus an absolute path to
  an independently initialized authority state file. Raw tokens, client
  registrations and unknown fields are rejected.
- Missing/malformed authority state refuses owner-enabled startup (fail closed).
- Startup also rejects any global enforcement, non-Leno grant, non-Leno
  enforced device or more than one Leno client grant. This candidate is
  intentionally **Leno-only**, not a bulk four-device mutation.
- The relay owner-management gateway accepts GET /owner/leno,
  POST /owner/leno/grant, POST /owner/leno/enforcement only.
  It requires the independently verified existing owner identity. Leno
  Full Control grants are to one already-observed authenticated AI client
  with current pairing generation, explicit confirmation and revision CAS.
- Wrong client/account, revoked/changed pairing, nested batch, unknown
  capabilities and cross-device side effects deny. When Leno is enforced,
  the separate owner-management identity can read ONLY device.status and
  device.capabilities to keep V5 inspection and rollback functional.
  It does not inherit shell, desktop, browser or filesystem operations.
- Existing V5 OAuthPortal and enrolled editor protection remain in place.
  Its additional /api/owner-leno endpoints require the same verified
  portal editor, same-origin session, CSRF and independent relay owner gate.
  The UI is an **additive script** to the accepted, unchanged original HTML
  and unchanged V5 authority screen.
- Staging and activation are separate. Rollback requires the exact
  RESTORE Leno LEGACY ACCESS phrase and current revision.
- No browser extension/provider is installed by this feature and no
  Windows UAC/secure desktop or foreground human consent is bypassed.
- Existing Leno canary has 48 local human:owner capabilities, with
  filesystem tool roots limited to C:\Users\Sohaib. The authenticated
  browser bridge is not configured; this remains a separate missing provider.

## Verification evidence (isolated, nonproduction)

- Fail-first owner-portal read regression: initial V5 end-to-end test showed
  Leno-only enforcement blocked the independent owner-editor's V5 inspection.
  Corrected with exact owner-editor read-only status/capabilities exception;
  both targeted policy tests and full real portal-to-relay loopback E2E pass.
- Fail-first startup guard: global/foreign-device/multiple-client policy
  initially accepted; corrected to refuse before opening relay listeners.
- Full relay synthetic/loopback suite: **103/103 PASS**.
- Full V5 Control Center suite: **67/67 PASS**.
- Relay TypeScript typecheck: PASS after fixing a new test assertion type.
- Real loopback V5 portal + relay + four simulated authenticated WebSocket
  devices test passed: owner staging, exact identity and CSRF, Leno
  enforcement, other-device isolation, unchanged V5 audit inspection,
  and Leno rollback.
- Accepted private V5 HTML and font match their original byte-for-byte
  SHA-256 values. Four untouched tracked V5 authority modules were verified
  content-equivalent after normalization of Windows line endings; Git records
  no functional diffs for those protected paths. The isolated clone retains
  its normal Git checkout line endings. Recheck packaged production source
  bytes and all original V5 asset hashes before any protected deployment.
- The private HTML and font are Git-ignored; they are never Git artifacts.
- Evidence logs on Leno:
  %TEMP%\tetherplane-v5-leno-owner-20261031-final\relay-tests.log
  %TEMP%\tetherplane-v5-leno-owner-20261031-final\control-center-tests.log
  %TEMP%\tetherplane-v5-leno-owner-20261031-final\typecheck.log
  The final typecheck was rerun successfully after the log's first failure.

## Live state and outstanding protected gates

Last connector status check: Leno, RTX and VAULTER responded; Surface returned
DISCONNECTED. Exact live VAULTER relay binary/source tree, managed task action,
active V5 portal package and enrolled owner-management identities have not
been independently read via a permitted owner-admin channel. VAULTER's
Tetherplane principal advertises no process operations and denied the
attempted read of an out-of-root local folder; no alternate bypass was used.

Before any activation or protected production change:

1. **Owner-admin preflight on VAULTER**: inspect the exact running relay and
   V5 Control Center versions, task identities, filesystem hashes, OAuth/DCR
   configuration fingerprint, pairing generations and current audit/checkpoint.
   Do not infer production state from this isolated Leno clone.
2. **Protected rollback receipt**: preserve previous binaries, executable
   paths, task action, config fingerprints, account editor registration,
   policy/audit state and last four-device route observations. An independent
   operator must be able to restore the existing accepted V5 service without
   altering OAuth clients, credentials or pairing.
3. **Independent acceptance**: build the exact candidate on isolated Windows
   CI and test the candidate against a disposable relay/portal and device,
   including denial, restart, rollback and loss-of-owner-session recovery.
   Current 103/103 and 67/67 suites are not real deployment acceptance.
4. **Controlled owner activation**: via the existing verified portal editor,
   bind the *observed exact* AI client/principal to Leno only, type TRUST Leno,
   refresh to verify revision, then separately ENFORCE Leno GRANTS. Never
   select the global four-device switch. Recheck enabled=false and
   enforcedDevices=["Leno"] and single exact full grant.
5. **Physical four-device coexistence**: verify allowed/denied operations
   on Leno, owner-management read-only access, status and previously working
   operations on Surface/RTX/VAULTER, reboot/reconnect, current pairing and
   on-device stop. Surface must first become reachable; no claim of passing
   four-device acceptance while it is offline.
6. **Real rollback**: use the stored owner portal session to type
   RESTORE Leno LEGACY ACCESS at current revision and verify Leno and three
   other devices. If portal/relay cannot be reached, use the protected
   offline VAULTER operator recovery procedure established in step 2,
   not remote unrestricted shell or altered OAuth scopes.
7. **Browser**: separately establish an authenticated browser provider,
   explicit tab-sharing consent, and recovery behavior. No isolated-mode
   listener may be substituted for a trusted authenticated provider.

No permission or release claim is justified without these checks.
