# Build a complete self-contained, unsigned Windows developer-beta ZIP.
# Does not modify live agents, auth, OS security settings, services or startup.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$FullPackagePath,
  [Parameter(Mandatory=$true)][string]$PinnedNodeZip,
  [Parameter(Mandatory=$true)][string]$OutputZip,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedCommit
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$nodeVersion = 'v22.23.4'
$nodeDistHash = 'CBC74B5E0982C9DBB41525FD8FB5DCD32FBEE237863F7829072F4639A1CE5F20'
$nodePrefix = 'node-' + $nodeVersion + '-win-x64/'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$package = (Resolve-Path -LiteralPath $FullPackagePath).Path
if (-not [IO.Path]::IsPathRooted($OutputZip) -or
    [IO.Path]::GetExtension($OutputZip) -ine '.zip') {
  throw 'PORTABLE_BETA_OUTPUT_MUST_BE_ABSOLUTE_ZIP'
}
$output = [IO.Path]::GetFullPath($OutputZip)
if (Test-Path -LiteralPath $output) {
  throw 'PORTABLE_BETA_OUTPUT_EXISTS_REFUSING_OVERWRITE'
}
if (-not (Test-Path -LiteralPath (Split-Path -Parent $output) -PathType Container)) {
  throw 'PORTABLE_BETA_OUTPUT_PARENT_MISSING'
}
$head = ((& git -C $repo rev-parse HEAD) | Select-Object -First 1).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedCommit.ToLowerInvariant()) {
  throw 'PORTABLE_BETA_SOURCE_COMMIT_MISMATCH'
}
$dirty = @(& git -C $repo status --porcelain)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0) {
  throw 'PORTABLE_BETA_SOURCE_WORKTREE_MUST_BE_CLEAN'
}
$nodeZipPath = (Resolve-Path -LiteralPath $PinnedNodeZip).Path
if ((Get-FileHash -LiteralPath $nodeZipPath -Algorithm SHA256).Hash -ine $nodeDistHash) {
  throw 'PORTABLE_BETA_NODE_DISTRIBUTION_HASH_MISMATCH'
}
$required = @(
  'bin\tetherd.exe',
  'adapters\compact-mcp\dist\stdio-server.js',
  'adapters\compact-mcp\node_modules',
  'adapters\model-client\dist\worker-main.js',
  'adapters\compact-mcp\smoke-six-tools.mjs',
  'protocol\schemas\result.schema.json',
  'manifest.json',
  'LICENSE-MIT',
  'LICENSE-APACHE'
)
foreach($rel in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $package $rel))) {
    throw ('PORTABLE_BETA_MISSING_FULL_PACKAGE_COMPONENT: ' + $rel)
  }
}
$peAudit = Join-Path $repo 'scripts\windows\check-pe-runtime-imports.mjs'
& node.exe $peAudit (Join-Path $package 'bin\tetherd.exe')
if ($LASTEXITCODE -ne 0) { throw 'PORTABLE_BETA_NATIVE_CRT_IMPORT_GATE_FAILED' }

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('TPPortableBeta-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $temporary 'stage'
$verify = Join-Path $temporary 'verify'
$created = $false
New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
try {
  foreach($item in @(Get-ChildItem -LiteralPath $package -Force)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'PORTABLE_BETA_REFUSES_SYMLINKED_PACKAGE_CONTENTS'
    }
    Copy-Item -LiteralPath $item.FullName -Destination $stage -Recurse -Force
  }
  $junctions = @(Get-ChildItem -LiteralPath $stage -Recurse -Force -ErrorAction Stop |
    Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
  if ($junctions.Count -gt 0) {
    throw 'PORTABLE_BETA_REFUSES_REPARSE_POINT_CONTENTS'
  }
  $nodeDir = Join-Path $stage 'runtime'
  New-Item -ItemType Directory -Path $nodeDir -ErrorAction Stop | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $nodeZip = [IO.Compression.ZipFile]::OpenRead($nodeZipPath)
  try {
    foreach($name in @('node.exe','LICENSE')) {
      $entries = @($nodeZip.Entries | Where-Object { $_.FullName -ceq ($nodePrefix + $name) })
      if ($entries.Count -ne 1) { throw ('PORTABLE_BETA_NODE_DISTRIBUTION_ENTRY_MISSING: ' + $name) }
      $from = $entries[0].Open()
      $to = [IO.File]::Create((Join-Path $nodeDir $name))
      try { $from.CopyTo($to) } finally { $to.Dispose(); $from.Dispose() }
    }
  } finally { $nodeZip.Dispose() }
  & node.exe $peAudit (Join-Path $nodeDir 'node.exe')
  if ($LASTEXITCODE -ne 0) { throw 'PORTABLE_BETA_BUNDLED_NODE_NONPORTABLE' }
  $firstRun = Join-Path $repo 'scripts\windows\portable-first-run.mjs'
  Copy-Item -LiteralPath $firstRun -Destination (Join-Path $stage 'adapters\compact-mcp\portable-first-run.mjs')

  # CMD is an explicitly invoked local self-test; never auto-configure auth/remote.
  $cmd = @'
@echo off
setlocal
set "ROOT=%~dp0"
echo TETHERPLANE UNSIGNED PORTABLE DEVELOPER BETA
echo Source commit: __COMMIT__
echo No admin access, OAuth tokens, scheduled tasks or Windows policy changes.
"%ROOT%runtime\node.exe" "%ROOT%adapters\compact-mcp\portable-first-run.mjs"
set "result=%errorlevel%"
echo.
if "%result%"=="0" (echo LOCAL PORTABLE ACCEPTANCE PASSED) else (echo LOCAL PORTABLE ACCEPTANCE FAILED, exit %result%)
if /I not "%~1"=="--no-pause" pause
exit /b %result%
'@
  $cmd = $cmd.Replace('__COMMIT__',$ExpectedCommit)
  [IO.File]::WriteAllText((Join-Path $stage 'START HERE.cmd'),$cmd,[Text.Encoding]::ASCII)

  # This does not enable new capabilities, and is never launched automatically.
  # MCP clients with explicit local authorization can use their own allowlist.
  $readme = @'
TETHERPLANE -- UNSIGNED WINDOWS PORTABLE DEVELOPER BETA
Windows x64; source pinned in BETA-MANIFEST.json.

QUICK START ON A NEW AUTHORIZED WINDOWS MACHINE
  1. Extract this ZIP to a new directory.
  2. Run START HERE.cmd. No PowerShell, Node.js setup, admin,
     scheduled task, OAuth registration, or security-policy change is needed.
  3. PASS means six MCP tools, local device.status and denied out-of-scope
     filesystem access work with disposable local data.

THIS DOES NOT PAIR A NEW REMOTE DEVICE.
  Remote OAuth and remote agent enrollment are intentionally not automated
  or bypassed. Use existing authorized Tetherplane auth configuration and
  approved onboarding procedure. Never copy a live agent argument file,
  token, or credential from a different machine to a beta tester.

WINDOWS POLICY:
  Unsigned binaries may be refused by Windows Application Control.
  Do not disable security controls. Failure is a host compatibility result.

OPTIONAL EXPERIMENTS:
  Branded Windows toast delivery requires separately approved native toast
  registration and user-session notification settings. This portable ZIP
  does not silently register a toast shortcut or scheduled agent.

ROLLBACK:
  Close the local test and delete this extracted folder. START HERE creates
  only isolated, transient test state; it removes that state on completion.
  The package does not touch the existing production agent or credentials.

RELEASE HONESTY:
  This is a prerelease, not a production-ready installer. The user-visible
  stopwatch from download through remote authenticated first operation is
  NOT measured by the local test.
  License notices: LICENSE-MIT, LICENSE-APACHE, runtime/LICENSE.
'@
  [IO.File]::WriteAllText((Join-Path $stage 'READ ME FIRST.txt'),$readme,[Text.Encoding]::UTF8)

  $betaManifest = [ordered]@{
    artifact = 'tetherplane-unsigned-windows-portable-developer-beta'
    beta_label = 'developer-beta-20261104'
    source_commit = $ExpectedCommit.ToLowerInvariant()
    release_ready = $false
    signing = 'unsigned'
    platform = 'windows-x64'
    runtime = $nodeVersion
    node_distribution_sha256 = $nodeDistHash.ToLowerInvariant()
    local_first_run = 'START HERE.cmd'
    remote_auth_configured = $false
    startup_task_installed = $false
  }
  $betaJson = $betaManifest | ConvertTo-Json -Depth 3
  [IO.File]::WriteAllText((Join-Path $stage 'BETA-MANIFEST.json'),$betaJson,(New-Object Text.UTF8Encoding($false)))

  # Always compute relative paths from the canonical stage directory.
  $canonicalStage = (Get-Item -LiteralPath $stage).FullName.TrimEnd('\','/')
  $prefix = $canonicalStage + [IO.Path]::DirectorySeparatorChar
  $checksumLines = @()
  foreach($file in @(Get-ChildItem -LiteralPath $stage -Recurse -File -ErrorAction Stop | Sort-Object FullName)) {
    $full = (Get-Item -LiteralPath $file.FullName).FullName
    if (-not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) {
      throw 'PORTABLE_BETA_FILE_OUTSIDE_STAGE'
    }
    $rel = $full.Substring($prefix.Length).Replace('\','/')
    if (-not $rel -or $rel -match '(^|/)\.\.(/|$)') {
      throw 'PORTABLE_BETA_BAD_RELATIVE_PATH'
    }
    $checksumLines += ((Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $rel)
  }
  [IO.File]::WriteAllLines((Join-Path $stage 'SHA256SUMS.txt'),$checksumLines,[Text.Encoding]::ASCII)
  $sourceHash = (Get-FileHash -LiteralPath (Join-Path $stage 'bin\tetherd.exe') -Algorithm SHA256).Hash
  $bundleNodeHash = (Get-FileHash -LiteralPath (Join-Path $stage 'runtime\node.exe') -Algorithm SHA256).Hash
  $elements = @(Get-ChildItem -LiteralPath $stage -Force | Select-Object -ExpandProperty FullName)
  Compress-Archive -LiteralPath $elements -DestinationPath $output -CompressionLevel Optimal -ErrorAction Stop
  $created = $true
  Expand-Archive -LiteralPath $output -DestinationPath $verify -ErrorAction Stop
  foreach($line in $checksumLines) {
    if($line -notmatch '^([0-9a-f]{64})  (.+)$'){throw 'PORTABLE_BETA_CHECKSUM_LINE_INVALID'}
    $rel = $Matches[2].Replace('/',[IO.Path]::DirectorySeparatorChar)
    $f = Join-Path $verify $rel
    if(-not(Test-Path -LiteralPath $f -PathType Leaf) -or
       (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash -ine $Matches[1]) {
      throw ('PORTABLE_BETA_EXTRACTED_HASH_MISMATCH: ' + $rel)
    }
  }
  Write-Output 'PORTABLE_BETA_ARCHIVE_EXTRACTION_VERIFIED'
  [pscustomobject]@{
    Archive = $output
    SourceCommit = $ExpectedCommit
    SHA256 = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
    AgentSHA256 = $sourceHash
    NodeSHA256 = $bundleNodeHash
    Entries = $checksumLines.Count + 1
    Portable = $true
    RealRemoteAuthTested = $false
  } | ConvertTo-Json -Compress
} catch {
  if ($created -and (Test-Path -LiteralPath $output)) {
    Remove-Item -LiteralPath $output -ErrorAction Stop
  }
  throw
} finally {
  if (Test-Path -LiteralPath $temporary) {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
  }
}
