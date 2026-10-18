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
recovery returned **`disconnected: requested device is offline`**. Remote Desktop
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
| Same-certificate wrong-content replay | Packager 11 passed, 1 failed; different signed code was accepted | Request v2 and native SIP comparison implemented; bounded policy tests pass; native Windows gate required |
| Adapter descendant timeout | 27 passed, 1 failed; child survived parent-only kill | Windows-specific owned process-tree test required |
| Writes racing replacement, rollback removal and final journal commit | 12 passed, 3 failed; actual late-written bytes were lost | 15/15 passed; actual displaced bytes retained and conflicts block another repair |

The first signed-fixture positive tests intentionally modeled signature metadata;
review showed this did not prove that the signed code matched the selected build.
The final design therefore adds native Windows SIP content binding, while
retaining independent full-byte SHA-256 checks for the original request. The
final Windows run must execute native content tests and integration fixtures.

A separate review reproduced archive replacement between hashing and extraction:
14 tests passed and the new substitution test failed. The verifier now retains
the exact checked file stream through extraction; all 15 enforcement tests pass.
Another review reproduced a concurrent write after the final destination hash.
Replacement and rollback now retain the actual displaced bytes and record a
conflict; the earlier ownership snapshot alone cannot preserve that later write.
Each retained filename includes the expected digest, which the next repair
checks even if interruption leaves the journal marked committed. All 15 upgrade
tests pass on PowerShell Core; native Windows gates remain required.

## Fresh repository gates

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
| Three modified signing/release workflows | actionlint passed with the intended custom runner label declared |

The Chromium sandbox remained enabled. `CI` and `GITHUB_ACTIONS` were not spoofed,
and no sandbox bypass or test skip was used to turn the required browser gate
green. The initial Rust run encountered a relocated generated-cache path; only
generated tetherd outputs were cleaned/rebuilt, and the full workspace test run
then passed. Browser/Docker acceptance must be established on suitable CI.

Raw RED/GREEN and broader-gate logs were retained in the execution workspace.
Persistent GitHub run links and their exact source SHA are the authoritative
shareable CI evidence for the pushed revision. Pending results must not be read
as completed acceptance.

## Final pushed-revision evidence

To be completed after the reviewed change is committed, pushed and its required
Windows/Linux workflows finish. The recovered `630b309` green runs above are
not fresh verification of this continuation's changes.

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
