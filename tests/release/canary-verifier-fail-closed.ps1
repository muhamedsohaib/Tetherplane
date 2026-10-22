$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$verifier = Join-Path $repo 'scripts/release/verify-windows-canary.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('tp-canary-negative-' + [Guid]::NewGuid().ToString('N'))
$package = Join-Path $root 'package'
$attestation = Join-Path $root 'attestation.json'
$commit = '1' * 40
$signer = '0' * 40

function Assert-Rejected([string]$reason) {
    $failed = $false
    try {
        & $verifier -PackageRoot $package -ExpectedCommit $commit -ApprovedSignerThumbprint $signer -OutputManifest $attestation | Out-Null
    }
    catch {
        if (-not $_.Exception.Message.Contains($reason)) {
            throw ('unexpected verifier rejection: ' + $_.Exception.Message)
        }
        $failed = $true
    }
    if (-not $failed) { throw ('verifier incorrectly accepted: ' + $reason) }
    if (Test-Path -LiteralPath $attestation) { throw 'failed verification wrote an attestation' }
}

try {
    New-Item -ItemType Directory -Force -Path $package | Out-Null
    $manifest = Join-Path $package 'manifest.json'
    [IO.File]::WriteAllText($manifest, '{"source_commit":"2"}')
    Assert-Rejected 'missing mandatory artifact'

    $bin = Join-Path $package 'bin'
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $bin 'tetherd.exe'), [byte[]](0x4D,0x5A,0,0))
    Assert-Rejected 'source commit does not match'

    [IO.File]::WriteAllText($manifest, ('{"source_commit":"' + $commit + '"}'))
    Assert-Rejected 'signature is missing or invalid'
    Write-Output 'CANARY_VERIFIER_FAIL_CLOSED=PASS;NO_SIGNING_PERFORMED'
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
