# Leno Full Control — isolated Windows release acceptance
**Observed:** 2026-10-31, Dubai (UTC+4)
**Disposition:** SOURCE ACCEPTANCE ADVANCED; **PRODUCTION CUTOVER NO-GO**.

## Exact scope and source

- Isolated branch: `work/v5-leno-owner-scoped-20261031`
- Initial verified head for this round: `87a8bada04ff7eda39f4eb6e4a87358322f0467b`.
- Candidate workspace: `C:\Users\Sohaib\source\Tetherplane-v5-leno-scoped-integration-20261031`.
- V5 Control Center approved source: Git commit `09ea09b7ba5bbe66a23851ef6f3248c799050008`; owner-observed deployed `oauth.mjs` SHA-256 `afab023ea2de6d64d717314082c0d3c1f919ef1d84d426cf1bd9212b612f0a59` (equivalent after Windows CRLF conversion).
- VAULTER owner-applied ACL correction: restricted `ControlCenterReleases` tree from 1 inherited broad Users-write ACE to 0, independently verified by a second local operator invocation; protected rollback receipt `20261031T143028Z-3318eaa4ea9d4faca50b303ddddd33bd` retained on VAULTER. This audit result is owner-observed; Tetherplane's VAULTER principal cannot independently inspect protected ACL.
- Existing grant architecture unchanged: opt-in relay config and exact observed owner client/principal, Leno-only and revision-bound grant, with independent agent background-only and device-local Windows controls.
- No production Leno permission grant or relay cutover was made by this round. RTX untouched.

## Tests executed on Leno, all local and disposable unless indicated

| Category | Observed outcome | What it proves | What it does not prove |
|---|---|---|---|
| Installer preservation | **7/7 PASS** | Synthetic Windows install overwrite/containment rejection | Signed native clean install |
| Device-local permission approval | **6/6 PASS** | Local operator script denials, root expansion, expiry and remote Apply fencing | Actual owner privilege approval |
| Unsigned-publication contract | **7/7 PASS** | Current candidate release workflow denies unsigned public distribution | Signed artifact availability |
| Relay TypeScript test typecheck | **PASS** | Current candidate test/source static correctness | Runtime reliability |
| Full relay test suite | **105/105 PASS** | Including Leno-only authority + new process-restart acceptance | Physical Windows agent reconnect |
| Full V5 portal Node suite | **67/67 PASS** | OAuth/owner gating, V5 preservation, session expiry and rollback | Live owner OAuth session |
| Existing V5 headless Edge QA | **PASS** | Actual Edge loads accepted UI and private font; synthetic V5 restrict/rollback and stale-device UI denial | Live policy writes |
| New Leno owner UI in headless Edge | **PASS** | Real DOM renders read-only, observed-client select, explicit stage/enforce/restore, revision-refresh and expired-session lockout | Unmocked owner relay/OIDC backend |
| New Windows relay CLI subprocess | **PASS** (included in 105) | Real Node child process is terminated and restarted; synthetic paired four-WS device routes recover, Leno enforcement persists, stranger denied, rollback correct, global policy rejected before listen | Actual VAULTER reboot or tetherd reconnection |
| Private Control Center stage | **PASS** | 13 whitelisted source modules/artifacts copied to disposable package, byte hashes unchanged, approved artwork verified, staging portal serves HTTP and identical font bytes, owner API disabled without opt-in | Signing, deployment or production enablement |

### Repeatable local commands

```powershell
# From the isolated candidate repository root:
pnpm --filter @tetherplane/relay typecheck
Push-Location relay
node --test --test-concurrency=2 test/*.test.ts test/*.test.mjs
Pop-Location
Push-Location adapters/control-center-exact
node --test --test-concurrency=2 test/*.test.mjs
Pop-Location
pnpm --filter @tetherplane/control-center-exact test:browser:owner-leno
python adapters/control-center-exact/test/browser-authority-qa.py
powershell.exe -NoProfile -NonInteractive -File tests/release/v5-control-center-private-stage-smoke.ps1
node --test tests/release/windows-release-publication-contract.test.mjs tests/release/windows-main-publication-block.test.mjs
```

Local test logs (private; do not upload secrets):
`%TEMP%\tetherplane-leno-release-20261031-validation\leno-full-relay-tests-post-subprocess.log`,
`leno-v5-portal-tests-post-subprocess.log`, `leno-full-relay-typecheck.log`,
`v5-owner-leno-subprocess-acceptance-v2.log`, `v5-existing-headless-edge-qa.log`,
`owner-leno-ui-package-command.log`, `v5-private-stage-final.log`,
`win-installer-preservation-isolated.log`, `device-local-approval-isolated.log`, and
`release-publication-contract.log`.

All private-artwork staging files and simulated processes were deleted or terminated after the checks; the accepted HTML and private font remain Git-ignored, and are not eligible for public workflow artifacts.

## Current remote and native-signing constraints

- Leno has Rust 1.98.1 with `stable-x86_64-pc-windows-msvc`, Node 24.19.0, pnpm 10.34.5; **MSVC link.exe, cl.exe, gcc.exe and lld-link.exe not available**. Its isolated candidate has no `target/release/tetherd.exe`. A native Rust Windows release binary and signed Windows installer **cannot be claimed from this laptop**.
- On read-only GitHub lookup 2026-10-31, protected `main` remained `fc8590a7e997c01878ca4d85469d6ba8eae23882`; draft PR #116 (Store background startup) remained open at `66396ac681f6f095b9ac4b827cad27e9bbea3680`. These are not the new local candidate and their CI results do not verify these unpushed tests.
- The private V5 source is divergent from main. Do not naive-merge, publish private artwork or trigger Store/Vercel previews to bypass proper source provenance. Main's fail-closed unsigned-publication policy was already synchronized into the isolated source in prior commits.
- Native test `tests/release/windows-native-onboarding-kit.ps1` explicitly refuses a non-disposable workstation and was **not** run on Leno.

## Release gates still open — sequential order

1. **Isolated Windows CI/signed candidate:** on a properly provisioned disposable Windows runner, build native `tetherd`, test packaging and clean install/update/rollback without accessing VAULTER OAuth, device credentials or existing task identities. Independently verify signer, Smart App Control and packaging contracts.
2. **Owner-local recoverability:** ensure VAULTER has a restore pathway not solely dependent on the Windows owner's DPAPI profile. Preserve exact known-good V5 relay/portal/task/config and rehearse offline restoration using synthetic state.
3. **Actual browser OAuth owner acceptance:** separately verify existing V5 editor identity, same-origin session, CSRF, fresh owner session expiry/re-login, owner grant staging and denial semantics against a protected candidate deployment; do not grant Leno Full Control in production without explicit cutover authorization.
4. **Real device resilience:** Leno canary reconnect after a real relay restart, local device policy denials and recovery, Surface and VAULTER isolation, RTX participation when the owner says it is available. Unit tests do not replace four-device physical acceptance.
5. **Explicit production cutover and rollback:** verify exact approved identity and pairing generation, protected rollback inventory, then stage `TRUST Leno`, refresh, separately enforce `ENFORCE Leno GRANTS`, refresh and recheck negative permissions, then rehearse `RESTORE Leno LEGACY ACCESS` using the owner-controlled channel.

**No protected deployment, live agent restart, OAuth/client/pairing change, policy grant, public tag, push, merge or Windows signing operation is performed or authorized by this report.**
