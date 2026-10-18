# Trusted Windows agent code-signing procedure

Status: **preparation**, not a signed release, deployment approval, or
credential/certificate enrollment.

## Recovery context

On 2026-10-18 Leno's Code Integrity event 3077
(\`VerifiedAndReputableDesktop\`) blocked the unsigned installed
\`tetherd.exe\`. The dedicated \`Tetherplane Leno Agent\` scheduled task was
stopped after its existing agent could not relaunch. The private Windows
device-kit SHA-256 checks provide integrity but **not publisher trust**.

## Trust requirements and signing choices

Use an Authenticode code-signing identity from a public CA in Microsoft's
Trusted Root Program. A self-signed certificate, private-trust-only
certificate, custom trusted-root import, Windows Security exclusion, or
disabling Smart App Control does not meet this release gate.

Candidates: a commercial CA code-signing certificate, Microsoft's Azure
Artifact Signing **Public Trust** only for eligible individuals/organizations
(geographic restrictions apply), or SignPath Foundation's free OSS
program *if the project is approved*. Tetherplane has an open-source license
and a published \`v0.1.0\` GitHub release, but no free-signing approval has
been granted. Signing-provider access, identity validation, purchase, or
external application requires separate authorization.

## Steps on a trusted Windows build/release environment

1. Verify exact canonical source commit and clean Git state; run repository
   quality gates; build \`cargo build --release -p tetherd\`.
2. Use the authorized code-signing provider to **sign that final
   \`target\release\tetherd.exe\`** with a trusted certificate and RFC3161
   timestamp. Keep keys outside source/GitHub artifacts/logs; do not rebuild
   the binary after signing.
3. Independently establish the legitimate publisher's **exact X.509 subject
   DN** (do not blindly copy it from an unknown executable). Windows
   \`Get-AuthenticodeSignature\` must report \`Valid\`, embedded
   \`Authenticode\`, the expected subject and a timestamp certificate.
4. Generate the separately labeled signed kit (no auto-deployment):

   \`\`\`powershell
   $publisher = '<independently approved exact X.509 subject DN>'
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-windows-device-kit.ps1 -OutputPath dist/tetherplane-signed-device-kit -TetherdPath target\release\tetherd.exe -SkipBuild -RequireTrustedSignature -ExpectedPublisherSubject $publisher -Zip
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-windows-device-kit.ps1 -ZipPath dist/tetherplane-signed-device-kit.zip -RequireTrustedSignature -ExpectedPublisherSubject $publisher
   \`\`\`

5. Preserve ZIP SHA-256, signed executable digest, source commit, signer
   thumbprint/subject, timestamp and independently witnessed CI results.

The signed packaging mode refuses unsigned, invalid, unexpected-publisher,
catalog-only and missing-timestamp signatures. Signed-kit manifests include
the subject/thumbprint and require an independently confirmed
`-ExpectedPublisherSubject` during managed installation. A kit manifest is
untrusted input: the installer rejects signed claims if this external
publisher pin is absent or does not match. The \`-RequireTrustedSignature\` verifier switch
prevents an unsigned private test kit being misrepresented as signed.
\`Get-AuthenticodeSignature\` validates against the current Windows trust
store; final **Smart App Control On** acceptance on the actual controlled
machine is mandatory.

## Leno restoration is separately gated

Leno has an existing installation with legacy task and receipt ownership.
The modern installer **must not** overwrite a prefix it cannot establish
ownership of. Do not copy another device's credential or replace OAuth/relay
registrations. Before any update, inspect binary provenance, hash, receipt,
ACLs, dedicated scheduled-task action and preserved device credential path
without exposing secrets. Stage a verified signed replacement separately,
preserve rollback, obtain deployment approval, and require green real-world
Smart App Control On launch + authenticated
\`device(op="status",device="Leno")\`.

Only after Leno is verified online should \`SURFACE-ACCEPTANCE-01\` be paired
through the existing authenticated six-tool plugin.
