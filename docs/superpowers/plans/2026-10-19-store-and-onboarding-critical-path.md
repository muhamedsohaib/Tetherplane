# Tetherplane Store and Windows onboarding critical path — 2026-10-19

**Status:** Execution-ready remaining-gates plan; NOT a Store submission, operational installer, or authorization to modify production.
**Source baseline:** `66caea52f164bb4a6eafc5bcb02135c919993cfd` from draft PR #19. The canonical design, roadmap and local-core plan remain authoritative.
**Goals:** ship a real user-consented Windows onboarding flow, meet Microsoft Store packaging/certification requirements, preserve the six-tool MCP and local-policy contracts, and keep enrollment/distribution free.

## What is actually verified

- PR #17 Windows reconnect and full CI passed at `eff2a354d715f2707ed902a9f86de90fa23ef3ab`; its original draft branch contains the fix.
- Hosted Windows native containment suite and full CI passed at `997608268f95ae7f4e9c4a5fcda43e6106fa41d0`; its original feature branch contains the fix.
- Branded unsigned MSIX feasibility, Agensi review-package and full CI passed at `66caea52f164bb4a6eafc5bcb02135c919993cfd`; original draft PR #19 contains the fix. The MSIX is an explicitly UNSIGNED, UNINSTALLED proof and contains a CLI agent, not a first-run application.
- GitHub already published tag `v0.1.0` on 2026-09-26. Do not recreate or move that tag.
- Native MCP Surface `device.status` worked in background-only mode; a harmless owned process ran and was verified; filesystem read outside allowed roots was denied; the owned fixture was cleaned.
- Live Leno status was `disconnected`, Vaulter was `unknown` to the current authenticated Tetherplane principal, and Surface reported browser provider unavailable. Neither live installer trust nor complete browser acceptance is proven.

## Order of work and acceptance gates

### Gate A — Maintain verified Git and CI state
1. Verify `git status`, current branch, last 5 commits, remotes, and linked worktrees on Leno **when it becomes reachable**. Until then GitHub is the canonical inspectable source; never overwrite local changes based on remote assumptions.
2. Keep PRs #15–#19 draft until all relevant release acceptance evidence is fresh. Do not merge or tag by implication from package CI.
3. Recheck the promoted-source CI SHA, not only a previously green child feature branch.
4. Investigate desktop fixture startup flakiness when reproducible. Do not simply increase timeouts or skip the fixture. The original UIA PR's 20-run hosted Windows stress check passed; a separate reconnect CI run once timed out and subsequently passed its rerun.

### Gate B — Real Store first-run executable (currently NOT implemented)
1. Choose a real Windows launchable GUI/entrypoint technology consistent with the Rust/TypeScript source architecture and without a bundled Chromium browser. A new language or runtime is an explicit architecture decision; do not silently introduce C# or Electron.
2. RED: a fresh-user hosted Windows acceptance test must fail for the current MSIX because its `Application` points directly at `bin\\tetherd.exe` without the required `--stdio-rpc` or `--relay-url` transport arguments and no onboarding UI.
3. GREEN: package an actually launchable first-run interface showing local device identity, install state, account pairing status, and precise recovery choices without printing device credentials. Merely opening a help page is not a completed onboarding flow.
4. First launch must make **no** scheduled task, credential, policy, registry Run entry, network pairing request, or background agent creation without explicit user consent. Installation and pairing must be distinct reversible actions.
5. Reuse ownership-safe setup, signature verification, device-local 32-byte credential generation, hash-only pairing and least-privilege principal policy. Do not clone or copy another device's credential. Use the existing relay-account-bound `device(op="approve_pairing")` contract only once independently approved and deployed.
6. RED→GREEN: clean-profile install, user-consented pair, approval, finalize, restart/reconnect, repair, upgrade, uninstall/preserve-state and explicit optional purge, all with negative tests for foreign owners, path redirection, modified receipts and concurrent human writes. Test on hosted Windows without touching human-owned devices.
7. A package containing only `tetherd.exe` and a placeholder manifest must always be labeled a development proof. Never upgrade its metadata to 'Store-ready' merely because MakeAppx passes.

### Gate C — Microsoft publisher, public trust and Store certification
1. Enrollment must cost **zero**. No signing-certificate purchase, paid subscription, unverifiable organization, or fictitious identity.
2. The account for `tetherplane@outlook.com` was blocked during creation by Microsoft's unusual-activity control. No programmatic retry or identity-verification bypass is authorized; resume through Microsoft's official signup/support after the cooldown using truthful legal information.
3. The requested Store title and *Published by* line are both `Tetherplane`. The public publisher line is controlled by the developer-account identity and Microsoft policy, **not** the MSIX `PublisherDisplayName` or email alias. Confirm in writing that an Individual account may publish under this open-source project brand before enrollment finalization; otherwise stop. Do not create a company account without a legally registered company.
4. After verified Partner Center onboarding, reserve the product title, read exact package identity/publisher values from Partner Center, replace only prototype identity values, and obtain Store-managed MSIX signing/certification without buying a standalone certificate.
5. Complete WACK, an authentic functional Store-signed candidate, clean Windows 10/11 install, Smart App Control-On acceptance, privacy/support URLs, restricted `runFullTrust` disclosure, accurate screenshots, user-controllable startup and uninstall. Certification evidence must be freshly reviewed.
6. Store submission, publication, and any Microsoft support message are external actions and require the user's explicit action-specific approval.

### Gate D — Live devices and account-bound acceptance
1. Leno (canonical local working copy) must reconnect before anyone claims Leno live, source-worktree, Smart App Control, or installer acceptance. No Smart App Control bypass, OS security setting change or unsigned install.
2. Vaulter is reported unknown to the current plugin principal; reconcile device/account registration through locally authorized procedures, not guessed IDs or copied tokens. Surface is reachable for background-only read/process; browser provider is not available.
3. Prove genuine authenticated six-tool MCP discovery; `device.status` on each independently approved device; a harmless Tetherplane-owned process; filesystem policy denial; browser owned-context semantic observation where provider is available; no human focus/cursor/clipboard/tab disturbance. Record source SHA, tool verdicts and non-secret device IDs.
4. Deployment of relay-side `approve_pairing`, any live task restart, agent replacement, or foreground test needs scoped user/policy approval and rollback evidence.

## Non-negotiable completion checklist

- [ ] Gate B real first-run launcher passes fresh Windows tests and source-bound package inspection.
- [ ] Gate B clean-device install/pair/reconnect/repair/upgrade/uninstall is independently verified.
- [ ] Gate C publisher identity and `Tetherplane` Published-by eligibility are accepted by Microsoft.
- [ ] Gate C Store-signed package passes WACK and Smart App Control-On acceptance.
- [ ] Gate D Leno local and remote coexistence acceptance passes.
- [ ] Gate D Vaulter pairing and Surface browser capability gaps are either resolved or accurately excluded from supported claims.
- [ ] Exact-head full repository gates, review, and release-candidate hashes recorded.
- [ ] Separate explicit approval obtained before any external support communication, Store submission or publication.

**Release rule:** passing CI and an unsigned MSIX prototype do not authorize installation, Store certification claims, a new GitHub tag or public release.
