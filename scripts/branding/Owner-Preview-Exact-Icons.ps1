# Owner-operated browser extension logo preview. Never stops Tetherplane or edits permissions.
[CmdletBinding()]
param(
    [ValidateSet('Preflight', 'SelfTest', 'Apply', 'Rollback')]
    [string]$Mode = 'Preflight'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo = 'C:\Users\Sohaib\AppData\Local\Tetherplane\ReviewWorkspaces\Brand-Unification-20261106'
$Installed = Join-Path $env:LOCALAPPDATA 'Programs\TetherplaneBrowserCanary20261101\browser\extension'
$State = Join-Path $env:LOCALAPPDATA 'Tetherplane\BrandExtensionPreview-20261106'
$Backup = Join-Path $State 'backup'
$Receipt = Join-Path $State 'preview-receipt.json'
$ManifestPath = Join-Path $Repo 'branding\brand-asset-manifest.json'
$OldManifestHash = '0D69CFD4147F7EA7FB9C0E7DA107FFB5768D53BCD5BA9F5E74017D303EAA30AD'
$OldPopupHash = '3974C4FBD3A27DAEE5B66DC3D8B68F0C8AA1BB4B89F44F2C834B29B866222BA3'
$ExpectedOriginalPinPrefix = 'imhaedlo'
$Payload = @(
    'manifest.json', 'pair.html',
    'icons\brand-16.png', 'icons\brand-32.png',
    'icons\brand-48.png', 'icons\brand-128.png',
    'icons\black-64.png'
)

function Assert([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
}
function GetHash([string]$path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return '' }
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToUpperInvariant()
}
function CheckIdentity {
    Assert ($env:COMPUTERNAME -ieq 'LENO') 'WRONG_DEVICE'
    Assert ($env:USERNAME -ieq 'Sohaib') 'WRONG_OWNER'
    Assert ([Environment]::UserInteractive) 'OWNER_CONSOLE_REQUIRED'
    $idFile = Join-Path $env:LOCALAPPDATA 'Tetherplane\browser-extension.id'
    Assert (Test-Path -LiteralPath $idFile -PathType Leaf) 'OWNER_PIN_MISSING'
    $id = (Get-Content -LiteralPath $idFile -Raw).Trim()
    Assert ($id -cmatch '^[a-p]{32}$') 'INVALID_OWNER_EXTENSION_ID'
    Assert ($id.StartsWith($ExpectedOriginalPinPrefix)) 'OWNER_PIN_CHANGED'
}
function ReadBrandManifest {
    Assert (Test-Path -LiteralPath $ManifestPath -PathType Leaf) 'SOURCE_BRAND_MANIFEST_MISSING_IMPORT_FIRST'
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    Assert ($manifest.schema -ceq 'tetherplane.exact-user-supplied-brand-icon-pack.v1') 'SOURCE_BRAND_MANIFEST_SCHEMA_MISMATCH'
    Assert ($manifest.store_submission_approved -eq $false) 'UNSUPPORTED_STORE_APPROVAL'
    return $manifest
}
function CheckSource {
    CheckIdentity
    $brand = ReadBrandManifest
    Assert ((GetHash (Join-Path $Repo 'branding\sources\logo-black-original.png')) -ceq 'A68A4782BAA855B2D58158E7A205802B875F64F84147C879A9B3D6E1C5677F09') 'ORIGINAL_BLACK_LOGO_DRIFT'
    Assert ((GetHash (Join-Path $Repo 'branding\sources\logo-white-on-black-original.jpg')) -ceq 'C964D071774F67EC83B85207E5FF2511E441F3676B5D92893CFFE974A74D0E12') 'ORIGINAL_WHITE_LOGO_DRIFT'

    $oldManifest = Get-Content -LiteralPath (Join-Path $Installed 'manifest.json') -Raw | ConvertFrom-Json
    $newManifest = Get-Content -LiteralPath (Join-Path $Repo 'extension\browser\manifest.json') -Raw | ConvertFrom-Json
    Assert ($oldManifest.name -ceq $newManifest.name) 'EXTENSION_NAME_DRIFT'
    Assert ($oldManifest.version -ceq $newManifest.version) 'EXTENSION_VERSION_DRIFT'
    Assert ($oldManifest.manifest_version -eq $newManifest.manifest_version) 'EXTENSION_MANIFEST_VERSION_DRIFT'
    Assert (($oldManifest.permissions | ConvertTo-Json -Compress) -ceq ($newManifest.permissions | ConvertTo-Json -Compress)) 'EXTENSION_PERMISSIONS_DRIFT'
    Assert (($oldManifest.host_permissions | ConvertTo-Json -Compress) -ceq ($newManifest.host_permissions | ConvertTo-Json -Compress)) 'EXTENSION_ORIGINS_DRIFT'
    Assert (($oldManifest.background | ConvertTo-Json -Compress) -ceq ($newManifest.background | ConvertTo-Json -Compress)) 'EXTENSION_BACKGROUND_DRIFT'
    Assert ($oldManifest.action.default_popup -ceq $newManifest.action.default_popup) 'EXTENSION_POPUP_DRIFT'
    if (-not (Test-Path -LiteralPath $Receipt -PathType Leaf)) {
        Assert ($null -eq $oldManifest.icons) 'EXISTING_ICON_MANIFEST_UNEXPECTEDLY_PRESENT'
    }
    foreach ($size in @('16','32','48','128')) {
        Assert ($newManifest.icons.$size -ceq ('icons/brand-'+$size+'.png')) 'SOURCE_EXTENSION_ICON_MAPPING_DRIFT'
        Assert ($newManifest.action.default_icon.$size -ceq ('icons/brand-'+$size+'.png')) 'SOURCE_EXTENSION_TOOLBAR_MAPPING_DRIFT'
    }
    foreach ($relative in $Payload) {
        $src = Join-Path (Join-Path $Repo 'extension\browser') $relative
        Assert (Test-Path -LiteralPath $src -PathType Leaf) ('SOURCE_ICON_FILE_MISSING_'+$relative)
        if ($relative.StartsWith('icons\')) {
            $zipKey = 'extension/browser/' + ($relative -replace '\\','/')
            $entry = $brand.files.PSObject.Properties[$zipKey]
            Assert ($null -ne $entry) ('SOURCE_ICON_UNLISTED_'+$relative)
            Assert ((GetHash $src) -ceq ([string]$entry.Value.sha256).ToUpperInvariant()) ('SOURCE_ICON_HASH_MISMATCH_'+$relative)
        }
    }
    $popup = Get-Content -LiteralPath (Join-Path $Repo 'extension\browser\pair.html') -Raw
    Assert ($popup.Contains('src="icons/black-64.png"')) 'POPUP_BRAND_ICON_REFERENCE_MISSING'
    Assert (-not $popup.Contains('class="mark"')) 'POPUP_LEGACY_CSS_MARK_PRESENT'
    return $brand
}
function CheckPreflight {
    $null = CheckSource
    $hasReceipt = Test-Path -LiteralPath $Receipt -PathType Leaf
    if ($hasReceipt) {
        foreach ($relative in $Payload) {
            $name = $relative -replace '[\\/]','_'
            $source = Join-Path (Join-Path $Repo 'extension\browser') $relative
            $target = Join-Path $Installed $relative
            Assert ((GetHash $target) -ceq (GetHash $source)) ('PREVIEW_INSTALLED_DRIFT_'+$relative)
        }
        Assert ((GetHash (Join-Path $Backup 'manifest.json')) -ceq $OldManifestHash) 'PREVIEW_BACKUP_MANIFEST_DRIFT'
        Assert ((GetHash (Join-Path $Backup 'pair.html')) -ceq $OldPopupHash) 'PREVIEW_BACKUP_POPUP_DRIFT'
        return 'OWNER_ICON_PREVIEW_ALREADY_INSTALLED_RELOAD_EDGE_EXTENSION'
    }
    Assert ((GetHash (Join-Path $Installed 'manifest.json')) -ceq $OldManifestHash) 'INSTALLED_MANIFEST_NOT_BASELINE'
    Assert ((GetHash (Join-Path $Installed 'pair.html')) -ceq $OldPopupHash) 'INSTALLED_POPUP_NOT_BASELINE'
    Assert (-not (Test-Path -LiteralPath $Backup)) 'UNEXPECTED_BACKUP_EXISTS'
    Assert (-not (Test-Path -LiteralPath (Join-Path $Installed 'icons'))) 'INSTALLED_ICON_FOLDER_UNEXPECTEDLY_PRESENT'
    return 'READY_OWNER_LOCAL_APPLY_REQUIRED'
}
function Apply {
    $status = CheckPreflight
    Assert ($status -ceq 'READY_OWNER_LOCAL_APPLY_REQUIRED') 'ALREADY_INSTALLED_OR_BASELINE_DRIFT'
    Write-Warning 'Preview changes only the local Tetherplane extension icon manifest, popup logo, and new icon files. No auth, Edge profiles, granted tabs or running agent settings are changed. You must reload the extension locally.'
    $approval = Read-Host 'Type exactly: AUTHORIZE TETHERPLANE EXACT ICON PREVIEW'
    Assert ($approval -ceq 'AUTHORIZE TETHERPLANE EXACT ICON PREVIEW') 'OWNER_APPROVAL_REQUIRED'
    New-Item -ItemType Directory -Force -Path $Backup | Out-Null
    foreach ($name in @('manifest.json','pair.html')) {
        Copy-Item -LiteralPath (Join-Path $Installed $name) -Destination (Join-Path $Backup $name) -ErrorAction Stop
    }
    Assert ((GetHash (Join-Path $Backup 'manifest.json')) -ceq $OldManifestHash) 'BACKUP_MANIFEST_HASH_MISMATCH'
    Assert ((GetHash (Join-Path $Backup 'pair.html')) -ceq $OldPopupHash) 'BACKUP_POPUP_HASH_MISMATCH'
    try {
        foreach ($relative in $Payload) {
            $source = Join-Path (Join-Path $Repo 'extension\browser') $relative
            $target = Join-Path $Installed $relative
            New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
            Copy-Item -LiteralPath $source -Destination $target -Force -ErrorAction Stop
            Assert ((GetHash $target) -ceq (GetHash $source)) ('ICON_COPY_HASH_MISMATCH_'+$relative)
        }
        $receiptData = [ordered]@{
            schema = 'tetherplane.owner-brand-icon-preview.v1'
            owner_authorized = $true
            applied_utc = (Get-Date).ToUniversalTime().ToString('o')
            extension_pin_prefix = $ExpectedOriginalPinPrefix
            files = $Payload
            rollback_directory = $Backup
            production_agent_untouched = $true
        }
        $receiptData | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Receipt -Encoding UTF8
        Write-Output 'OWNER_ICON_PREVIEW_INSTALLED_RELOAD_EDGE_EXTENSION_NOW'
    } catch {
        foreach ($relative in $Payload) {
            $target = Join-Path $Installed $relative
            if ($relative.StartsWith('icons\')) {
                if ((GetHash $target) -ceq (GetHash (Join-Path (Join-Path $Repo 'extension\browser') $relative))) {
                    Remove-Item -LiteralPath $target -Force
                }
            } else {
                $old = Join-Path $Backup $relative
                if (Test-Path -LiteralPath $old -PathType Leaf) {
                    Copy-Item -LiteralPath $old -Destination $target -Force
                }
            }
        }
        throw ('ICON_PREVIEW_INSTALL_FAILED_OLD_MANIFEST_RESTORED_'+$_.Exception.Message)
    }
}
function Rollback {
    CheckIdentity
    Assert (Test-Path -LiteralPath $Receipt -PathType Leaf) 'NOTHING_TO_ROLL_BACK'
    $brand = ReadBrandManifest
    Assert ((GetHash (Join-Path $Backup 'manifest.json')) -ceq $OldManifestHash) 'BACKUP_MANIFEST_CHANGED'
    Assert ((GetHash (Join-Path $Backup 'pair.html')) -ceq $OldPopupHash) 'BACKUP_POPUP_CHANGED'
    foreach ($relative in $Payload) {
        $source = Join-Path (Join-Path $Repo 'extension\browser') $relative
        Assert ((GetHash (Join-Path $Installed $relative)) -ceq (GetHash $source)) ('ROLLBACK_SOURCE_DRIFT_'+$relative)
    }
    $approval = Read-Host 'Type exactly: ROLLBACK TETHERPLANE EXACT ICON PREVIEW'
    Assert ($approval -ceq 'ROLLBACK TETHERPLANE EXACT ICON PREVIEW') 'ROLLBACK_NOT_AUTHORIZED'
    foreach ($name in @('manifest.json','pair.html')) {
        Copy-Item -LiteralPath (Join-Path $Backup $name) -Destination (Join-Path $Installed $name) -Force
    }
    foreach ($relative in $Payload) {
        if ($relative.StartsWith('icons\')) {
            Remove-Item -LiteralPath (Join-Path $Installed $relative) -Force -ErrorAction Stop
        }
    }
    Assert ((GetHash (Join-Path $Installed 'manifest.json')) -ceq $OldManifestHash) 'ROLLBACK_MANIFEST_VERIFICATION_FAILED'
    Assert ((GetHash (Join-Path $Installed 'pair.html')) -ceq $OldPopupHash) 'ROLLBACK_POPUP_VERIFICATION_FAILED'
    Remove-Item -LiteralPath $Receipt -Force
    Write-Output 'OWNER_ICON_PREVIEW_ROLLED_BACK_RELOAD_EDGE_EXTENSION_NOW'
}
function SelfTest {
    Assert ($Payload.Count -eq 7) 'FILESET_COUNT_MISMATCH'
    Assert ($ExpectedOriginalPinPrefix -ceq 'imhaedlo') 'PIN_PREFIX_MISMATCH'
    Assert ($OldManifestHash.Length -eq 64) 'MANIFEST_PIN_INVALID'
    Assert ($OldPopupHash.Length -eq 64) 'POPUP_PIN_INVALID'
    Assert (@($Payload|Where-Object{$_ -match '^icons\\'}).Count -eq 5) 'ICON_COUNT_MISMATCH'
    Write-Output 'OWNER_EXACT_ICON_INSTALLER_SELFTEST_PASS'
}
switch ($Mode) {
    'SelfTest' { SelfTest }
    'Preflight' { CheckPreflight }
    'Apply' { Apply }
    'Rollback' { Rollback }
}
