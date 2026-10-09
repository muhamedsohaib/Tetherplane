# Read-only, exact-repository-source identity for the protected S4U runner.
# This file only defines functions and does not inspect or modify live state.
function Get-VerifiedRunnerVersion {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$V1SourcePath,
        [Parameter(Mandatory=$true)][string]$V2SourcePath,
        [Parameter(Mandatory=$true)][string]$ProtectedRunnerPath
    )
    foreach ($path in @($V1SourcePath,$V2SourcePath,$ProtectedRunnerPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw 'Trusted auth runner source or protected target is missing.'
        }
    }
    # Compare the complete file bytes through SHA-256; no material is read
    # into logs, returned as code, or executed to determine its identity.
    $v1 = (Get-FileHash -LiteralPath $V1SourcePath -Algorithm SHA256 -ErrorAction Stop).Hash
    $v2 = (Get-FileHash -LiteralPath $V2SourcePath -Algorithm SHA256 -ErrorAction Stop).Hash
    $installed = (Get-FileHash -LiteralPath $ProtectedRunnerPath -Algorithm SHA256 -ErrorAction Stop).Hash
    if ($v1 -ceq $v2) { throw 'Auth runner versions are indistinguishable.' }
    if ($installed -ceq $v1) { return 'v1' }
    if ($installed -ceq $v2) { return 'v2' }
    throw 'Installed S4U runner does not match a trusted repository version.'
}
