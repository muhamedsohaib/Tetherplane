# Verifies a built Tetherplane device kit ZIP the way a new computer would
# receive it: sidecar SHA-256, unpack, package integrity, a real install into a
# temporary prefix, and the shipped agent binary answering device.status.
# Nothing outside the temporary directory is modified.
param(
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [switch]$RequireTrustedSignature,
    [string]$ExpectedPublisherSubject = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$zip = (Resolve-Path -LiteralPath $ZipPath).Path
$sidecar = $zip + ".sha256"
if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) { throw "missing checksum file: $sidecar" }
$recorded = ((Get-Content -LiteralPath $sidecar -Raw).Trim() -split "\s+")[0].ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($recorded -ne $actual) { throw "zip SHA-256 does not match its checksum file" }

$work = Join-Path ([IO.Path]::GetTempPath()) ("tp-kit-verify-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$agent = $null
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $kit = Join-Path $work "kit"
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $kit)

    $setup = Join-Path $kit "setup-windows-device.ps1"
    . $setup
    $verified = Confirm-DevicePackage -PackagePath $kit -ExpectedPublisherSubject $ExpectedPublisherSubject
    if ($RequireTrustedSignature -and [string]::IsNullOrWhiteSpace($ExpectedPublisherSubject)) { throw "independently confirmed -ExpectedPublisherSubject is required for signed verification" }
    if ($RequireTrustedSignature -and -not $verified.trusted_signature_verified) {
        throw "this is an unsigned development kit, not a trusted signed distribution"
    }
    $manifest = Get-Content -LiteralPath (Join-Path $kit "manifest.json") -Raw | ConvertFrom-Json

    $install = Join-Path $work "install"
    $state = Join-Path $work "state"
    $result = & $setup -DeviceId "KITVERIFY01" -InstallPrefix $install -StateDir $state -ExpectedPublisherSubject $ExpectedPublisherSubject | ConvertFrom-Json
    if (-not $result.ok) { throw "setup from the unpacked kit did not report ok" }

    $installedAgent = Join-Path $install "bin\tetherd.exe"
    $shipped = (Get-FileHash -LiteralPath (Join-Path $kit "bin\tetherd.exe") -Algorithm SHA256).Hash
    $installedHash = (Get-FileHash -LiteralPath $installedAgent -Algorithm SHA256).Hash
    if ($shipped -ne $installedHash) { throw "installed agent differs from the shipped agent" }
    if ($RequireTrustedSignature) {
        $checked = Assert-TrustedDeviceSignature -Path $installedAgent -ExpectedPublisherSubject $ExpectedPublisherSubject -ExpectedSignerThumbprint ([string]$manifest.signature.signer_thumbprint)
    }

    $requestId = [Guid]::NewGuid().ToString()
    $request = @{
        protocol_version = "1.0"; request_id = $requestId; device_id = $null; capability = "device.status"
        arguments = @{}; actor = @{ id = "kit-verify"; kind = "ai_client" }; session_id = $null
        response_mode = "compact"; idempotency_key = $null; preconditions = @(); expectations = @()
    } | ConvertTo-Json -Depth 6 -Compress
    $inFile = Join-Path $work "in.jsonl"
    $outFile = Join-Path $work "out.jsonl"
    $errFile = Join-Path $work "err.log"
    [IO.File]::WriteAllText($inFile, $request + "`n", (New-Object System.Text.UTF8Encoding($false)))
    $agent = Start-Process -FilePath $installedAgent -ArgumentList ('--stdio-rpc --allow "{0}"' -f $work) -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile -WindowStyle Hidden -PassThru

    $line = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline -and -not $line) {
        Start-Sleep -Milliseconds 250
        if (Test-Path -LiteralPath $outFile) {
            $stream = $null
            try {
                $stream = New-Object IO.FileStream($outFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
                $text = (New-Object IO.StreamReader($stream)).ReadToEnd()
                $line = @($text -split "`r?`n" | Where-Object { $_ -match [regex]::Escape($requestId) }) | Select-Object -First 1
            } catch { } finally { if ($stream) { $stream.Dispose() } }
        }
    }
    if (-not $line) { throw "the shipped agent did not answer device.status within 20 seconds" }
    $status = $line | ConvertFrom-Json
    if ($status.status -ne "success" -or $status.data.policy_mode -ne "background_only") {
        throw "the shipped agent returned an unexpected device.status result"
    }

    Write-Output ("TETHERPLANE_DEVICE_KIT_VERIFIED sha256={0} commit={1} dirty={2} agent={3}/{4} policy={5}" -f $actual, $verified.source_commit, $manifest.source_tree_dirty, $status.data.os, $status.data.arch, $status.data.policy_mode)
} finally {
    if ($agent) {
        if (-not $agent.HasExited) { try { $agent.Kill() } catch { } }
        try { [void]$agent.WaitForExit(5000) } catch { }
        $agent.Dispose()
    }
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
