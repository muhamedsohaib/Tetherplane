#requires -Version 5.1
<#
SYNTHETIC ONLY. Portable offline V5 rollback package contract.
No production path, account/DPAPI key, Task Scheduler registration, OAuth
token, live device, relay, or VAULTER service is read or modified.
This tests mechanics, NOT an actual owner-held recoverable backup.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Demand([bool]$condition,[string]$reason){
  if(!$condition){throw ('SYNTHETIC_RECOVERY_FAIL: '+$reason)}
}
function Digest([byte[]]$bytes){
  $h=[Security.Cryptography.SHA256]::Create()
  try {return ([BitConverter]::ToString($h.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}
  finally {$h.Dispose()}
}
function FileDigest([string]$path){
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function SafeRelative([string]$path){
  Demand (![string]::IsNullOrWhiteSpace($path)) 'empty archive path'
  Demand (!$path.StartsWith('/') -and !$path.StartsWith('\')) 'rooted archive path'
  Demand ($path -notmatch '[\\:]') 'Windows archive backslash/drive syntax'
  Demand ($path -notmatch '[\x00-\x1f]') 'control character in archive path'
  foreach($part in $path.Split('/')){
    Demand ($part -ne '' -and $part -ne '.' -and $part -ne '..') 'ambiguous or traversal archive path'
    Demand (!$part.EndsWith(' ') -and !$part.EndsWith('.')) 'ambiguous Windows filename'
  }
  return $true
}
$root=Join-Path $env:TEMP ('Tetherplane-V5-OFFLINE-RECOVERY-SYNTHETIC-'+[guid]::NewGuid().ToString('N'))
$source=Join-Path $root 'source-known-good'
$archive=Join-Path $root 'owner-offline-fixture.zip'
$corrupt=Join-Path $root 'corrupt-fixture.zip'
$traversal=Join-Path $root 'traversal-fixture.zip'
$restored=Join-Path $root 'restored'
$restoreTampered=Join-Path $root 'restored-tamper'
$restoreTraversal=Join-Path $root 'restored-traversal'

# These are invented fixture bytes; absolutely no user or production data.
$files=[ordered]@{
  'relay/cli.js'='console.log("synthetic-known-good-relay");'
  'auth/server.js'='console.log("synthetic-known-good-auth");'
  'portal/oauth.mjs'='console.log("synthetic-known-good-control-center");'
  'portal/public/index.html'='<html><body>SYNTHETIC ONLY - NOT ACCEPTED V5 ARTWORK</body></html>'
  'portal/public/tp-font.woff2'='SYNTHETIC FONT PLACEHOLDER - NOT A REAL FONT'
  'tasks/relay.xml'='<Task><Actions><Exec><Command>C:\DISPOSABLE\relay.cmd</Command></Exec></Actions></Task>'
  'tasks/auth.xml'='<Task><Actions><Exec><Command>C:\DISPOSABLE\auth.cmd</Command></Exec></Actions></Task>'
  'tasks/portal.xml'='<Task><Actions><Exec><Command>C:\DISPOSABLE\portal.cmd</Command></Exec></Actions></Task>'
  'state/device-registry.json'='{"synthetic":true,"devices":["Leno","Surface","VAULTER","RTX"]}'
  'state/owner-policy.json'='{"synthetic":true,"enabled":false,"enforcedDevices":[],"grants":[]}'
  'state/audit-checkpoint.json'='{"synthetic":true,"sequence":11,"verified":true}'
}
$utf8=[Text.UTF8Encoding]::new($false)
$manifestText=''
$manifestPin=''
function MakeArchive([string]$output,[bool]$injectTraversal){
  $zip=[IO.Compression.ZipFile]::Open($output,[IO.Compression.ZipArchiveMode]::Create)
  try{
    foreach($relative in $files.Keys){
      $path=Join-Path $source ($relative.Replace('/','\'))
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$path,$relative,[IO.Compression.CompressionLevel]::Optimal)
    }
    $entry=$zip.CreateEntry('manifest.json')
    $stream=$entry.Open()
    $writer=[IO.StreamWriter]::new($stream,$utf8)
    try {$writer.Write($manifestText)} finally {$writer.Dispose()}
    if($injectTraversal){
      $evil=$zip.CreateEntry('../escape.txt')
      $writer=[IO.StreamWriter]::new($evil.Open(),$utf8)
      try {$writer.Write('synthetic zip slip')}finally{$writer.Dispose()}
    }
  }finally {$zip.Dispose()}
}
function RestoreArchive([string]$inputZip,[string]$destination,[string]$knownManifestPin){
  Demand (!(Test-Path -LiteralPath $destination)) 'cannot overwrite a previous recovery'
  $pending=$destination+'.pending'
  Demand (!(Test-Path -LiteralPath $pending)) 'cannot overwrite pending recovery'
  $zip=[IO.Compression.ZipFile]::OpenRead($inputZip)
  $entryMap=@{}
  $verified=@{}
  try{
    foreach($entry in $zip.Entries){
      $relative=[string]$entry.FullName
      [void](SafeRelative $relative)
      $fold=$relative.ToLowerInvariant()
      Demand (!$entryMap.ContainsKey($fold)) 'duplicate case-insensitive archive path'
      Demand ($entry.Length -le 2097152) 'file exceeds disposable size budget'
      $entryMap[$fold]=$entry
    }
    Demand ($entryMap.ContainsKey('manifest.json')) 'no manifest'
    $mStream=$entryMap['manifest.json'].Open()
    $mBytes=[IO.MemoryStream]::new()
    try {$mStream.CopyTo($mBytes)}finally {$mStream.Dispose()}
    $bytes=$mBytes.ToArray();$mBytes.Dispose()
    Demand ((Digest $bytes) -ceq $knownManifestPin) 'manifest receipt pin changed'
    $manifest=$utf8.GetString($bytes)|ConvertFrom-Json -ErrorAction Stop
    Demand ($manifest.schema -ceq 'tetherplane.synthetic.v5.offline-recovery.v1') 'manifest schema mismatch'
    Demand ($manifest.marker -ceq 'SYNTHETIC_ONLY_NOT_PRODUCTION_BACKUP') 'archive is not an approved synthetic fixture'
    $mEntries=@($manifest.files)
    Demand ($mEntries.Count -eq $files.Count) 'known-good file inventory mismatch'
    Demand ($entryMap.Count -eq ($mEntries.Count+1)) 'extra or missing archive entries'
    $seen=@{}
    foreach($item in $mEntries){
      $relative=[string]$item.path
      [void](SafeRelative $relative)
      $fold=$relative.ToLowerInvariant()
      Demand (!$seen.ContainsKey($fold) -and $entryMap.ContainsKey($fold)) 'missing or duplicate expected entry'
      Demand ($fold -cne 'manifest.json') 'manifest is not data'
      Demand ([string]$item.sha256 -cmatch '^[a-f0-9]{64}$') 'malformed file receipt'
      Demand ([long]$item.length -ge 0 -and [long]$item.length -le 2097152) 'invalid file size'
      $seen[$fold]=$true
      $stream=$entryMap[$fold].Open()
      $ms=[IO.MemoryStream]::new()
      try{$stream.CopyTo($ms)}finally{$stream.Dispose()}
      $data=$ms.ToArray();$ms.Dispose()
      Demand ($data.Length -eq [long]$item.length) 'manifest length mismatch'
      Demand ((Digest $data) -ceq [string]$item.sha256) ('file modified after owner receipt: '+$relative)
      $verified[$relative]=$data
    }
  }finally{$zip.Dispose()}
  # All archive entries and receipt hashes are authenticated against the
  # caller-supplied immutable fixture pin BEFORE any restore path is touched.
  try{
    [void](New-Item -ItemType Directory -Path $pending -Force)
    foreach($relative in $verified.Keys){
      $output=Join-Path $pending ($relative.Replace('/','\'))
      [void](New-Item -ItemType Directory -Path (Split-Path $output -Parent) -Force)
      [IO.File]::WriteAllBytes($output,[byte[]]$verified[$relative])
      Demand ((Digest ([IO.File]::ReadAllBytes($output))) -ceq (Digest ([byte[]]$verified[$relative]))) 'staged restore write failed'
    }
    Move-Item -LiteralPath $pending -Destination $destination -ErrorAction Stop
  }finally{if(Test-Path -LiteralPath $pending){Remove-Item -LiteralPath $pending -Recurse -Force}}
}

try{
  [void](New-Item -ItemType Directory -Path $source -Force)
  $entries=@()
  foreach($relative in $files.Keys){
    [void](SafeRelative $relative)
    $path=Join-Path $source ($relative.Replace('/','\'))
    [void](New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force)
    [IO.File]::WriteAllText($path,[string]$files[$relative],$utf8)
    $entries+= [ordered]@{path=$relative;sha256=(FileDigest $path);length=([IO.FileInfo]$path).Length}
  }
  $manifest=[ordered]@{
    schema='tetherplane.synthetic.v5.offline-recovery.v1'
    marker='SYNTHETIC_ONLY_NOT_PRODUCTION_BACKUP'
    files=@($entries)
  }
  $manifestText=ConvertTo-Json -InputObject $manifest -Depth 6 -Compress
  $manifestPin=Digest ($utf8.GetBytes($manifestText))
  MakeArchive $archive $false
  RestoreArchive $archive $restored $manifestPin
  foreach($entry in $entries){
    $original=Join-Path $source ($entry.path.Replace('/','\'))
    $actual=Join-Path $restored ($entry.path.Replace('/','\'))
    Demand ((FileDigest $actual) -ceq (FileDigest $original)) ('known-good mismatch '+$entry.path)
  }
  $registry=Get-Content -LiteralPath (Join-Path $restored 'state\device-registry.json') -Raw|ConvertFrom-Json
  Demand ($registry.synthetic -eq $true -and @($registry.devices).Count -eq 4) 'four-device synthetic fixture was not preserved'
  $policy=Get-Content -LiteralPath (Join-Path $restored 'state\owner-policy.json') -Raw|ConvertFrom-Json
  Demand ($policy.enabled -eq $false -and @($policy.enforcedDevices).Count -eq 0 -and @($policy.grants).Count -eq 0) 'restored policy is not known-good legacy'
  Write-Output 'PORTABLE_SYNTHETIC_OFFLINE_RESTORE=PASS'
  Write-Output 'FOUR_SYNTHETIC_DEVICE_RECORDS_AND_LEGACY_POLICY=PASS'
  Write-Output ('RESTORED_FILE_COUNT='+$entries.Count)

  # Negative control: archive contains a modified relay executable with the
  # original pinned receipt. Restoration must reject before creating output.
  $relaySource=Join-Path $source 'relay\cli.js'
  $originalBytes=[IO.File]::ReadAllBytes($relaySource)
  try{
    [IO.File]::WriteAllText($relaySource,'console.log("tampered synthetic relay");',$utf8)
    MakeArchive $corrupt $false
  }finally{[IO.File]::WriteAllBytes($relaySource,$originalBytes)}
  $denied=$false
  try{RestoreArchive $corrupt $restoreTampered $manifestPin}catch{$denied=$true}
  Demand ($denied -and !(Test-Path -LiteralPath $restoreTampered)) 'tampered archive was accepted'
  Write-Output 'TAMPERED_ARCHIVE_DENIED_BEFORE_RESTORE=PASS'

  # Negative control: even an otherwise valid archive with a traversal
  # entry must be rejected before a single restored file is written.
  MakeArchive $traversal $true
  $denied=$false
  try{RestoreArchive $traversal $restoreTraversal $manifestPin}catch{$denied=$true}
  Demand ($denied -and !(Test-Path -LiteralPath $restoreTraversal)) 'path traversal was accepted'
  Demand (!(Test-Path -LiteralPath (Join-Path $root 'escape.txt'))) 'archive escaped synthetic test root'
  Write-Output 'ZIP_TRAVERSAL_AND_EXTRA_ENTRY_DENIED=PASS'
  Write-Output 'PRODUCTION_TASKS_ACCOUNTS_OAUTH_AND_DPAPI_UNTOUCHED=TRUE'
}finally{
  $prefix=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')+'\'
  $full=[IO.Path]::GetFullPath($root)
  Demand ($full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -and
    ([IO.Path]::GetFileName($full)).StartsWith('Tetherplane-V5-OFFLINE-RECOVERY-SYNTHETIC-', [StringComparison]::Ordinal)) 'unsafe fixture cleanup'
  if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop}
  Write-Output 'SYNTHETIC_RECOVERY_ROOT_REMOVED=TRUE'
}
