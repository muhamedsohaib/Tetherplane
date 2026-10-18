# Trusted Windows code-signing procedure

Status: **infrastructure awaiting an approved public-trust identity**. This
procedure does not establish that a signed Tetherplane release exists or that
Smart App Control has accepted Tetherplane on any personal device.

## What the pipeline proves

The manual `Windows trusted signing candidate` workflow separates the build,
signing service, and independent Windows verification. It produces a candidate
artifact only after the code is bound to the approved build request and every
shipped code file passes Windows trust verification. It does not publish a
GitHub Release, create a tag, install software on a device, enroll with a
provider, or purchase anything.

Five code files are signed:

| Path | Purpose |
| --- | --- |
| `bin/tetherd.exe` | Agent |
| `launch/tetherplane-agent.ps1` | Background supervisor |
| `setup-windows-device.ps1` | Managed installation |
| `pair-windows-device.ps1` | Expiring-code pairing |
| `doctor-tetherplane.ps1` | Diagnostics |

Signed candidates omit `setup.cmd`: an unsigned command-file bootstrap cannot
provide the same Authenticode assurance as the signed PowerShell entrypoint.
The non-code manifest and connection profile are covered by the final ZIP's
independently obtained SHA-256. A checksum distributed beside an untrusted ZIP
is not, by itself, publisher or provenance evidence.

The default MCP tools remain exactly `device`, `files`, `process`, `browser`,
`desktop`, and `batch`. New device installs remain in `background_only` mode
with the least-privilege `device.status` profile. Signing changes neither the
local policy authority nor device identity or pairing.

## Trust policy

Obtain these values independently of a downloaded candidate:

- The reviewed full source commit SHA.
- The approved publisher's exact X.509 subject distinguished name.
- The approved leaf certificate's 40-hex thumbprint. This identifies the
  certificate; it is not the file-integrity hash algorithm.
- The immutable build request's SHA-256 and the final candidate ZIP's SHA-256.

The verifier requires `Get-AuthenticodeSignature` to report `Valid` and an
embedded `Authenticode` signature, with the exact approved subject and leaf
thumbprint, an explicit code-signing EKU (`1.3.6.1.5.5.7.3.3`), and a verified
timestamp certificate. The independent release verifier also runs Windows SDK
SignTool with `verify /pa /all /tw` and accepts only exit zero. SignTool's
missing-timestamp warning is a failure here, as is any other nonzero result.

Windows makes the timestamp-aware trust decision. The helper does not compare
the leaf certificate's current expiration date to the clock and thereby reject
an otherwise valid timestamped signature. Catalog-only validation is rejected;
this distribution requires an embedded signature on every code file.

Providing a publisher or thumbprint independently requires signing, even if an
attacker removes the manifest's `signature` field and recalculates checksums.
Malformed or whitespace identity inputs cannot select unsigned mode. A signed
manifest cannot provide its own trusted identity.

The v2 kit signing metadata names all five signed paths. Its source tree must
be clean and its source commit must match the independently selected revision.
The build request binds each original file's full SHA-256 and Windows SIP
content digest. Windows SIP knows which bytes belong to the signed subject for
PE and PowerShell files. Comparing that digest before and after signing detects
an adapter that substitutes older or different code signed by the same
certificate; a valid signature alone would not detect that provenance error.

## Approving and provisioning a provider

The orchestration is provider-neutral. An administrator installs the provider
adapter outside the source tree on a dedicated, ephemeral Windows signing
runner. Private keys remain in the approved signing service or secure hardware;
provider authentication is provisioned through that service's approved runner
mechanism. Do not export keys into GitHub, repository files, artifacts or logs.
Do not store provider credentials in GitHub. The adapter must not require a
credential embedded in the timestamp URL.

Possible procurement paths include a publicly trusted commercial Authenticode
certificate with supported hardware or managed signing, or an approved open
source signing program such as SignPath Foundation. Eligibility and identity
validation are provider decisions. A self-signed test certificate, a private
root import or a Windows Security exception is not a public-trust release
solution. No provider is selected or approved by this document.

Relevant provider references:

- [SignPath Foundation](https://signpath.org/) and its
  [terms](https://signpath.org/terms.html): approval is required for the open
  source program; eligibility is not guaranteed.
- [SSL.com individual code signing](https://www.ssl.com/products/software-integrity/code-signing/iv/)
  and [eSigner pricing](https://www.ssl.com/guide/esigner-pricing-for-code-signing/):
  individual validation and managed-signing options; verify the complete quote
  and geographic/identity eligibility before enrollment.

Provider enrollment and any cost require the owner's explicit approval.
Nothing in the workflow purchases or enrolls automatically.

### Runner and environment controls

Before setting readiness, configure `windows-code-signing` as a protected
GitHub environment with a human reviewer and a branch policy that permits the
reviewed `main` branch. Configure the dedicated signing runner with labels
`self-hosted`, `Windows`, `X64`, and `tetherplane-signing`. It must be ephemeral
and unavailable to untrusted pull-request jobs. A label alone does not create
isolation; the runner administrator must enforce it.

The workflow checks the environment protection through GitHub's API, requires
manual dispatch from `main`, and compares the input source SHA both to the
workflow commit and the current `main` head. It fails explicitly if readiness,
identity, adapter configuration, protection or source evidence is missing.
Environment review is still required for the actual signing job.

Configure these **non-secret repository variables** only after provisioning:

| Variable | Value |
| --- | --- |
| `TETHERPLANE_SIGNING_READY` | Literal `true` only after provider and protections are ready |
| `TETHERPLANE_PUBLISHER_SUBJECT` | Independently approved exact certificate subject |
| `TETHERPLANE_SIGNER_THUMBPRINT` | Independently approved 40-hex leaf fingerprint |
| `TETHERPLANE_SIGNING_ADAPTER_PATH` | Administrator-installed absolute `.ps1` path on the signing runner |
| `TETHERPLANE_SIGNING_ADAPTER_SHA256` | Independently approved 64-hex adapter hash |
| `TETHERPLANE_TIMESTAMP_URL` | Approved HTTP(S) RFC3161 timestamp endpoint without credentials, query or fragment |

Certificate renewal requires a reviewed change to the approved fingerprint.
An existing signed installation intentionally refuses an implicit switch to a
different certificate. Its ownership receipt and rollback plan must be reviewed
as part of an explicit signing-identity migration.

### Adapter contract

The approved adapter is a PowerShell script accepting `-Path` and
`-TimestampUrl` as literal parameters. It signs only that supplied file with the
approved certificate and a SHA-256 file digest plus RFC3161 SHA-256 timestamp,
using the provider's supported equivalent of SignTool `/fd SHA256 /tr ... /td
SHA256`. Exit zero means signing succeeded. Warnings, failure, timeout, modified
unrequested files or content differing from the request prevent output.

The orchestration validates the adapter's path/hash and the entire fixed
request before starting it. The adapter runs in a bounded child process against
isolated copies. Its output streams are suppressed, and diagnostics avoid
provider output. The original unsigned payload is preserved. Timeout handling
terminates only the adapter's owned process tree. Treat the adapter as privileged
signing code: review it, pin it and provision its least-privilege access outside
this repository. The orchestrator never evaluates arbitrary provider command
text from a GitHub variable or artifact.

## Candidate flow

1. A clean hosted Windows builder checks out the exact reviewed revision, runs
   the Rust/onboarding gates, and builds `tetherd.exe` with the locked dependency
   graph. It stages the five source files and creates the data-only signing
   request. The request's SHA-256 is passed independently as a job output.
2. After protected-environment approval, the dedicated signer checks out only
   reviewed orchestration helpers. It treats downloaded files as data, validates
   the request and payload, invokes the pinned external adapter, and verifies
   that the signed subject of every result matches the approved request. Its
   artifact is explicitly labeled as unverified signer output.
3. A fresh hosted Windows verifier validates the original request and signed
   content again, then checks every signature against the independent publisher
   and certificate with Windows trust and SignTool.
4. The packager verifies the code before and after copying it, proves that the
   staged bytes remain unchanged, writes the v2 manifest and final file hashes,
   then creates the ZIP and ZIP checksum. A signed output directory or archive
   is never silently overwritten.
5. The trusted ZIP verifier validates the exact archive bytes, authenticates
   every code file before loading package code, and supports `-VerifyOnly` for
   a check that executes no code from the package. The full hosted test then
   installs into an isolated temporary prefix and requires the real agent to
   answer `device.status` with `background_only` policy.
6. Only successful verification uploads the immutable, source-named candidate
   ZIP and checksum. This is not evidence of Smart App Control acceptance on
   Leno or Surface.

### Manual invocation after signing is provisioned

Use a trusted clean checkout and independently obtained values. The following
commands are a template; the variables refer to already approved inputs and do
not obtain a key or contact a provider themselves.

```powershell
$package = @{
    OutputPath = Join-Path $env:TEMP 'tetherplane-reviewed-candidate'
    TetherdPath = Join-Path $signedPayload 'bin/tetherd.exe'
    SkipBuild = $true
    Zip = $true
    RequireTrustedSignature = $true
    ExpectedPublisherSubject = $publisher
    ExpectedSignerThumbprint = $thumbprint
    ExpectedSourceCommit = $sourceCommit
    SignedPayloadPath = $signedPayload
    SigningRequestPath = $requestPath
    ExpectedSigningRequestSha256 = $requestSha256
    UnsignedPayloadPath = $unsignedPayload
}
& ./scripts/package-windows-device-kit.ps1 @package

$verification = @{
    ZipPath = $package.OutputPath + '.zip'
    RequireTrustedSignature = $true
    ExpectedPublisherSubject = $publisher
    ExpectedSignerThumbprint = $thumbprint
    ExpectedSourceCommit = $sourceCommit
    ExpectedZipSha256 = $approvedZipSha256
    SignToolPath = $approvedWindowsSdkSignTool
}
& ./scripts/verify-windows-device-kit.ps1 @verification -VerifyOnly
& ./scripts/verify-windows-device-kit.ps1 @verification
```

Keep output and signing payloads outside the source checkout. Otherwise
untracked output can make the required clean-source check fail. Never change a
signed script's line endings, encoding or content after signing.

The existing unsigned developer kit remains available when trusted-signing
inputs and switches are omitted. It has no signed-release metadata and retains
its development bootstrap. It must not be described as publicly trusted or
Smart-App-Control-compatible. The old public Windows release workflow now
fails before uploading its unsigned Windows binaries; this prevents the
preexisting release path from bypassing the new signing requirement.

## Existing installation preservation

New managed receipts use version 2 and record the SHA-256 of all seven managed
files plus the persistent signing requirement and approved identity. Before an
upgrade or repair, the installer compares all existing managed bytes with their
receipt. Missing managed files may be repaired. Edited files, foreign receipts,
redirected paths and inconsistent ownership evidence are rejected before
replacement. Unknown files, agent arguments, device state and credentials are
not part of the replacement set.

A transaction stages and verifies the complete candidate, saves the previous
managed files and receipt, replaces files atomically one at a time, and writes
the receipt last. It checks for concurrent writes before each change and during
rollback. If a later copy or receipt update fails, it restores the prior managed
bytes. If a human changed a file meanwhile, it preserves that change and refuses
a subsequent automatic repair until the conflict is reviewed.
Each atomic replacement retains the actual displaced file, including writes
that occur after the final pre-replacement hash. Rollback removal similarly
moves files into retained evidence. A mismatch records `needs_recovery` and
reports the preserved path; it never silently discards the unexpected bytes.

Recovery records live in a sibling directory:

```text
<install-prefix>.tetherplane-upgrades/
  owner.json
  upgrade-<unique-id>/
    journal.json
    candidate/
    candidate-install.json
    backup/
    displaced/
```

The backup contains managed program files and the old install receipt, not the
device credential or arbitrary user state. `committed` and `rolled_back`
journals permit later repairs only when retained displacement hashes match
their expected digests. The digest is also recorded in each retained filename,
so an interruption after replacement cannot hide a conflict behind a final
journal status. `preparing`, `applying`, `needs_recovery`,
malformed journals or unknown recovery entries stop the next update and report
the retained path. Do not delete that evidence to force a repair.

For recovery, inspect the journal and verify backup hashes against its recorded
prior files. Revalidate current file hashes and the exact owned task/process
identities before touching an installed agent. Restore only files whose
ownership and current state are established; preserve every unexpected write.
Check the final installed hashes and original receipt before closing the
recovery. These safeguards provide file rollback, not an atomic switch of every
file at once; an in-use or protected binary can still cause a safe failure.

### Legacy Leno and Surface installations

Legacy receipts that prove only the executable's digest are insufficient to
claim ownership of all installed scripts. The new installer deliberately refuses
to adopt or overwrite them. Preserve their existing files, credentials and
metadata and reconcile them against their historical package and task evidence
before a separately reviewed migration or controlled binary-only replacement.
Do not manufacture a version 2 receipt merely to make the check pass.

For Leno, restore only after a genuinely trusted candidate and an approved
execution path are available. Confirm the source and independent archive hash,
Windows trust, actual installation ownership and the exact
`\Tetherplane Leno Agent` task action. Preserve rollback material without
exposing credentials. Start only that dedicated task, confirm exactly one agent
and an authenticated relay registration, then call the existing authenticated
plugin with `device(op="status", device="Leno")`. Require `background_only`
and actual Smart App Control On launch evidence, including relevant Code
Integrity events. Historical PIDs are not current ownership evidence.

Do not alter Smart App Control, security exclusions, firewall policy, Vaulter,
Tailscale Funnel, OAuth clients or device registrations. A successful hosted
Windows test is not a substitute for acceptance on Leno.

Only after Leno is online should `SURFACE-ACCEPTANCE-01` continue pairing through
an expiring code and the existing authenticated six-tool plugin. Preserve its
isolated identity and credential, its dedicated acceptance paths and the legacy
Surface installation. Surface is not accepted merely because its package was
installed previously.

## Validation and authoritative references

`windows-signature-policy.yml` runs focused regressions with both Windows
PowerShell 5.1/Pester 3.4 and PowerShell 7/Pester 4.10.1. The full Windows
onboarding gate additionally exercises the real agent, Windows ACLs, scheduled
tasks and the packaged ZIP. Mocked signature metadata tests prove policy
behavior; native SIP tests prove content-binding behavior; neither claims that
a public-trust signing identity has been provisioned. All required Windows
checks must run without skipped or inconclusive tests.

- [Microsoft SignTool reference](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
- [Get-AuthenticodeSignature](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature?view=powershell-7.6)
- [Smart App Control signing](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control)
- [Testing with Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Pester 4 assertion compatibility](https://pester.dev/docs/v4/commands/Should)

See `SIGNING-RECOVERY-20261018.md` for this continuation's actual recovery,
verification evidence and operational blockers.
