# Owner-supplied logo zip -> isolated review branch ONLY. Never changes installed app, agents, auth, or Edge profile.
[CmdletBinding()]
param(
 [string]$ZipPath = (Join-Path $env:USERPROFILE 'Downloads\Tetherplane-Exact-Logo-Pack-20261106.zip')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Repo = 'C:\Users\Sohaib\AppData\Local\Tetherplane\ReviewWorkspaces\Brand-Unification-20261106'
$ExpectedZipSha256 = 'C74DAF86415F2A3178C69DBE3196EE454A37A2555DAE5744949853BF3EB60CA9'
$ExpectedBranch = 'feature/brand-icon-unification-20261106'
$OriginalHashes = @{
 'branding/sources/logo-black-original.png' = 'A68A4782BAA855B2D58158E7A205802B875F64F84147C879A9B3D6E1C5677F09'
 'branding/sources/logo-white-on-black-original.jpg' = 'C964D071774F67EC83B85207E5FF2511E441F3676B5D92893CFFE974A74D0E12'
}
function Assert([bool]$Valid, [string]$Why) { if (-not $Valid) { throw $Why } }
function Hash([string]$FilePath) { (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToUpperInvariant() }
Assert (Test-Path -LiteralPath $Repo -PathType Container) 'REVIEW_WORKTREE_MISSING'
$actualBranch = (& git.exe -C $Repo branch --show-current).Trim()
Assert ($LASTEXITCODE -eq 0 -and $actualBranch -ceq $ExpectedBranch) 'REVIEW_BRANCH_MISMATCH'
Assert (Test-Path -LiteralPath $ZipPath -PathType Leaf) 'DOWNLOAD_OWNER_LOGO_ZIP_TO_LENO_DOWNLOADS_FIRST'
Assert ((Hash $ZipPath) -ceq $ExpectedZipSha256) 'LOGO_ZIP_SHA256_MISMATCH'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
try {
 $entries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
 Assert ($entries.Count -ge 45 -and $entries.Count -le 90) 'LOGO_ZIP_UNEXPECTED_ENTRY_COUNT'
 $names = @($entries | ForEach-Object { $_.FullName })
 Assert ($names.Count -eq @($names | Select-Object -Unique).Count) 'LOGO_ZIP_DUPLICATE_ENTRIES'
 foreach ($name in $names) {
  Assert (-not [IO.Path]::IsPathRooted($name)) 'LOGO_ZIP_ROOTED_PATH'
  Assert ($name -notmatch '(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-zA-Z]:') 'LOGO_ZIP_PATH_TRAVERSAL'
  Assert ($name -match '^(?:extension/browser/icons/|packaging/msix-store-runtime/app/assets/|branding/|BRAND_ASSET_INSTALL\.md$)') ('LOGO_ZIP_UNEXPECTED_ENTRY_'+$name)
 }
} finally { $archive.Dispose() }
$staging = Join-Path $env:LOCALAPPDATA 'Tetherplane\BrandAssetImport-20261106'
if (-not (Test-Path -LiteralPath $staging -PathType Container)) {
 New-Item -ItemType Directory -Path $staging -Force | Out-Null
 Expand-Archive -LiteralPath $ZipPath -DestinationPath $staging -Force
}
$manifestPath = Join-Path $staging 'branding\brand-asset-manifest.json'
Assert (Test-Path -LiteralPath $manifestPath -PathType Leaf) 'LOGO_MANIFEST_MISSING'
$m = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
Assert ($m.schema -ceq 'tetherplane.exact-user-supplied-brand-icon-pack.v1') 'LOGO_MANIFEST_SCHEMA_WRONG'
Assert ($m.store_submission_approved -eq $false) 'LOGO_MANIFEST_FALSE_STORE_APPROVAL'
$manifestEntries = @($m.files.PSObject.Properties)
foreach ($item in $manifestEntries) {
 $src = Join-Path $staging ($item.Name.Replace('/', '\'))
 Assert (Test-Path -LiteralPath $src -PathType Leaf) ('LOGO_ASSET_MISSING_'+$item.Name)
 Assert ((Hash $src) -ceq $item.Value.sha256.ToUpperInvariant()) ('LOGO_ASSET_HASH_DRIFT_'+$item.Name)
 Assert ((Get-Item -LiteralPath $src).Length -eq $item.Value.bytes) ('LOGO_ASSET_SIZE_DRIFT_'+$item.Name)
}
foreach ($key in $OriginalHashes.Keys) {
 $src = Join-Path $staging ($key.Replace('/', '\'))
 Assert ((Hash $src) -ceq $OriginalHashes[$key]) ('LOGO_ORIGINAL_CHANGED_'+$key)
}
# Only generated logo folders and original source art; never write code, manifests or active installs.
$targets = @($manifestEntries | ForEach-Object { $_.Name })
foreach ($name in $targets) {
 $target = Join-Path $Repo ($name.Replace('/', '\'))
 if (Test-Path -LiteralPath $target) {
  Assert ((Hash $target) -ceq ([string]$m.files.PSObject.Properties[$name].Value.sha256).ToUpperInvariant()) ('LOGO_SOURCE_DEST_DRIFT_'+$name)
 }
}
foreach ($name in $targets) {
 $target = Join-Path $Repo ($name.Replace('/', '\'))
 New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
 if (-not (Test-Path -LiteralPath $target)) {
  Copy-Item -LiteralPath (Join-Path $staging ($name.Replace('/', '\'))) -Destination $target -ErrorAction Stop
 }
 Assert ((Hash $target) -ceq ([string]$m.files.PSObject.Properties[$name].Value.sha256).ToUpperInvariant()) ('LOGO_SOURCE_COPY_MISMATCH_'+$name)
}
# The manifest itself is not covered by its own hash; retain the exact ZIP version.
$manifestTarget = Join-Path $Repo 'branding\brand-asset-manifest.json'
New-Item -ItemType Directory -Force -Path (Split-Path $manifestTarget -Parent) | Out-Null
Copy-Item -LiteralPath $manifestPath -Destination $manifestTarget -Force
Write-Output ('TETHERPLANE_EXACT_BRAND_ASSETS_IMPORTED_'+$targets.Count)
Write-Output ('REVIEW_ONLY_'+$ExpectedBranch)
Write-Output 'NO_LIVE_INSTALL_OR_BROWSER_PROFILE_CHANGED'
