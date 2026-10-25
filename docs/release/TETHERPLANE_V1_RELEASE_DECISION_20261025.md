# Tetherplane v1 release decision — 2026-10-25

**Status: local Control Center / authorized four-device fleet ACCEPTED; publicly signed clean-installable Windows release NO-GO.** This record distinguishes observed independent evidence from source-only/CI fixtures and external approval gates. Do not use it to authorize publishing a tag, merging stacked branches, bypassing a scope or touching production identity.

## Verified today

| Boundary | Exact evidence | Disposition |
| --- | --- | --- |
| VAULTER Control Center | Operator-provided V4.1 receipt `VERIFIED_OWNER_EDITOR_ACCEPTED=YES`; owner-authenticated browser screenshots show five enabled, deny-only Control Center restrictions; live process PID 13440 at acceptance | **ACCEPTED**, editor activated for exactly one relay-verified OAuth subject; no real restrictions applied during acceptance |
| Portal authorization | Existing issuer/client/scope preserved, first-use audit and checkpoint reused, origin/CSRF/revision restrictions preserved, no device-local authority grants | **ACCEPTED for UI activation**, NOT proof of live restrict/rollback exercise |
| Fleet status | Independent Tetherplane `device.status` returned Windows x86_64, agent `0.1.0`, `background_only` on **Surface, Leno, VAULTER and RTX**; Surface/Leno reported detailed `authenticated` / `ready` | **PASS** for authenticated connector status, not sustained soak or portal session expiry |
| Real execution | Authenticated `process.run` of harmless echo succeeded with exit 0 on Surface, Leno and RTX | **PASS** for those specific principals/operations |
| Denial | Same harmless `process.run` on VAULTER returned `permission_denied`: principal `operator:sohaib-vaulter-limited` is not authorized | **PASS** for that denial; never attempted any bypass |
| Control Center source | Feature branch `feature/device-authority-20261025`; verified-source editor commit `6bad88c`; UI tests 55/55 on source, 53/53 standalone private candidate, independent synthetic Edge PASS | **PASS** at that source/test scope; private owner HTML/font excluded from public Git |
| Editor production acceptance record | Commit `5139f51` closes the previously staged editor evidence on Leno | **COMMITTED locally**, not merged or pushed |
| Windows source integration | Draft PR #46 at `9e9bef7947f292bd8b8eda0b0dbed60fbaf18296`, stacked on the PR #44 / #45 native-task reliability chain | **CI GREEN**; NOT an integrated public signed artifact |
| GitHub CI at PR #46 HEAD | Runs `39896048793` Authenticode policy, `39896048875` native onboarding, `39896048810` Windows/Ubuntu CI all `success`; isolated Windows job `120226648358` passed exact-source agent build, unsigned disposable package, native Scheduled Task, safe stop | **PASS** for exact CI source, not an operator-owned clean install |
| Independent isolated PR #46 source check | Exported exact 500-file Git archive, SHA-256 `ddd6c4a708475c295279bb88401c265caacad4d470c959e84285a6a4ce053325`; nine PowerShell files parsed without errors on Leno; targeted release Node checks 28 passed / 0 failed / 3 platform skips | **PASS with explicitly recorded skips** |
| Signing certificate inventory | Leno, Surface and RTX Windows CurrentUser/LocalMachine personal certificate stores: 0 local code-signing certificates and 0 signing private keys; VAULTER cert store NOT inspected due protected connector scope | **TRUSTED SIGNER UNAVAILABLE in inspected stores** |
| VM/disposable Windows | RTX Hyper-V feature disabled and Get-VM unavailable; no production VM created or feature enabled | **CLEAN USER INSTALL NOT TESTED** |

## External/hard release boundaries that remain open

1. **Public trust and signing approval:** No publicly trusted Authenticode signer, approved leaf fingerprint/publisher or protected ephemeral signing runner was identified. PR #46's signing code tests deliberately use an unsigned disposable kit; do not self-sign, disable Smart App Control or claim that CI makes an unsigned binary safe for a regular user. Provider selection, enrollment, procurement and credentials need a separate explicit owner decision.
2. **Pairing completion:** PR #46's `scripts/pair-windows-device.ps1` still tells an operator to call `device(op="approve_pairing")`. The currently exposed authenticated six-tool `device.capabilities` advertises only `status` and `capabilities`, not `approve_pairing`. The existing relay/Control Center has authorization-protected pairing APIs, but the accepted five-card frontend intentionally leaves pairing UI out. Do not claim a one-step install or grant a new pairing operation without a reviewed identity/scope path.
3. **Protected publication workflow:** Git `origin/main:.github/workflows/release.yml` still grants `contents: write` and can publish an unsigned Windows archive when any `v*` tag is pushed. In contrast, the feature branch has a fail-closed unsigned-publish guard. **Do not push a version tag.** Draft PR #34's least-privilege approved publishing workflow must be reviewed/integrated before any tag.
4. **Clean installation and human usability:** The native CI test requires a disposable GitHub Windows runner and explicitly refuses a machine already hosting Tetherplane. It is not a real novice's trusted installer → authorized pair → first status within 300 seconds → out-of-root denial → recovery/rollback/uninstall. Test on a separate new authorized Windows environment, with a witnessed before/after evidence receipt.
5. **Production restriction/rollback and soak:** The user accepted editable controls, but no real Control Center restriction transaction, correct deny, and revisioned rollback has been applied on production. No sustained fleet reconnection or fault recovery under the final combined signed source is independently verified. The existing 16-work/4-control and no-replay uncertainty guards must be retained.
6. **Integration and review:** PRs #16, #34, #44 and #46 are separate stacked/draft source lines. Do not bulk merge, bypass checks or replace device identities. The optional Vercel preview status currently fails on the PR #46 SHA and must be classified against preview ownership, not silently suppressed.

## Smallest safe path to release

1. **External owner action:** choose and explicitly approve an eligible publicly trusted signing provider/identity and protected runner, or explicitly re-scope to a source-only developer preview that **does not** claim signed Windows distribution.
2. Resolve onboarding pairing through an independently reviewed existing OAuth/relay approval path (no scope bypass) and validate it on one disposable Windows environment.
3. Integrate reviewed PR #44 reliability + PR #46 native installer + PR #34 guarded publication by exact source, with both OS CI and signed-package provenance. Preserve old worktrees; require separate protected merge and release authorization.
4. Capture independent clean-device, human-coexistence, correct denial, recovery, uninstall and rollback receipts. Verify four-device status again, then make the release decision. Do not tag unless all gates are green.

## Reusable onboarding improvement

Add a first-run preflight to the onboarding kit that explicitly checks **trusted-signature availability**, **supported pairing approval route**, **safe private install prefix**, **device-local principal**, **duplicate Scheduled Tasks**, and **rollback checkpoint**, and reports one precise blocking prerequisite rather than issuing multiple blind setup commands. This is an engineering design proposal, not a deployed feature.

**Decision:** The functioning private Tetherplane Control Center and four-device connector evidence can be retained. The 2026-10-25 public signed Windows distribution decision is **NO-GO** for the named external/independent gates. No deployment, identity change, signing registration, purchase, tag, PR merge or device policy mutation occurred during this final release review.

## Signer options verified against public primary sources on 2026-10-25

- **SignPath Foundation (OSS):** advertises no-cost open-source code signing but independently reviews eligibility. Its published terms require an OSI-approved project, no proprietary component in the signed package, active maintenance and an already documented/released form. This is a plausible *application* path for an OSS-only device agent; no approval or certificate is currently held. Sources: https://signpath.org/ and https://signpath.org/terms.html.
- **Microsoft Azure Artifact Signing:** the official 2026 setup guide limits public-trust organization onboarding to specified supported jurisdictions and individual developer enrollment to the United States and Canada; the UAE is not in the listed public-trust jurisdictions. The service requires a paid Azure subscription; free, trial and sponsored subscriptions cannot use it. Do not assume it is an available immediate public-trust signer for a UAE-based publisher. Sources: https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart and https://learn.microsoft.com/en-us/azure/artifact-signing/faq.
- **Alternative:** a CA-issued publicly trusted OV Authenticode identity with managed/hardware-protected signing may be evaluated for eligibility and total cost; procurement and identity approval are outside automated release operations. Microsoft documentation confirms a new signed binary can still require SmartScreen reputation buildup. Source: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation.

No provider was selected, enrolled, purchased or configured. External provider turnaround prevents claiming same-day trusted Windows distribution.
