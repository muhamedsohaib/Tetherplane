# Windows signing recovery — 18 October 2026

## Recovered source and device state

The interrupted implementation was recovered from GitHub on branch
`feature/windows-repeatable-onboarding-signed-kit-20261018`, head
`630b3093666d6a172151590e0ec5950a47dcbff9`, in
[draft PR #16](https://github.com/muhamedsohaib/Tetherplane/pull/16). Its base is
`fix/windows-uia-selection-notify-20261017` at
`862468aafb91e31155b0a0266b2ee2b44da1a0ae`. The existing eight signing commits
were retained. Main was `5feee084eb24bfd4831ab42840bb5f10dafc8113` when inspected.

At the recovered head, the CI, Windows Authenticode policy and Windows kit
workflow runs were green. Those results predate the continuation changes:

- [CI 39094850187](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39094850187)
- [Signature policy 39094850161](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39094850161)
- [Windows kit 39094846904](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39094846904)

The recovered code contained signature gates and tests, but no signing pipeline.
Its verifier loaded an extracted setup script before validating trust, signing
metadata could be removed to evade the expected-publisher requirement, only the
agent executable was checked, and managed repair lacked complete per-file
ownership evidence and transactional rollback. The old public release path also
uploaded unsigned Windows binaries.

The native authenticated `device(op="status", device="Leno")` call made during
recovery, and repeated at approximately **05:44 UTC on 18 October 2026**, returned
**`disconnected: requested device is offline`**. Remote Desktop
Commander reported **0% calls remaining**. Leno's canonical repository at
`C:\Users\Sohaib\source\Tetherplane` and any uncommitted local changes were
therefore not inspectable. Work continued in an isolated checkout of the
recovered GitHub branch. No execution on Leno is claimed.

No live device, task, process, security setting, relay configuration, OAuth
client, pairing registration or credential was changed during this engineering
continuation. No signing provider was enrolled, purchased or provisioned.

## Implemented changes

The change set completes provider-neutral candidate orchestration, independent
publisher/certificate policy, signing-content provenance, immutable packaging,
ZIP validation before code execution, and ownership-preserving managed upgrades.
See [WINDOWS-CODE-SIGNING.md](WINDOWS-CODE-SIGNING.md) for the operational contract,
provider setup, exact signing inputs and rollback procedure.

The manual signing workflow is deliberately not dispatched. It requires the
approved current main revision, an explicitly provisioned identity and adapter,
a protected environment and a dedicated ephemeral Windows signing runner.
Readiness is a failing prerequisite, not a silent skip. No workflow publishes a
signed release or claims Smart App Control compatibility automatically.

## TDD evidence recorded during the continuation

Tests were written and observed failing before the corresponding substantial
implementation. Early policy tests used unchanged Pester 3.4 in an isolated
Linux harness with throw-only declarations for unavailable Windows APIs.
Subsequent Core testing uses unchanged Pester 4.10.1; no Windows trust result is
inferred from mocked metadata.

| Regression group | Observed RED | Targeted GREEN / status |
| --- | --- | --- |
| Independent signature requirements, all code, EKU, trusted ZIP loader, SignTool warning | 0/13 passed; metadata removal accepted and an altered setup marker executed | 13/13 passed after implementation |
| Whitespace identity cannot fall back to unsigned | 13 passed, 1 failed; unsigned acceptance reproduced | 14/14 passed |
| Initial provider-neutral request and adapter | 0/27 passed; helpers absent | 27/27 passed before additional review findings |
| Initial staged signed packaging | 0/11 passed; required interface absent | 11/11 passed before provenance strengthening |
| Managed-file preservation, rollback and persisted signing requirements | Initial 1 passed, 10 failed | 12/12 passed after concurrent-change regression |
| Core runner must report failure/empty/inconclusive correctly | 0/4 passed; removed Get-WmiObject prevented import | 4/4 passed with pinned Pester 4.10.1 on Core |
| Same-certificate wrong-content replay | Packager 11 passed, 1 failed; different signed code was accepted | Request v2 and native SIP comparison implemented; all 12 package tests and 39 pipeline tests pass on both Windows engines |
| Adapter descendant timeout | 27 passed, 1 failed; child survived parent-only kill | Owned process-tree termination passes in the native Windows pipeline suite on both engines |
| Writes racing replacement, rollback removal and final journal commit | 12 passed, 3 failed; actual late-written bytes were lost | 15/15 passed; actual displaced bytes retained and conflicts block another repair |
| Native PowerShell script SIP SHA-256 | Both Windows engines: 37 passed, 2 failed; diagnostic regression exposed `0x80090008` (`NTE_BAD_ALGID`) | Explicit SHA-256-capable hashing context; 39/39 pipeline tests pass on both engines |
| Windows PowerShell fixture compatibility | Desktop enforcement failed resolving `Get-FileHash`; Pester 3 upgrade harness reproduced 13 passed, 2 failed because the later mock wrappers were overwritten | Accept the real cmdlet/function forms and load the setup fixture once per Describe; 15/15 enforcement and 15/15 upgrade tests pass on both Windows engines |

The first signed-fixture positive tests intentionally modeled signature metadata;
review showed this did not prove that the signed code matched the selected build.
The final design therefore adds native Windows SIP content binding, while
retaining independent full-byte SHA-256 checks for the original request. The
final Windows runs execute native content tests and integration fixtures; all
94 required policy tests pass on each engine, with zero skipped tests.

A separate review reproduced archive replacement between hashing and extraction:
14 tests passed and the new substitution test failed. The verifier now retains
the exact checked file stream through extraction; all 15 enforcement tests pass.
Another review reproduced a concurrent write after the final destination hash.
Replacement and rollback now retain the actual displaced bytes and record a
conflict; the earlier ownership snapshot alone cannot preserve that later write.
Each retained filename includes the expected digest, which the next repair
checks even if interruption leaves the journal marked committed. All 15 upgrade
tests pass on both real Windows engines and under Pester 3 and 4 in the local
regression harness.

The first real Windows run exposed a native SIP error that portable mocks could
not establish. A diagnostic regression preserved the Windows error before the
hashing fix. At `28c955c`, both engines passed the PE cases but failed the two
PowerShell script cases, reporting `NTE_BAD_ALGID`. Supplying an explicit
`PROV_RSA_AES` context with a null container and `CRYPT_VERIFYCONTEXT |
CRYPT_SILENT` corrected the script SHA-256 calculations. The context is held
through both SIP calls and released in `finally`; no persistent key container
is created or signing key accessed. At `eca4007`, native pipeline tests passed
39/39 on both engines. The final `8415ee0` test-harness corrections preserved
every race injection and assertion while making the full policy gate pass on
Windows PowerShell 5.1 and PowerShell 7.

## Fresh local repository gates

The following were executed during this continuation in the isolated checkout:

| Gate | Result |
| --- | --- |
| Frozen pnpm installation, Node 22.23.3 / pnpm 10.34.5 | Pass |
| Rust format | Pass |
| Rust Clippy | Pass |
| Rust workspace tests | **132 passed, 0 failed, 0 ignored** |
| Unsafe-code scan | Pass |
| Recursive TypeScript typecheck | Pass |
| Recursive TypeScript build | Pass |
| Auth package | 82/82 passed |
| Browser Lab | 3/3 passed |
| Protocol | 4/4 passed |
| Compact MCP | 17/17 passed |
| Model-client | 20/20 passed |
| RDC compatibility adapter | 8/8 passed |
| Browser extension | 47/47 passed |
| Relay | 154 passed, 1 failed, 0 skipped; required Chromium sandbox launch blocked |
| Recursive Node tests | Blocked in browser-bridge; three sandbox launch failures, then its fixture kept the process alive; owned test subtree terminated after 187 seconds, recorded exit -15 |
| Required Chromium callback test | 1 failed, 0 skipped; root container cannot launch Chromium with its sandbox |
| Docker production image gates | Not run locally: Docker unavailable |
| All four modified signing/release/kit workflows | actionlint passed with the intended custom runner label declared |

The Chromium sandbox remained enabled in the local container. `CI` and
`GITHUB_ACTIONS` were not spoofed,
and no sandbox bypass or test skip was used to turn the required browser gate
green. The initial Rust run encountered a relocated generated-cache path; only
generated tetherd outputs were cleaned/rebuilt, and the full workspace test run
then passed. The browser and Docker gates were subsequently exercised in CI,
as recorded below.

Raw RED/GREEN and broader-gate logs were retained in the execution workspace.
Persistent GitHub run links and their exact source SHA are the authoritative
shareable CI evidence for the pushed revision. Pending results must not be read
as completed acceptance.

## Final pushed-revision evidence

The implementation was committed and pushed without rewriting history:

| Commit | Change |
| --- | --- |
| [`9fd5eab`](https://github.com/muhamedsohaib/Tetherplane/commit/9fd5eabeca524853e996a4e741194c038814e460) | Provider-neutral pipeline, independent signature gates, content provenance and managed-upgrade preservation |
| [`28c955c`](https://github.com/muhamedsohaib/Tetherplane/commit/28c955cef017d49a8d9473debf9cadd727d431f4) | Diagnostic regression exposing the actual native SIP error |
| [`eca4007`](https://github.com/muhamedsohaib/Tetherplane/commit/eca4007d536e196136b9b729dba52f079a6e09e2) | Explicit SHA-256-capable Windows SIP hashing context |
| [`8415ee0`](https://github.com/muhamedsohaib/Tetherplane/commit/8415ee030f45519ce00f5293842b2b10439557f8) | Windows PowerShell/Pester fixture portability and kit-workflow coverage for Windows helpers |

The exact implementation revision verified below is
**`8415ee030f45519ce00f5293842b2b10439557f8`**. This evidence record is a
documentation-only follow-up to that code revision. The recovered `630b309`
green runs above are historical, not verification of the new implementation.

Push jobs checked out the exact implementation commit. PR jobs checked out
GitHub's synthetic merge `02844925f69a63a5d710eed5e319c32ce7a5b80a`, whose
parents are the unchanged base `862468a` and `8415ee0`. Its tree is identical to
the implementation tree, `0d2983b6b54868b0288e51ce9bc8602264221bfc`;
the PR evidence therefore exercises the same source content.

| Fresh gate | Evidence and result |
| --- | --- |
| Windows signature policy, push | [Run 39100886636](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39100886636): **94/94 passed on each engine, 0 failed, 0 not run** |
| Windows signature policy, PR | [Run 39100889511](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39100889511): both engine jobs successful |
| Full Windows onboarding kit | [Run 39100886667](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39100886667), [kit job 117596744143](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39100886667/job/117596744143): **143/143 passed, 0 failed, 0 not run**; real package/install/agent verification passed |
| Relay approval | Same kit run, [job 117596743857](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39100886667/job/117596743857): **15/15 passed, 0 skipped** |
| Linux repository quality | [Push run 39100886687, job 117596744011](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39100886687/job/117596744011): **successful**; Rust **132 passed, 0 failed, 0 ignored**; Node **458 total, 447 passed, 0 failed, 11 skipped**; format, Clippy, typecheck, builds and unsafe scan passed; both production Docker images built |
| Windows repository quality, PR | [Run 39100889531, job 117596753596](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39100889531/job/117596753596): **successful**; Rust **140 passed, 0 failed, 0 ignored**; Node **458 total, 451 passed, 0 failed, 7 skipped**; format, Clippy, typecheck, builds, unsafe scan and release build passed; full onboarding **143/143 passed, 0 not run**; `SIX_TOOL_SMOKE_OK` and `WINDOWS_PACKAGE_SMOKE_OK` |
| Windows repository quality, push | [Run 39100886687, job 117596744124](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39100886687/job/117596744124): **successful** at exact `8415ee0`; Rust **140 passed, 0 failed, 0 ignored**; Node **458 total, 451 passed, 0 failed, 7 skipped**; full onboarding **143/143 passed, 0 not run**; `SIX_TOOL_SMOKE_OK` and `WINDOWS_PACKAGE_SMOKE_OK` |
| Real Chromium OAuth callback | [PR run 39100889531](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39100889531): Ubuntu [117596753517](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39100889531/job/117596753517) and Windows [117596753689](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39100889531/job/117596753689) each **10/10 passed, 0 failed, 0 skipped** |

Both complete repository CI runs finished successfully. The push Windows smoke
markers were emitted at 05:47:02 and 05:47:05 UTC, respectively. The PR's Linux
quality job also passed the same Linux Rust/Node counts and both Docker builds.

The focused policy jobs used Windows PowerShell **5.1.26100.33438 / Pester
3.4.0** and PowerShell **7.6.6 / Pester 4.10.1**. Each ran 39 pipeline, 9
onboarding-signing, 15 enforcement, 12 package, 15 upgrade and 4 runner tests.
The native cases exercised actual Windows SIP behavior on signed/unsigned PE
and PowerShell files, including content mutation and genuine signature removal.
Certificate-policy fixtures still mock trust metadata; their successful cases
do not represent a newly signed Tetherplane executable.

The Linux Node skips comprise ten Windows-only end-to-end tests and the ordinary
relay Chromium test; its required real-browser counterpart passed all ten
iterations in the dedicated CI job. Windows reports seven existing Node skips:
the ordinary relay Chromium test and six opt-in/live-desktop end-to-end cases.
The dedicated Windows Chromium job also passed all ten required iterations.
That existing Linux Chromium job uses its
explicit, disposable-runner-only browser sandbox option. It is not evidence
that the local container's sandbox restriction was bypassed or that a production
browser policy changed.

The kit verification logged a clean source tree and the real agent as
`windows/x86_64`, with `policy=background_only`. Its **unsigned development
artifact** is
[`tetherplane-device-kit-8415ee030f45519ce00f5293842b2b10439557f8`](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39100886667/artifacts/12126413119),
artifact ID **12126413119**. The inner device-kit ZIP SHA-256 is:

```text
bd33746f9c55c312d52a9a97d339b1990cda8fc71e5434c5e1b162448b1ab6cb
```

The GitHub artifact wrapper has its own different digest. Neither checksum
establishes publisher trust. This developer kit is not a Leno recovery candidate
under the required Smart App Control policy.

Independent review of the complete implementation and the native/compatibility
follow-ups found no remaining concrete must-fix issue. Review checked provider
context ownership, retained file locks, digest validation, unchanged regression
assertions, and the final workflow trigger. It did not stand in for CI execution.

## Operational blockers and next authorized work

1. **Public-trust signing identity and provider approval:** no approved identity,
   provider adapter, secure runner authentication or signing service has been
   provisioned. Provider enrollment and costs require explicit owner approval.
2. **Protected execution infrastructure:** configure and independently verify the
   environment and ephemeral signing runner, then enable readiness. Merge/review
   the intended source through the existing PR process before manual signing of
   current main. The feature branch is not a production signing source.
3. **Genuine candidate:** run the complete build/sign/independent-verification
   workflow and preserve exact source, request, certificate, timestamp and ZIP
   evidence. Mocked policy tests cannot supply this artifact.
4. **Leno restoration:** obtain the approved execution path, reconcile canonical
   local changes, inspect exact legacy installation/task ownership, preserve
   rollback, and perform only the intended controlled replacement. Require live
   launch with Smart App Control On and authenticated Leno `device.status` with
   `background_only` before claiming recovery.
5. **Surface:** `SURFACE-ACCEPTANCE-01` remains prepared but unpaired. Continue
   only after Leno is verified online, preserving its isolated local identity,
   protected credential, dedicated acceptance paths and legacy installation.

The historical Leno Code Integrity event 3077 (`VerifiedAndReputableDesktop`),
unsigned binary hashes, stopped/ready dedicated task, and Surface package
revision/hash remain incident evidence supplied in the handoff. Their current
on-disk state was not reverified through the offline device. No historical PID
is treated as a current process identity.
