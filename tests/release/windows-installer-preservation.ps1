# Tetherplane Windows installer safety checks.
# The fixture contains no live agent, secrets, OAuth client or device identity.
# Never run this against an existing user installation.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$installer = Join-Path $repo "scripts\install-windows.ps1"
$root = Join-Path ([IO.Path]::GetTempPath()) ("tetherplane-installer-preservation-" + [guid]::NewGuid().ToString("N"))
$package = Join-Path $root "synthetic-package"
$cases = 0

function Add-TestPackageFile {
    param([Parameter(Mandatory = $true)][string]$RelativePath, [string]$Body = "synthetic test-only file")
    $destination = Join-Path $package $RelativePath
    New-Item -ItemType Directory -Path (Split-Path -Path $destination -Parent) -Force | Out-Null
    [IO.File]::WriteAllText($destination, $Body, [Text.UTF8Encoding]::new($false))
}

function Assert-Refused {
    param([Parameter(Mandatory = $true)][scriptblock]$Operation,
          [Parameter(Mandatory = $true)][string]$ErrorFragment)
    $rejected = $false
    try {
        & $Operation | Out-Null
    }
    catch {
        if ([string]$_.Exception.Message -notlike ("*" + $ErrorFragment + "*")) {
            throw "wrong refusal: $($_.Exception.Message)"
        }
        $rejected = $true
    }
    if (-not $rejected) { throw "installer unexpectedly accepted a protected operation" }
    $script:cases++
}

try {
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Add-TestPackageFile "bin\tetherd.exe"
    Add-TestPackageFile "adapters\compact-mcp\dist\stdio-server.js"
    Add-TestPackageFile "protocol\schemas\result.schema.json" "{}"
    Add-TestPackageFile "launch\tetherplane-mcp.ps1"
    Add-TestPackageFile "manifest.json" '{"name":"Tetherplane","test_only":true}'

    $existing = Join-Path $root "populated-install"
    New-Item -ItemType Directory -Path $existing | Out-Null
    $sentinel = Join-Path $existing "do-not-delete-user-content.txt"
    [IO.File]::WriteAllText($sentinel, "preserve exact existing user content")
    $state = Join-Path $root "isolated-state"

    Assert-Refused {
        & $installer -PackagePath $package -InstallPrefix $existing -StateDir $state -Force
    } "refusing to overwrite or delete"
    if (-not (Test-Path -LiteralPath $sentinel)) { throw "-Force deleted pre-existing content" }
    if ((Get-Content -LiteralPath $sentinel -Raw) -cne "preserve exact existing user content") {
        throw "-Force modified existing user content"
    }
    if (Test-Path -LiteralPath $state) { throw "-Force wrote state despite its refusal" }

    Assert-Refused {
        & $installer -PackagePath $package -InstallPrefix $existing -StateDir $state
    } "refusing to overwrite or delete"
    if (-not (Test-Path -LiteralPath $sentinel)) { throw "ordinary install deleted pre-existing content" }

    $same = Join-Path $root "same-path"
    Assert-Refused {
        & $installer -PackagePath $package -InstallPrefix $same -StateDir $same
    } "must not overlap"
    if (Test-Path -LiteralPath $same) { throw "same-path rejection changed disk" }

    $nested = Join-Path $root "nested-install"
    Assert-Refused {
        & $installer -PackagePath $package -InstallPrefix $nested -StateDir (Join-Path $nested "state")
    } "must not overlap"
    if (Test-Path -LiteralPath $nested) { throw "nested-state rejection changed disk" }

    $parent = Join-Path $root "state-parent"
    Assert-Refused {
        & $installer -PackagePath $package -InstallPrefix (Join-Path $parent "install") -StateDir $parent
    } "must not overlap"
    if (Test-Path -LiteralPath $parent) { throw "parent-state rejection changed disk" }

    # A fresh test-only installation remains supported, without registering tasks,
    # starting processes, writing device credentials or contacting any relay.
    $fresh = Join-Path $root "fresh-install"
    $freshState = Join-Path $root "fresh-state"
    $output = @(& $installer -PackagePath $package -InstallPrefix $fresh -StateDir $freshState)
    if (-not ($output -match "TETHERPLANE_INSTALL_OK")) { throw "fresh install reported no success" }
    foreach ($required in @("bin\tetherd.exe", "manifest.json", "config\install.json")) {
        if (-not (Test-Path -LiteralPath (Join-Path $fresh $required))) {
            throw "fresh install missing expected file: $required"
        }
    }
    $receipt = Get-Content -LiteralPath (Join-Path $fresh "config\install.json") -Raw | ConvertFrom-Json
    if ($receipt.scheduled_task) { throw "synthetic test accidentally registered a task" }
    if ($receipt.state_dir -ine $freshState) { throw "fresh install receipt changed state directory" }
    $cases++

    # Compatibility: -Force with a truly empty destination must not delete it.
    $empty = Join-Path $root "empty-install"
    New-Item -ItemType Directory -Path $empty | Out-Null
    $emptyState = Join-Path $root "empty-state"
    $output = @(& $installer -PackagePath $package -InstallPrefix $empty -StateDir $emptyState -Force)
    if (-not ($output -match "TETHERPLANE_INSTALL_OK")) { throw "empty destination was rejected" }
    $cases++

    if ($cases -ne 7) { throw "unexpected number of tests: $cases" }
    Write-Output "WINDOWS_INSTALLER_PRESERVATION_OK: $cases isolated cases"
}
finally {
    if (Test-Path -LiteralPath $root -PathType Container) {
        # Only remove the uniquely created disposable GUID fixture directory.
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}
