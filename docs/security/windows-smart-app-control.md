# Windows Smart App Control: signed Tetherplane mesh distribution

**Status:** Signing-ready source workflow only. No trusted certificate has been
provisioned and no Smart App Control-compatible download has been published.

## Why the downloadable batch file was blocked

Windows Smart App Control blocked the downloaded
`Inspect-Tetherplane-Mesh.cmd` with a warning that executable files of this
type from the Internet can be dangerous. SHA-256 checksums prove file identity;
they **do not** grant Windows publisher trust. An embedded Authenticode signature
from a trusted certificate authority (CA) is the supported publisher-trust
path. A batch launcher cannot carry the required embedded Authenticode
signature, so the **signed** distribution omits the two `.cmd` entrypoints.

Windows still makes the final execution decision. A self-signed certificate,
a local certificate trust exception, `Unblock-File`, execution-policy bypass,
and disabling Smart App Control are not signing substitutes.

Official guidance:
- https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control
- https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview
- https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-authenticodesignature

## Trusted signing identity: external prerequisite

Select one **before claiming the release is signed**:

1. **SignPath Foundation (free OSS signing, subject to approval):**
   https://signpath.org/ . The maintainers must apply, satisfy its open-source,
   release, origin-verification, MFA and approval policies, and obtain an
   accepted signing configuration. Admission is not automatic. Each signed
   release needs manual approval. No application or identity verification has
   been submitted by the Tetherplane automation in this workflow.
2. **A publicly trusted code-signing certificate:** The authorized publisher
   controls the key in an appropriate signing service or secure store. Never
   place private keys or PFX passphrases in Git, runner logs or chat.
3. **Microsoft Artifact Signing:** A paid Azure service requiring identity
   validation, eligibility and separately authorized billing.
   https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart

No paid account creation, signing request or public release is automatic.

## Reproducible signing handoff

1. Produce the tested Windows x64 package from an exact source commit through
   `.github/workflows/four-device-mesh-bootstrap.yml`. Its Action artifact is
   explicitly an **unsigned pilot** and should not be advertised as safe to
   launch on a Smart App Control-enforced computer.
2. Have the approved signing provider sign each Tetherplane-authored payload,
   preserving its relative location within the staged folder:
   `bin/tetherd.exe`, `Join-Tetherplane-Mesh.ps1`,
   `Inspect-Tetherplane-Mesh.ps1`, `Uninstall-Tetherplane-Mesh.ps1`,
   `install-windows.ps1`, `uninstall-windows.ps1`,
   `install-model-worker-windows.ps1`, `launch/tetherplane-agent.ps1`, and
   `launch/tetherplane-mcp.ps1`. Do not re-sign upstream libraries,
   dynamically downloaded code or user scripts with the project's identity.
   The provider must attest verified build provenance, not simply accept an
   arbitrary unsigned ZIP.
3. On an authorized Windows signing/release runner, finalize **after** all
   signatures are applied:

   ```powershell
   .\scripts\finalize-windows-mesh-signed.ps1 `
       -SignedPackagePath "C:\signing\signed-input" `
       -OutputPath "C:\signing\Tetherplane-Mesh-Signed-Windows-x64"
   ```

   The finalizer requires Authenticode status `Valid` for every required
   first-party code file, matching publisher certificate thumbprints and
   verified source manifest identity. It refuses untrusted input **before**
   copying. It then recomputes hashes *after signing*, marks the copied
   manifest as signed, removes only the two downloaded batch launchers,
   re-verifies the package and emits a ZIP plus SHA-256 checksum file.
4. The independent read-only gate for the resulting folder is:

   ```powershell
   .\scripts\verify-windows-mesh-signatures.ps1 `
       -PackagePath "C:\signing\Tetherplane-Mesh-Signed-Windows-x64"
   ```

   Trust verification alone is insufficient to claim Smart App Control
   compatibility. A user must also verify launch behavior with Smart App
   Control *on* and without elevated privileges or security-policy changes.

## Operator workflow for a verified signed ZIP

Verify the distribution checksum and trusted publisher, extract normally, and
use Windows PowerShell from inside the extracted signed folder:

```powershell
powershell.exe -NoProfile -File .\Inspect-Tetherplane-Mesh.ps1
```

Only after inspection and existing-device pairing checks, invoke the separate
signed enrollment entrypoint with an operator-approved identity:

```powershell
powershell.exe -NoProfile -File .\Join-Tetherplane-Mesh.ps1
```

There is no `-ExecutionPolicy Bypass` step in the signed operator workflow.
If Smart App Control blocks a signed file, **stop** and inspect the certificate
and Windows event rather than lowering protection.

Do **not** attempt the mesh installer on Vaulter until its original relay
supervision is proved stable. Leno's existing emergency connection must be
preserved; new mesh pairing is a separate authenticated approval flow.

Do not create the public `v0.1.0` tag until
`docs/live-acceptance.md` passes operator-observed and remote-plane proof.

## Signing eligibility and disclosure

SignPath Foundation's open-source program additionally requires a public
signing policy, documented release ownership, reviewed build provenance and a
published project. The application must accurately disclose that using
Tetherplane's remote plane transmits authenticated commands and responses
through the configured relay. Tetherplane does **not** promise that a relay
cannot see traffic it terminates. Do not describe the software as offline-only.

Until external trusted signing credentials and provider approval exist, all
produced ZIPs remain **unsigned test artifacts** regardless of their CI or
SHA-256 verification status.
