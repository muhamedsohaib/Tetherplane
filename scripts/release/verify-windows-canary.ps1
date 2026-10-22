param(
    [Parameter(Mandatory = $true)]
    [string]$PackageRoot,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedCommit,
    [Parameter(Mandatory = $true)]
    [string]$ApprovedSignerThumbprint,
    [Parameter(Mandatory = $true)]
    [string]$OutputManifest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Read-only verification of an independently signed package. Does not sign,
# install, deploy, change trust stores, load secrets, or touch live services.
$root = (Resolve-Path -LiteralPath $PackageRoot -ErrorAction Stop).Path
$manifestPath = Join-Path $root 'manifest.json'
$binary = Join-Path $root 'bin\tetherd.exe'
foreach ($required in @($manifestPath, $binary)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Canary package missing mandatory artifact"
    }
}
$package = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ([string]$package.source_commit -cne $ExpectedCommit) {
    throw 'Canary source commit does not match the approved expected commit'
}
$signature = Get-AuthenticodeSignature -LiteralPath $binary
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
    throw 'Canary executable signature is missing or invalid'
}
$actualSigner = $signature.SignerCertificate.Thumbprint.ToUpperInvariant()
$expectedSigner = ($ApprovedSignerThumbprint -replace '[^0-9a-fA-F]', '').ToUpperInvariant()
if ($expectedSigner.Length -ne 40 -or $actualSigner -cne $expectedSigner) {
    throw 'Canary executable signer is not the independently approved certificate'
}
$rows = @(Get-ChildItem -LiteralPath $root -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($root, $_.FullName).Replace('\', '/')
        [pscustomobject]@{
            relative_path = $relative
            size_bytes = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    })
$outputFull = [IO.Path]::GetFullPath($OutputManifest)
if ($outputFull.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Write the attestation outside the package to avoid self-referential hashes'
}
$attestation = [ordered]@{
    kind = 'tetherplane-windows-canary-preparation'
    source_commit = $ExpectedCommit
    signature_status = [string]$signature.Status
    signer_thumbprint = $actualSigner
    package_file_count = $rows.Count
    files = $rows
    deployment_performed = $false
}
[IO.File]::WriteAllText(
    $outputFull,
    ($attestation | ConvertTo-Json -Depth 7),
    [Text.UTF8Encoding]::new($false)
)
Write-Output "TETHERPLANE_CANARY_ATTESTED $outputFull"
