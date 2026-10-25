# Read-only, owner-operated VAULTER Control Center receipt collector.
# Only metadata/hashes from an explicitly supplied root. Never access OAuth/config secrets.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$PortalRoot,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [ValidateRange(1,65535)][int]$Port = 8791
)
$ErrorActionPreference='Stop'
if (-not [System.IO.Path]::IsPathRooted($PortalRoot) -or -not
    [System.IO.Path]::IsPathRooted($OutputPath)) {
  throw 'Explicit absolute paths are required for input and output.'
}
$root=[System.IO.Path]::GetFullPath($PortalRoot)
$output=[System.IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
  throw 'The explicitly selected portal source directory does not exist.'
}
if (Test-Path -LiteralPath $output) {
  throw 'Receipt already exists; refusing to overwrite owner evidence.'
}
$parent=[System.IO.Path]::GetDirectoryName($output)
if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
  throw 'The explicitly approved output directory does not exist.'
}
if ($output.StartsWith($root.TrimEnd('\')+'\',[System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Keep the receipt outside production source files.'
}
$files=@(
  'server.mjs','oauth.mjs','authority.mjs','authority-http.mjs','authority-audit.mjs',
  'public\index.html','public\tp-integration.js','public\tp-oauth.js',
  'public\tp-authority.js','tools\verify-original.mjs'
)
$hashes=@()
foreach ($rel in $files) {
  $file=Join-Path $root $rel
  $item=[ordered]@{relativePath=$rel.Replace('\','/');status='missing';sha256=$null;
    bytes=$null;modifiedUtc=$null}
  try {
    if (Test-Path -LiteralPath $file -PathType Leaf) {
      $fi=Get-Item -LiteralPath $file -ErrorAction Stop
      if (($fi.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        $item.status='reparse_point_not_followed'
      } else {
        $item.status='readable'
        $item.sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $file -ErrorAction Stop).Hash.ToLowerInvariant()
        $item.bytes=[long]$fi.Length
        $item.modifiedUtc=$fi.LastWriteTimeUtc.ToString('o')
      }
    }
  } catch { $item.status='unreadable' }
  $hashes+=([pscustomobject]$item)
}
$listeners=@()
$listenerObservation='ok'
try {
  $tcp=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Port })
  foreach ($row in $tcp) {
    $loopback=$row.LocalAddress -in @('127.0.0.1','::1')
    $listeners+=([pscustomobject]@{
      processId=[int]$row.OwningProcess
      isLoopback=[bool]$loopback
      addressFamily=$(if ($row.LocalAddress -match ':') {'IPv6'} else {'IPv4'})
    })
  }
} catch {
  $listenerObservation='unavailable'
}
$processes=@()
foreach ($pidNumber in @($listeners | ForEach-Object { $_.processId } | Sort-Object -Unique)) {
  if (-not $pidNumber) {continue}
  try {
    $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$pidNumber" -ErrorAction Stop
    if ($null -eq $proc) {continue}
    $binaryHash=$null
    if ($proc.ExecutablePath -and (Test-Path -LiteralPath $proc.ExecutablePath -PathType Leaf)) {
      try { $binaryHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $proc.ExecutablePath).Hash.ToLowerInvariant() }
      catch {}
    }
    $started=$null
    if ($proc.CreationDate) {
      $started=([datetime]$proc.CreationDate).ToUniversalTime().ToString('o')
    }
    $processes+=([pscustomobject]@{
      processId=[int]$pidNumber
      executableName=[string]$proc.Name
      startedUtc=$started
      executableBinarySha256=$binaryHash
      binaryHashIsSourceProvenance=$false
    })
  } catch {
    $processes+=([pscustomobject]@{processId=[int]$pidNumber;metadata='unavailable'})
  }
}
$receipt=[ordered]@{
  schema='tetherplane.control-center.readonly-receipt.v1'
  capturedUtc=[datetime]::UtcNow.ToString('o')
  requestedPort=$Port
  listenerObservation=$listenerObservation
  listenerCount=$listeners.Count
  listeners=$listeners
  processes=$processes
  sourceFiles=$hashes
  rootPathIncluded=$false
  processCommandLinesIncluded=$false
  credentialContentsIncluded=$false
  warning='A listener PID or executable hash is not proof of the active JavaScript bundle or OAuth acceptance.'
}
$json=$receipt | ConvertTo-Json -Depth 8
$bytes=(New-Object System.Text.UTF8Encoding($false)).GetBytes($json+[char]10)
# Atomic create-new (no silent overwrite). Nothing is changed in source or on port 8791.
$stream=[System.IO.File]::Open($output,[System.IO.FileMode]::CreateNew,
  [System.IO.FileAccess]::Write,[System.IO.FileShare]::None)
try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) }
finally { $stream.Dispose() }
Write-Output 'VAULTER_CONTROL_CENTER_RECEIPT=CREATED'
Write-Output ('LISTENER_OBSERVATION='+$listenerObservation)
Write-Output ('LISTENER_COUNT='+$listeners.Count)
Write-Output ('SOURCE_FILE_COUNT='+$files.Count)
Write-Output ('RECEIPT_SHA256='+(Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash.ToLowerInvariant())
Write-Output 'NO_PRODUCTION_MODIFICATIONS=TRUE'
