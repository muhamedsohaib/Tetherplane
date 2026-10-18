# Source-only MSIX feasibility gate. No installation or trust-store mutation.
param(
    [switch]$PreflightOnly,
    [string]$TetherdPath = ""
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$packager = Join-Path $repo "scripts\package-windows-store-msix.ps1"

if (-not (Test-Path -LiteralPath $packager -PathType Leaf)) {
    throw "MSIX POC RED: dedicated no-deployment package helper is absent"
}
$scriptContent = Get-Content -LiteralPath $packager -Raw
foreach ($prohibited in @("Add-AppxPackage", "Set-MpPreference", "Set-ItemProperty", "Register-ScheduledTask", "Start-ScheduledTask", "Invoke-WebRequest", "Invoke-RestMethod")) {
    if ($scriptContent.Contains($prohibited)) { throw "MSIX POC rejects installation, security, scheduler and network mutations: $prohibited" }
}
if ($PreflightOnly) {
    Write-Output "MSIX_PREFLIGHT_OK: packaging helper exists; no installation/network/security command"
    exit 0
}
if (-not $TetherdPath -or -not (Test-Path -LiteralPath $TetherdPath -PathType Leaf)) {
    throw "Built release tetherd.exe is required"
}
$stage = Join-Path $env:TEMP ("tp-msix-poc-" + [guid]::NewGuid().ToString("N"))
$unpacked = Join-Path $stage "unpacked"
$out = Join-Path $stage "tetherplane-store-poc.msix"
New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
try {
    $bad = Join-Path $stage "missing.exe"
    $missingFailed = $false
    try { & $packager -TetherdPath $bad -OutputPath $out } catch { $missingFailed = $true }
    if (-not $missingFailed -or (Test-Path -LiteralPath $out)) {
        throw "A missing binary must fail without creating a package"
    }

    & $packager -TetherdPath $TetherdPath -OutputPath $out
    if (-not (Test-Path -LiteralPath $out -PathType Leaf)) { throw "MSIX artifact missing" }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($out, $unpacked)
    $manifestPath = Join-Path $unpacked "AppxManifest.xml"
    $agent = Join-Path $unpacked "bin\tetherd.exe"
    if (-not (Test-Path -LiteralPath $manifestPath) -or -not (Test-Path -LiteralPath $agent)) {
        throw "MSIX missing app manifest or the native agent executable"
    }
    $hashExpected = (Get-FileHash -LiteralPath $TetherdPath -Algorithm SHA256).Hash
    $hashPackaged = (Get-FileHash -LiteralPath $agent -Algorithm SHA256).Hash
    if ($hashExpected -cne $hashPackaged) { throw "MSIX native agent bytes differ from the reviewed input" }
    [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
    $application = $manifest.SelectSingleNode("//*[local-name()='Application']")
    $startup = $manifest.SelectSingleNode("//*[local-name()='Extension' and @Category='windows.startupTask']")
    $fullTrust = $manifest.SelectSingleNode("//*[local-name()='Capability' and @Name='runFullTrust']")
    if ($null -eq $application -or [string]$application.Executable -cne "bin\tetherd.exe") {
        throw "MSIX does not target the native tetherd executable"
    }
    if ($null -eq $startup -or [string]$startup.Executable -cne "bin\tetherd.exe") {
        throw "MSIX does not declare an explicit native-agent logon startup task"
    }
    if ($null -eq $fullTrust) { throw "MSIX lacks the full-trust desktop capability" }
    if ($null -ne $manifest.SelectSingleNode("//*[local-name()='StartupTask' and @Enabled='true']")) {
        throw "MSIX must not silently auto-enable agent startup in the feasibility prototype"
    }
    if (Test-Path -LiteralPath (Join-Path $unpacked "AppxSignature.p7x")) {
        throw "MSIX POC is not allowed to masquerade as a signed public release"
    }
    $before = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash
    $overwriteFailed = $false
    try { & $packager -TetherdPath $TetherdPath -OutputPath $out } catch { $overwriteFailed = $true }
    if (-not $overwriteFailed -or (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash -cne $before) {
        throw "Existing candidate package must remain unchanged on a conflicting build"
    }
    Write-Output ("MSIX_FEASIBILITY_OK: unsigned Store candidate built; native agent SHA-256 " + $hashPackaged + "; uninstalled and untrusted")
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
