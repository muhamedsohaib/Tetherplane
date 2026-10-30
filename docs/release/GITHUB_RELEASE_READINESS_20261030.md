# GitHub distribution engineering and acceptance record

Audit date: 2026-10-30 (Asia/Dubai). Disposition: **NO-GO for an installable
developer preview; NO-GO for public GitHub release**. Source review can proceed.

## Identity and scope

- Existing prepared repository: `C:\Users\Sohaib\source\Tetherplane-release-readiness-20261030`.
- Branch: `work/github-release-readiness-20261030`; starting checkout was clean.
- Starting/source commit: `66396ac681f6f095b9ac4b827cad27e9bbea3680`, draft
  [PR #116](https://github.com/muhamedsohaib/Tetherplane/pull/116).
- GitHub's PR merge test revision: `d9e79445139d57e88373b5e9e88f25f3298c7ad6`.
  Both that merge and the source resolve to Git tree
  `fbff7cf4d7902763b1db59124c4f1cc6ced5c843` (fetched and compared locally).
- Remote main observed at `fc8590a7e997c01878ca4d85469d6ba8eae23882` is an
  ancestor of the source. The source is **210 commits ahead** of that main.
  These are stacked review changes, not a merged release candidate.
- The resulting engineering revision is the commit containing this record;
  obtain its full SHA with `git rev-parse HEAD`. The final handoff supplies it.
  No push, PR mutation, protected merge, tag, release, binary upload, deployment,
  signing, security-policy change, spending or live-agent change was performed.
  No clone or additional worktree was created. Original checkouts were untouched.

Live PR metadata and local `merge-base --is-ancestor` verified this chain:

| PR | Head SHA | Parent PR/base head |
| --- | --- | --- |
| #116 | `66396ac681f6f095b9ac4b827cad27e9bbea3680` | #115 `3ee625debd1c8cb549fc329a4a44a29ecb7f7d99` |
| #115 | `3ee625debd1c8cb549fc329a4a44a29ecb7f7d99` | #114 `4b7941e4659bb7f87d2ac56ee3e6e5e3fdd2a0be` |
| #114 | `4b7941e4659bb7f87d2ac56ee3e6e5e3fdd2a0be` | #113 `085ca794eadc6b471e48f62b89e0a33b81852078` |
| #113 | `085ca794eadc6b471e48f62b89e0a33b81852078` | #112 `f2532b5efb43fd326cfb61227b28d80a49cc8946` |
| #112 | `f2532b5efb43fd326cfb61227b28d80a49cc8946` | #111 `535fd2a6353afd7a9ede887bd3bead8d71434003` |
| #111 | `535fd2a6353afd7a9ede887bd3bead8d71434003` | #110 `a7e432d1633a437892bf31068c501ef1ab813e38` |
| #110 | `a7e432d1633a437892bf31068c501ef1ab813e38` | #109 `b2ac4b49cd81b7e436a9c2f2c016d8cb28076301` |
| #109 | `b2ac4b49cd81b7e436a9c2f2c016d8cb28076301` | #107 `be544ec3e1a53c649249d4fb0908fb917312da1b` |
| #107 | `be544ec3e1a53c649249d4fb0908fb917312da1b` | #106 `9c0cf237609c282c169537f89de25bc7fe697532` |
| #106 | `9c0cf237609c282c169537f89de25bc7fe697532` | #105 `a8018672056fb72cfd4c33cfc28019b953c85e43` |
| #105 | `a8018672056fb72cfd4c33cfc28019b953c85e43` | byte-evidence base `2109f303c0f3b2642a264988d056247589011d5b` |

The earlier main-to-byte-evidence stack still needs normal integration review;
ancestry is not approval of all 210 commits. PR #108 is a separate Store-version
branch and is not asserted to be this chain's parent.

## Demonstrated defects fixed

1. **Destructive replacement without recovery.** The original installer removed
   a previous owned prefix before copying the candidate or registering its task.
   Failure injection first demonstrated a partial fresh install. The replacement
   now stages all files/receipt in a GUID sibling, retains a prior prefix as a
   backup, commits by rename and restores the prior files/receipt after copy or
   registration failure. Exact stopped task ownership is verified before cleanup
   after partial registration. Scheduler-access/ownership uncertainty retains the
   backup for owner review. Existing state is never recursively removed during
   rollback. Same-state installer ownership survives an upgrade.
2. **State could be deleted by ordinary uninstall or upgrade.** Equal/nested
   install and state directories were accepted. A real filesystem fixture
   reproduced acceptance, and ordinary uninstall removed the nested marker.
   Both new paths and legacy receipts now deny overlap before destructive work;
   changing the new state path cannot authorize deleting old nested state.
3. **Packaged MCP PowerShell entrypoint did not parse parameters.** Executable
   statements preceded `param`, leaving no AST parameter block and failing on
   `$RemainingArgs`. The parameter block now comes first. A child PowerShell
   exercises argument and receipt-state forwarding with Node intercepted.

Each defect has a failing-before/passing-after regression. Independent read-only
review found and resolved two additional edge cases in the patch (missing-task
lookup and legacy nested-state upgrade). Final review found no unresolved P1/P2.
This is not a whole-repository security certification.

The Rust kernel/provider/adapter/transport/policy architecture, six Compact MCP
tools, `background_only`, local final authority, saved device identities,
OAuth/DCR and disabled-by-default Store StartupTask remain unchanged.
`release.yml` still unconditionally throws `UNSIGNED_PUBLIC_RELEASE_BLOCKED`.

## Fresh verification evidence

Local logs are retained under `target/release-readiness-evidence/` (ignored by
Git). `SHA256SUMS` there inventories the logs and the sanitized source CI/status
receipt. Commands' failures are retained; a later successful fixture does not
erase a failed native/environment gate.

| Local gate | Actual result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Exit 0, pnpm 10.34.5. Early missing-dist shim warnings resolved by builds. esbuild lifecycle approval was not changed. |
| `cargo fmt --all -- --check` | PASS |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | BLOCKED, exit 101: MSVC `link.exe` missing |
| `cargo test --workspace --locked` | BLOCKED, exit 101: same linker prerequisite |
| `scripts/build-windows-agent-binaries.ps1` | BLOCKED: same linker prerequisite; no candidate binary produced |
| `tests/release/windows-package-smoke.ps1` | BLOCKED, exit 1: `target/release/tetherd.exe` absent |
| `pnpm --filter @tetherplane/e2e test` | BLOCKED, exit 101 in native pretest; E2E tests did not execute |
| `pnpm -r typecheck` / `pnpm -r build` | Both PASS |
| `pnpm -r test` | FAIL: browser private-pipe test requires `C:\Program Files\Google\Chrome\Application\chrome.exe`, absent locally; remaining packages after fail-fast tested separately |
| TS unit suites across completed commands | browser lab 3/3, protocol 4/4, auth 17/17, model client 20/20, compact 14/14, browser bridge 88/89, RDC 8/8, relay 73/73, extension 47/47 |
| Release/candidate/onboarding source and evidence tests | 63 tests: 62 PASS, 0 FAIL, 1 platform skip (case-distinct aliases on Windows) |
| New Windows rollback regression | PASS: copy failure, task failure before/after creation, prior binary/receipt restore, state ownership, overlap denial, legacy upgrade/uninstall denial |
| Packaged MCP launcher regression | PASS under Windows PowerShell 5.1; fixture Node boundary, not a real agent |
| Uninstall isolation/state preflight and authenticated-browser install contract | PASS; registry/process mutation boundaries intercepted where required by these tests |
| Foreign-prefix ownership regression | Direct run correctly refused because a live agent exists; isolated process/task-boundary rerun PASS. Live guard was not weakened. |
| YAML / script syntax | All 9 workflows parsed using isolated PyYAML 6.0.3; new/changed PowerShell parsed, new JS syntax checked |
| `cargo tree --workspace --locked`, authored unsafe scan, `git diff --check` | PASS |

Local environment: Windows x86_64, rustc/cargo 1.98.1, Node 24.19.0, pnpm
10.34.5, Python 3.10.11. No C++ toolchain or Chrome was installed to change that
environment. Real task-registration/startup tests were not run on this occupied
host. The patch's full native/package/hosted gates remain pending.

Existing hosted evidence was fetched and checked live for the **starting tree**:

- [CI 41058437813](https://github.com/muhamedsohaib/Tetherplane/actions/runs/41058437813):
  Windows, Ubuntu and release policy PASS. Windows logs show Rust **162 passed,
  0 failed**, native builds, package/installed-byte verification, PE subsystem
  checks, six-tool/status smoke, least-privilege task settings and no-orphan stop.
- [Store CI 41058438267](https://github.com/muhamedsohaib/Tetherplane/actions/runs/41058438267):
  source and Windows package jobs PASS. Logs show 21 onboarding tests; unpaired
  startup inertness, approved synthetic startup, duplicate-agent denial, parent
  termination cleanup; a real native/loopback-relay test passes owner approval,
  six tools/status, other-account denial, same-identity reconnect and revocation.
  Synthetic-artwork MSIX pack/unpack passed. No signed Store installation occurred.

Neither run contains this new patch. CI used Windows Server 2025, Rust 1.99.1
and Node 22.23.4; it does not certify an interactive Windows 11 desktop.

Read-only authenticated `device.status` calls during this audit returned:

| Target | Observation | Limit |
| --- | --- | --- |
| Leno | `disconnected`: requested device is offline | Version/connectivity of its installed agent not established |
| Surface | Windows x86_64, 0.1.0, `background_only`; authenticated/ready/responsive liveness supplied | Not the new candidate's installed bytes or lifecycle proof |
| RTX | Windows x86_64, 0.1.0, `background_only` | No readiness/liveness object supplied; no candidate provenance |
| VAULTER | Windows x86_64, 0.1.0, `background_only` | No readiness/liveness object supplied; no candidate provenance |

Unqualified `device.list` returned `invalid_arguments` requiring device selection;
that response is not four-device proof. No file/process/browser actions, pairing,
revocations, task changes or identity changes were performed on those devices.

## Reproducible candidate procedure

**Prepared, not executed.** The manual workflow is
`.github/workflows/github-windows-candidate.yml`. It has no tag/push/PR trigger,
no release/contents-write permission, and is restricted to this repository and
review branch. Only build jobs receive OIDC/attestation write permissions;
independent verification/acceptance jobs have read permissions.

1. Finish review of this patch and its stacked ancestry. Run full exact-revision
   CI with C++ tooling and Chrome available on a disposable Windows runner.
   Resolve every failure without skipping tests, weakening security or changing
   deadlines. Record head SHA, tested merge SHA/tree and run/attempt IDs.
2. Obtain separate owner approval before uploading candidate binaries. GitHub
   Actions artifacts in this public repository can be publicly accessible even
   when named quarantine. This task did not grant upload/publication authority.
   GitHub requires a manually dispatched workflow to exist on the default branch;
   registration/integration needs a later owner-approved protected-branch action.
   Do not bypass this by enabling a new automatic push trigger.
3. After that prerequisite, dispatch the reviewed exact branch using:

   ```powershell
   gh workflow run github-windows-candidate.yml --repo muhamedsohaib/Tetherplane --ref work/github-release-readiness-20261030
   ```

   First independently record the branch's full SHA and confirm the resulting
   run's `head_sha` matches it. The workflow checks out `github.sha`; it accepts
   no arbitrary source, URL, credential or execution command input.
4. Two separate fresh `windows-2025` runners build with Rust **1.99.1**, Node
   **22.23.4**, pnpm **10.34.5**, Cargo `--locked` and pnpm's frozen lockfile.
   They remap emitted paths, disable incremental builds and use `/Brepro`.
   Compiler, lockfile, hosted-image, linker-hash and SDK/MSVC identities are
   included inside the archive. Hosted images/SDKs are still mutable inputs;
   retain the recorded versions and reconstruct them for a later rebuild.
5. `github_candidate.py` calls the existing strict file inventory verifier,
   rejects credential-shaped files and writes a sorted ZIP_STORED archive with
   fixed timestamps/modes. `SHA256SUMS` covers archive and external inventory.
   Normalization is not a claim that compiled binaries already reproduce.
6. Both exact unsigned archives receive GitHub/Sigstore provenance. Short-lived
   artifacts are named `UNSIGNED-DO-NOT-INSTALL-{first,second}-<SHA>` with 1-day
   retention. No GitHub Release, tag or installer publication occurs.
7. Ubuntu downloads both, verifies every checksum/archive member, runs
   `gh attestation verify` against the exact repository, signer workflow, source
   ref/digest and hosted-runner policy, and binds the verified subject to the
   exact run/attempt. It then requires byte-identical archives/inventories.
   Any mismatch is **NO-GO**; retain both builds and investigate it.
8. A third fresh Windows runner downloads the first archive without rebuilding,
   independently repeats cryptographic verification **before extraction**, checks
   extracted inventory and all installed runtime files, then tests the installed
   PowerShell MCP entrypoint, six tools/status, outside-root denial, uninstall,
   state preservation and exact-candidate reinstall. The source rollback fixture
   separately exercises copy/task failure recovery. Reinstall is not a
   previous-version rollback test.
9. Save source/run/attempt, both archives, SHA256SUMS, provenance bundles and
   verifier output via an approved evidence channel before retention expires.
   Re-run `gh attestation verify` independently on the retained archive; do not
   trust a supplied verification JSON or checksum as its own trust root.

This establishes a reviewable procedure, not completed reproducibility or
independent verification of a newly built native candidate. There is no new
binary digest to report because no new binary was successfully built.

## Physical and release blockers

- Exact final-revision full Windows/Linux CI, both independent native rebuilds,
  authenticated artifact verification and fresh-host acceptance have not run.
- Publicly trusted Authenticode publisher/key custody, timestamp/revocation
  policy, signed-artifact verification and explicit promotion approval remain
  open. GitHub attestations authenticate build provenance; they provide **no
  Microsoft-trusted Windows code-signing identity**. No self-signing or SignPath
  application was performed. The public unsigned-release block must remain.
- On a new, owner-authorized Windows 11 physical machine with **SAC On**, accept
  the exact trusted signed ZIP/installer or Store-signed MSIX route separately.
  Do not disable SAC/WDAC/Defender or import a self-signed trust root. Record OS,
  signer/publisher, candidate digest, signature result, SAC state and observer.
- Observe download/extraction/MOTW and first-run prompts, clean per-user install,
  actual PowerShell/Node/Rust launch, owner-approved pairing/credential ACLs,
  authenticated status and denied operations outside scope/foreign account.
- For packaged Store startup: owner independently verifies status, opts in using
  Windows Settings, then observes exactly one agent and zero unwanted terminals
  after sign-in, reboot, AC/battery and sleep/wake; open wizard while agent runs;
  terminate owned launcher in the disposable environment and prove no orphan.
  Disable startup and verify no new launch on next sign-in. Test insecure,
  missing and revoked identity failure without repairing or replacing identity.
  This packaged StartupTask does not provide pre-login system-service behavior.
- Accept legacy GitHub scheduled-task startup separately: Limited privilege,
  direct GUI agent ownership, IgnoreNew, battery/restart/reboot/reconnect,
  no duplicate task/agent, no orphan after stop. No live task was activated here.
- Perform normal uninstall/state retention, explicit owned-state purge only on
  disposable data, reinstall, **actual previous-version upgrade and rollback**
  with compatible state, and power-loss/interrupted-operation recovery. The new
  transactional error tests do not certify abrupt process/power termination.
- Inspect effective persisted-result/audit ACLs using a distinct unprivileged
  Windows account, and resolve disclosed retention/replay requirements in
  `MSIX_PRIVACY_PERSISTENCE_SECURITY_REVIEW_20261030.md`. Synthetic ACL inspection
  is not a second-account access-denial test. No speculative retention change
  was made in this task.
- Complete simultaneous **Leno, Surface, RTX, VAULTER** acceptance using approved
  exact-artifact identities: authenticated status, correct routing, local
  denial, cross-account isolation, reconnect without replay, browser permission
  denial/recovery and human-active coexistence. Leno was offline in this audit;
  three successful status reads do not satisfy this gate. Recheck all four.

**Controlled installable developer preview: NO-GO now.** Reconsider only after
the new revision's full gates, two-build/provenance/fresh-host results and an
owner-approved disposable-machine preview scope. Source-only review is ready.

**Public GitHub release: NO-GO.** In addition to preview gates, require trusted
signing/promotion, exact signed physical SAC-On installation, previous-version
rollback, privacy/access acceptance, four-device/human acceptance, stack review
and explicit publication approval. Keep `release.yml` unchanged meanwhile.

Primary references:
[GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations),
[GitHub CLI verification](https://cli.github.com/manual/gh_attestation_verify),
[Rust source-path remapping](https://doc.rust-lang.org/rustc/remap-source-paths.html).
