# Tetherplane device pairing client (Windows)
#
# Uses the existing relay two-stage pairing endpoints. The device credential
# never leaves this computer; only its SHA-256 hash is sent. A pairing record
# (code + expiry, no secret) is kept so reruns resume instead of silently
# rotating a pending code. Dot-source to use the functions, or run with -Run.
param(
    [switch]$Run,
    [string]$RelayUrl = "",
    [string]$DeviceId = "",
    [string]$StateDir = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Windows PowerShell 5.1 can inherit a PowerShell 7 PSModulePath (for example
# when launched from a pwsh terminal) and then autoload incompatible core
# modules. Repin to Windows PowerShell's own module directories for this
# process only when a foreign-version core module would be resolved.
if ($PSVersionTable.PSEdition -eq "Desktop") {
    $coreModuleNames = @("Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Management", "Microsoft.PowerShell.Security")
    $foreignCore = @(Get-Module -ListAvailable -Name $coreModuleNames | Where-Object { $_.Version.Major -ne 3 })
    if ($foreignCore.Count -gt 0) {
        $env:PSModulePath = "$env:ProgramFiles\WindowsPowerShell\Modules;$env:SystemRoot\system32\WindowsPowerShell\v1.0\Modules"
        foreach ($coreName in $coreModuleNames) {
            $loaded = Get-Module -Name $coreName
            if ($loaded -and $loaded.Version.Major -ne 3) { Remove-Module -Name $coreName -Force -ErrorAction SilentlyContinue }
        }
        foreach ($coreName in $coreModuleNames) { Import-Module -Name $coreName -ErrorAction Stop }
    }
}

function Test-CredentialHash {
    param([Parameter(Mandatory = $true)][string]$Credential)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Credential)
    $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Request-DevicePairing {
    param(
        [Parameter(Mandatory = $true)][string]$RelayUrl,
        [Parameter(Mandatory = $true)][string]$DeviceId,
        [Parameter(Mandatory = $true)][string]$Credential,
        [string]$StateDir = ""
    )
    $credential = $Credential.Trim()
    if ($credential.Length -lt 16) { throw "device credential is missing or too short" }
    if ($StateDir) {
        $record = Read-PairingRecord -StateDir $StateDir -DeviceId $DeviceId
        if ($record) { return $record }
    }
    $hash = Test-CredentialHash $credential
    $body = @{ deviceId = $DeviceId; credentialHash = $hash } | ConvertTo-Json -Compress
    try {
        $raw = Invoke-WebRequest -Uri ($RelayUrl.TrimEnd("/") + "/pair/start") -Method POST -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 30
        $response = $raw.Content | ConvertFrom-Json
    } catch [Net.WebException] {
        throw New-PairingError -Response $_.Exception.Response
    }
    if ([int]$raw.StatusCode -ne 200 -or -not $response.userCode) {
        throw "pairing start returned an unexpected response (HTTP $([int]$raw.StatusCode))"
    }
    $result = [ordered]@{
        ok = $true
        device_id = $DeviceId
        userCode = [string]$response.userCode
        expiresAt = [string]$response.expiresAt
        next = "ask the already connected ChatGPT plugin to approve code $($response.userCode) for computer $DeviceId with device(op=""approve_pairing"", args={userCode:""$($response.userCode)"", expectedDeviceId:""$DeviceId""}); then resume setup to finalize the background agent"
    }
    if ($StateDir) { Write-PairingRecord -StateDir $StateDir -DeviceId $DeviceId -UserCode $result.userCode -ExpiresAt $result.expiresAt }
    return $result
}

function Read-PairingRecord {
    param([Parameter(Mandatory = $true)][string]$StateDir, [Parameter(Mandatory = $true)][string]$DeviceId)
    $recordPath = Join-Path ([IO.Path]::GetFullPath($StateDir)) "pairing.json"
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) { return $null }
    try { $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json } catch { return $null }
    if ([string]$record.device_id -cne $DeviceId) { return $null }
    if (-not [string]$record.userCode -or -not [string]$record.expiresAt) { return $null }
    try { $expiry = [DateTimeOffset]::Parse([string]$record.expiresAt).UtcDateTime } catch { return $null }
    if ($expiry -le [DateTime]::UtcNow.AddMinutes(1)) { return $null }
    return [ordered]@{
        ok = $true
        resumed = $true
        device_id = $DeviceId
        userCode = [string]$record.userCode
        expiresAt = [string]$record.expiresAt
        next = "a pending approval code is still valid; ask the already connected ChatGPT plugin to approve it, then resume setup to finalize the background agent"
    }
}

function Write-PairingRecord {
    param(
        [Parameter(Mandatory = $true)][string]$StateDir,
        [Parameter(Mandatory = $true)][string]$DeviceId,
        [Parameter(Mandatory = $true)][string]$UserCode,
        [Parameter(Mandatory = $true)][string]$ExpiresAt
    )
    $state = [IO.Path]::GetFullPath($StateDir)
    $recordPath = Join-Path $state "pairing.json"
    # The standalone pairing script must validate both the leaf and its
    # ancestors before creating a directory or following a redirected write.
    $current = $recordPath
    $root = [IO.Path]::GetPathRoot($current)
    while ($current) {
        $item = $null
        try { $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop }
        catch [System.Management.Automation.ItemNotFoundException] { }
        if ($item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "refusing redirected pairing path (reparse point): $current"
        }
        if ($current -eq $root) { break }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
    New-Item -ItemType Directory -Force -Path $state | Out-Null
    [ordered]@{ device_id = $DeviceId; userCode = $UserCode; expiresAt = $ExpiresAt } | ConvertTo-Json -Compress | Set-Content -LiteralPath $recordPath -Encoding Ascii
}

function New-PairingError {
    param($Response)
    $code = 0
    $message = "pairing request failed"
    try {
        $code = [int]$Response.StatusCode
        $reader = New-Object System.IO.StreamReader($Response.GetResponseStream())
        $text = $reader.ReadToEnd()
        $reader.Close()
        $message = $text
        try {
            $parsed = $text | ConvertFrom-Json
            if ($parsed.error.message) { $message = [string]$parsed.error.message }
            elseif ($parsed.message) { $message = [string]$parsed.message }
        } catch { }
    } catch { }
    if ($message -match "(?i)already paired") {
        return [Exception]::new("device is already paired: run repair with the existing credential and device ID instead of re-pairing ($message)")
    }
    if ($code -eq 410 -or $message -match "(?i)expir") {
        return [Exception]::new("pairing code expired: request a fresh code with Request-DevicePairing ($message)")
    }
    return [Exception]::new("pairing start failed (HTTP $code): $message")
}

if ($MyInvocation.InvocationName -ne ".") {
    if (-not $RelayUrl) { $RelayUrl = "https://vaulter.tailf65eba.ts.net" }
    if (-not $StateDir) { $StateDir = Join-Path $env:LOCALAPPDATA "Tetherplane\device-state" }
    $idPath = Join-Path ([IO.Path]::GetFullPath($StateDir)) "device-id.txt"
    $credentialPath = Join-Path ([IO.Path]::GetFullPath($StateDir)) "device.credential"
    if (-not (Test-Path -LiteralPath $idPath -PathType Leaf)) { throw "device identity is missing; run setup first" }
    if ($DeviceId -and ((Get-Content -LiteralPath $idPath -Raw).Trim() -cne $DeviceId)) {
        throw "device ID mismatch: state belongs to a different device; refusing to pair under a conflicting identity"
    }
    $resolvedId = (Get-Content -LiteralPath $idPath -Raw).Trim()
    Request-DevicePairing -RelayUrl $RelayUrl -DeviceId $resolvedId -Credential ((Get-Content -LiteralPath $credentialPath -Raw).Trim()) -StateDir ([IO.Path]::GetFullPath($StateDir))
}
