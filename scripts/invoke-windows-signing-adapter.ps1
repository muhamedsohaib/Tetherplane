# Orchestrates an administrator-installed provider adapter; no private key,
# provider credential, or downloaded executable/script is loaded by this file.
# Adapter contract: -Path <one literal file> -TimestampUrl <approved URL>,
# modify only that file, and exit zero only when signing and timestamping pass.
param(
    [string]$RequestPath = "",
    [string]$ExpectedRequestSha256 = "",
    [string]$ExpectedSourceCommit = "",
    [string]$PayloadPath = "",
    [string]$OutputPath = "",
    [string]$AdapterPath = "",
    [string]$ExpectedAdapterSha256 = "",
    [string]$TimestampUrl = "",
    [ValidateRange(1, 600)][int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Preserve caller bindings: the helper script has its own CLI parameters.
$adapterArguments = @{}
foreach ($argumentName in @("RequestPath", "ExpectedRequestSha256", "ExpectedSourceCommit", "PayloadPath", "OutputPath", "AdapterPath", "ExpectedAdapterSha256", "TimestampUrl", "TimeoutSeconds")) {
    $adapterArguments[$argumentName] = Get-Variable -Name $argumentName -ValueOnly
}
. (Join-Path $PSScriptRoot "new-windows-signing-request.ps1")

function Invoke-IsolatedSigningProvider {
    param([string]$AdapterPath, [string]$Path, [string]$TimestampUrl, [int]$TimeoutSeconds)
    $hostName = if ($PSVersionTable.PSEdition -eq "Desktop") { "powershell.exe" } elseif ($env:OS -eq "Windows_NT") { "pwsh.exe" } else { "pwsh" }
    $hostPath = Join-Path $PSHOME $hostName
    # Single-quoted PowerShell literals inside EncodedCommand preserve spaces,
    # apostrophes and shell metacharacters without evaluating caller strings.
    $adapterLiteral = "'" + $AdapterPath.Replace("'", "''") + "'"
    $pathLiteral = "'" + $Path.Replace("'", "''") + "'"
    $urlLiteral = "'" + $TimestampUrl.Replace("'", "''") + "'"
    $command = '$ErrorActionPreference="Stop"; $WarningPreference="Stop"; $global:LASTEXITCODE=0; try { & ' + $adapterLiteral + ' -Path ' + $pathLiteral + ' -TimestampUrl ' + $urlLiteral + ' *> $null; exit ([int]$LASTEXITCODE) } catch { exit 1 }'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $hostPath
    $start.Arguments = "-NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded"
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw "signing adapter failed to start" }
        # Drain both streams concurrently without retaining or emitting provider
        # output, including direct Console writes and PowerShell host streams.
        $process.BeginOutputReadLine()
        $process.BeginErrorReadLine()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            # The adapter may be waiting on a native signing client. Stop the
            # complete owned tree so that it cannot continue signing after a
            # timeout. Windows PowerShell 5.1 lacks Process.Kill(true).
            if ($PSVersionTable.PSEdition -eq "Desktop") {
                & (Join-Path $env:SystemRoot "System32/taskkill.exe") /PID $process.Id /T /F *> $null
                if ($LASTEXITCODE -ne 0 -and -not $process.HasExited) { throw "signing adapter timed out; failed to stop its process tree" }
            } else { $process.Kill($true) }
            $process.WaitForExit()
            throw "signing adapter timed out; no candidate was produced"
        }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "signing adapter failed; provider output was suppressed" }
    } finally { $process.Dispose() }
}

function Remove-IncompleteSigningDirectory {
    param([string]$Path)
    $entry = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not $entry) { return }
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Remove-Item -LiteralPath $Path -Force
    } elseif ($entry.PSIsContainer) {
        foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force)) { Remove-IncompleteSigningDirectory -Path $child.FullName }
        Remove-Item -LiteralPath $Path -Force
    } else { Remove-Item -LiteralPath $Path -Force }
}

function Invoke-WindowsSigningAdapter {
    param(
        [Parameter(Mandatory = $true)][string]$RequestPath,
        [Parameter(Mandatory = $true)][string]$ExpectedRequestSha256,
        [Parameter(Mandatory = $true)][string]$ExpectedSourceCommit,
        [Parameter(Mandatory = $true)][string]$PayloadPath,
        [Parameter(Mandatory = $true)][string]$OutputPath,
        [Parameter(Mandatory = $true)][string]$AdapterPath,
        [Parameter(Mandatory = $true)][string]$ExpectedAdapterSha256,
        [Parameter(Mandatory = $true)][string]$TimestampUrl,
        [ValidateRange(1, 600)][int]$TimeoutSeconds = 120
    )
    $uri = $null
    if (-not [Uri]::TryCreate($TimestampUrl, [UriKind]::Absolute, [ref]$uri) -or
        @("http", "https") -notcontains $uri.Scheme -or -not $uri.Host -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
        $TimestampUrl -match '[\x00-\x20]') { throw "signing timestamp URL must be HTTP(S), without credentials, query, fragment or whitespace" }
    if (-not [IO.Path]::IsPathRooted($AdapterPath) -or [IO.Path]::GetExtension($AdapterPath) -ine ".ps1") { throw "signing adapter path must identify an administrator-installed absolute .ps1 file" }
    if ($ExpectedAdapterSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "signing adapter hash must be independently configured" }
    $adapter = Assert-SigningPathNotRedirected -Path $AdapterPath
    if (-not (Test-Path -LiteralPath $adapter -PathType Leaf) -or (Get-SigningFileHash -Path $adapter) -ne $ExpectedAdapterSha256) { throw "signing adapter hash does not match the provisioned adapter" }
    $root = Assert-SigningPathNotRedirected -Path $PayloadPath
    $output = Assert-SigningPathNotRedirected -Path $OutputPath
    if ((Test-SigningPathWithin $output $root) -or (Test-SigningPathWithin $root $output)) { throw "signing output must not overlap the input payload" }
    if ((Test-SigningPathWithin $adapter $root) -or (Test-SigningPathWithin $adapter $output)) { throw "signing adapter path must not be supplied by a payload" }
    if (Test-Path -LiteralPath $output) { throw "signing output already exists; no files were replaced" }
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $output) -PathType Container)) { throw "signing output parent is missing" }
    $request = Read-WindowsSigningRequest -RequestPath $RequestPath -ExpectedRequestSha256 $ExpectedRequestSha256 -ExpectedSourceCommit $ExpectedSourceCommit -PayloadPath $root
    $stage = $output + ".incomplete-" + [Guid]::NewGuid().ToString("N")
    $locks = New-Object 'System.Collections.Generic.List[System.IO.FileStream]'
    try {
        # Keep original inputs and the approved adapter read-only to concurrent
        # Windows opens while signing isolated copies. No in-place input edits.
        foreach ($file in $request.files) {
            $locks.Add([IO.File]::Open((Join-Path $root $file.path), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
        }
        $locks.Add([IO.File]::Open($adapter, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
        if ((Get-SigningFileHash -Path $adapter) -ne $ExpectedAdapterSha256) { throw "signing adapter hash changed before invocation" }
        [void](Read-WindowsSigningRequest -RequestPath $RequestPath -ExpectedRequestSha256 $ExpectedRequestSha256 -ExpectedSourceCommit $ExpectedSourceCommit -PayloadPath $root)
        New-Item -ItemType Directory -Path $stage | Out-Null
        foreach ($file in $request.files) {
            $destination = Join-Path $stage $file.path
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $root $file.path) -Destination $destination
        }
        [void](Read-WindowsSigningRequest -RequestPath $RequestPath -ExpectedRequestSha256 $ExpectedRequestSha256 -ExpectedSourceCommit $ExpectedSourceCommit -PayloadPath $stage)
        foreach ($relative in @(Get-WindowsSigningPayloadPaths)) {
            $before = @{}
            foreach ($other in @(Get-WindowsSigningPayloadPaths)) { $before[$other] = Get-SigningFileHash -Path (Join-Path $stage $other) }
            Invoke-IsolatedSigningProvider -AdapterPath $adapter -Path (Join-Path $stage $relative) -TimestampUrl $TimestampUrl -TimeoutSeconds $TimeoutSeconds
            [void](Assert-WindowsSigningPayloadLayout -Path $stage)
            $expectedContent = @($request.files | Where-Object { $_.path -ceq $relative })[0].sip_sha256
            if ((Get-WindowsSigningContentDigest -Path (Join-Path $stage $relative)) -ne $expectedContent) { throw "signing adapter changed the approved content digest" }
            foreach ($other in @(Get-WindowsSigningPayloadPaths)) {
                if ($other -ne $relative -and (Get-SigningFileHash -Path (Join-Path $stage $other)) -ne $before[$other]) { throw "signing adapter changed an unexpected file" }
            }
        }
        [void](Confirm-WindowsSignedPayload -RequestPath $RequestPath -ExpectedRequestSha256 $ExpectedRequestSha256 -ExpectedSourceCommit $ExpectedSourceCommit -UnsignedPayloadPath $root -SignedPayloadPath $stage)
        [void](Assert-SigningPathNotRedirected -Path $output)
        [IO.Directory]::Move($stage, $output)
        [pscustomobject]@{ payload_path = $output; request_sha256 = $ExpectedRequestSha256.ToLowerInvariant(); source_commit = $ExpectedSourceCommit.ToLowerInvariant(); file_count = $request.files.Count; trust_verified = $false }
    } finally {
        foreach ($lock in $locks) { $lock.Dispose() }
        Remove-IncompleteSigningDirectory -Path $stage
    }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-WindowsSigningAdapter @adapterArguments }
