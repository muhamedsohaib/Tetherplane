param(
    [string]$BrowserStateDir = (Join-Path $env:LOCALAPPDATA "Tetherplane"),
    [string]$ExtensionId,
    [switch]$EnableBackgroundStartup
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Explicit owner enrollment, performed only after locally loading the
# unpacked browser/extension directory and reading its actual extension ID.
$install = Split-Path -Parent $PSScriptRoot
$extensionManifest = Join-Path $install "browser\extension\manifest.json"
if (-not (Test-Path -LiteralPath $extensionManifest -PathType Leaf)) {
    throw "Installed Tetherplane Chrome extension is missing: $extensionManifest"
}

if (-not $ExtensionId) {
    if (-not [Environment]::UserInteractive) {
        throw "An owner-supplied Chrome extension ID is required for noninteractive setup"
    }
    Write-Output ("Load unpacked browser extension from: " + (Split-Path -Parent $extensionManifest))
    $ExtensionId = Read-Host "Enter the 32-letter extension ID shown in the browser extension manager"
}
$ExtensionId = $ExtensionId.Trim()
if ($ExtensionId -cnotmatch '^[a-p]{32}$') {
    throw "Chrome extension ID must contain exactly 32 letters a-p"
}

$root = [IO.Path]::GetFullPath($BrowserStateDir)
$pinPath = Join-Path $root "browser-extension.id"
$agentTokenPath = Join-Path $root "browser-bridge.token"
$extensionTokenPath = Join-Path $root "browser-extension-launch.token"

# Never silently rebind an existing Chrome extension to an unrelated ID.
if (Test-Path -LiteralPath $pinPath -PathType Leaf) {
    $existing = (Get-Content -LiteralPath $pinPath -Raw -ErrorAction Stop).Trim()
    if ($existing -cne $ExtensionId) {
        throw "Browser is already pinned to a different extension; refusing replacement"
    }
}

New-Item -ItemType Directory -Force -Path $root | Out-Null

function New-OwnerOnlyFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $access = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($access)

    # CreateNew with explicit ACL avoids a world-readable intermediate file.
    $stream = [System.IO.FileStream]::new(
        $Path,
        [System.IO.FileMode]::CreateNew,
        [System.Security.AccessControl.FileSystemRights]::Write,
        [System.IO.FileShare]::None,
        4096,
        [System.IO.FileOptions]::None,
        $acl
    )
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value + [Environment]::NewLine)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    }
    finally {
        $stream.Dispose()
    }
}

function New-LocalToken {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        if ((Get-Item -LiteralPath $Path).Length -lt 32) {
            throw "Existing Tetherplane browser token is too short; refusing replacement"
        }
        return
    }

    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
        $token = [Convert]::ToBase64String($bytes)
    }
    finally {
        $rng.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
    New-OwnerOnlyFile -Path $Path -Value $token
}

if (-not (Test-Path -LiteralPath $pinPath -PathType Leaf)) {
    New-OwnerOnlyFile -Path $pinPath -Value $ExtensionId
}
New-LocalToken -Path $agentTokenPath
New-LocalToken -Path $extensionTokenPath

# Startup registration is explicit opt-in, never implied by token creation.
# It must launch the GUI-subsystem owner browser host, not powershell.exe.
if ($EnableBackgroundStartup) {
    $launcher = Join-Path $install "bin\tetherplane-browserw.exe"
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw "windowless browser launcher is missing"
    }
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $runName = "TetherplaneAuthenticatedBrowserHost"
    $runValue = '"' + $launcher + '" --browser-state-dir "' + $root + '"'
    $existingProperty = Get-ItemProperty -LiteralPath $runKey -Name $runName -ErrorAction SilentlyContinue
    $existing = if ($existingProperty) { [string]$existingProperty.$runName } else { $null }
    if ($existing -and $existing -cne $runValue) {
        throw "existing browser autorun requires explicit owner-reviewed migration"
    }
    New-Item -Path $runKey -Force | Out-Null
    New-ItemProperty -Path $runKey -Name $runName -Value $runValue -PropertyType String -Force | Out-Null
    if ((Get-ItemProperty -LiteralPath $runKey -Name $runName).$runName -cne $runValue) {
        throw "windowless browser autorun registration failed"
    }
    Write-Output "BROWSER_WINDOWLESS_AUTOSTART_OPT_IN=True"
}

Write-Output "BROWSER_OWNER_SETUP_READY=True"
Write-Output "BROWSER_PAIRING_REQUIRES_EXPLICIT_LOCAL_EXTENSION_ACTION=True"
