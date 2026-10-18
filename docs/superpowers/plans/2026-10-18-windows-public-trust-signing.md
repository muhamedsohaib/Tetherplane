# Windows public-trust code-signing gate — execution plan

Status: implementation candidate, not a signed release. Owner: Tetherplane.

## Incident evidence (2026-10-18)

- Leno's existing agent installation is `C:\Users\Sohaib\AppData\Local\Programs\Tetherplane\bin\tetherd.exe`.
- Windows Code Integrity event 3077 under `VerifiedAndReputableDesktop` blocked that file after a controlled agent restart; `Get-AuthenticodeSignature` returned `NotSigned`.
- The dedicated `Tetherplane Leno Agent` task was stopped and is `Ready`; the registered device remained offline after the attempted restart.
- Vaulter Funnel public HTTPS returned authenticated HTTP 401 from each of three public edges. Surface's isolated acceptance installation has an independent local credential but is not yet paired.
- The old private Windows device kit is integrity-checked by SHA-256, but it is not Authenticode-signed.

## Requirements

1. Keep Windows Smart App Control and Microsoft Defender enabled; never create exclusions or import an untrusted/self-signed root as a workaround.
2. Preserve all existing device identities, credential files, task definitions, policy grants, and the live relay/OAuth state. Never embed signing secrets in source, logs, ZIPs or a ChatGPT response.
3. Preserve the private unsigned **development/test** kit flow. Add an explicitly opted-in **signed distribution** path that requires a publicly trusted Authenticode signature, the expected publisher identity, and a timestamp.
4. Verify the complete signed ZIP and unpacked executable **before** installation. Fail closed on missing, invalid, altered or mismatched signatures; do not overwrite an unrelated/modified installation.
5. The signing provider is external to the installer: Microsoft Artifact Signing Public Trust (if legally eligible), an approved commercial CA, or an independently reviewed open-source signing program. Azure Public Trust geography is restricted; Private Trust and self-signed certificates do not meet this recovery goal.
6. Never label a kit "signed" or "trusted" on the strength of its SHA-256 manifest alone. No public release, merge, deployment, purchase or remote workstation security change is authorized by this plan.

## TDD implementation and verification

1. Add Pester tests that fail on the existing implementation: unsigned input rejected when trusted packaging is explicitly required; signed metadata is verified even when attacker-controlled manifest hashes are recalculated; publisher and timestamp checks fail closed; legacy dev kit continues to work.
2. Run the Windows onboarding workflow and record the expected test failure.
3. Implement the smallest signed-package switch and signature check using Windows `Get-AuthenticodeSignature`; retain the existing six-tool surface and managed-ownership protections.
4. Rerun the targeted Pester suite, all onboarding tests, real Windows kit packaging/verification, and relay approval tests. Inspect CI logs, not just workflow status.
5. Open a draft PR stacked on the existing unmerged Windows onboarding work. Keep unsigned output PRIVATE and clearly differentiated from a signed distribution.

## Operational acceptance (blocked until a public-trust signer exists)

- Independently verify certificate issuer/chain in a normal Windows trust store, publisher identity, timestamp, and both ZIP/embedded executable digests.
- Prove that signed `tetherd.exe` launches on Leno with Smart App Control **On** and without any security-policy exception.
- Preserve and reuse the existing Leno device credential and principal; launch only the owned dedicated agent task; verify `device(op="status",device="Leno")` through the existing authenticated ChatGPT connection.
- After Leno passes, use the existing authenticated plugin to approve a short-lived pairing code for `SURFACE-ACCEPTANCE-01`; finalize only the isolated Surface install and run acceptance gates.

## Stop conditions

Any signing failure, publisher mismatch, non-public-trust chain, missing timestamp, new Smart App Control block, unexpected device/process ownership, test failure, or inability to verify a real signed executable. Never attempt to fix these by disabling Smart App Control, force-killing unrelated processes, or resetting Vaulter.
