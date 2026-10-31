#requires -Version 5.1
<#
Tetherplane V5 Control Center: scoped Windows directory ACL hardening.
Owner-approved 2026-10-31. LOCAL VAULTER ADMIN USE ONLY.
Modes: SelfTest / Prepare / Apply / Verify / Rollback.
No authentication, process, task, or device authorization modifications.
Prepare makes a user-DPAPI-encrypted, verified code/ACL rollback package.
Apply refuses to run without that package and independently rechecks live state.
This is a local restore, not a replacement for an independently stored offline backup.
Never paste receipt contents, task XML, or credentials into a chat.
#>
[CmdletBinding()]
param(
  [ValidateSet('SelfTest','Prepare','Apply','Verify','Rollback')]
  [string]$Mode='Prepare',
  [string]$ReceiptId=''
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
# Windows PowerShell 5.1 does not automatically load DPAPI's System.Security assembly.
Add-Type -AssemblyName System.Security
$Target='C:\ProgramData\Tetherplane\ControlCenterReleases'
$Edition='20261025-effective-access-09ea09b'
$Portal=Join-Path (Join-Path $Target $Edition) 'oauth.mjs'
$PortalHash='afab023ea2de6d64d717314082c0d3c1f919ef1d84d426cf1bd9212b612f0a59'
$HtmlHash='4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8'
$FontHash='18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e'
$TaskName='Tetherplane Control Center OAuth 20261024'
$TaskXmlHash='4c66a33f4e4b0493f1aa5a964bf60831bc5f9c0e86e5f2598b375c53679b1323'
$BackupRoot=Join-Path $env:LOCALAPPDATA 'Tetherplane\V5AclRollback'
$UsersSid='S-1-5-32-545'
$SystemSid='S-1-5-18'
$AdminsSid='S-1-5-32-544'
$WriteMask=[long]852310

function Assert-LocalAdmin {
  if($env:COMPUTERNAME -ine 'VAULTER') {throw 'BLOCKED: VAULTER only.'}
  $id=[Security.Principal.WindowsIdentity]::GetCurrent()
  $p=New-Object Security.Principal.WindowsPrincipal($id)
  if(!$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'BLOCKED: run from a local elevated VAULTER PowerShell window.'
  }
}
function SHA([string]$path) {
  if(!(Test-Path -LiteralPath $path -PathType Leaf)){throw 'Required file missing.'}
  (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Under([string]$path,[string]$root) {
  if([string]::IsNullOrWhiteSpace($path) -or ![IO.Path]::IsPathRooted($path)){throw 'Path not absolute.'}
  $p=[IO.Path]::GetFullPath($path).TrimEnd('\')
  $r=[IO.Path]::GetFullPath($root).TrimEnd('\')
  $p.Equals($r,[StringComparison]::OrdinalIgnoreCase) -or
    $p.StartsWith($r+'\',[StringComparison]::OrdinalIgnoreCase)
}
function Arg([string]$cmd,[string]$flag) {
  $pat='(?i)(?:^|\s)'+[regex]::Escape($flag)+'(?:\s+|=)(?:"([^"]+)"|(\S+))'
  $m=[regex]::Match($cmd,$pat)
  if(!$m.Success){return $null}
  if($m.Groups[1].Success){return $m.Groups[1].Value}
  return $m.Groups[2].Value
}
function UsersWriteRules([string]$path) {
  @( (Get-Acl -LiteralPath $path).Access | Where-Object {
    $sid=try{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{''}
    $sid -eq $UsersSid -and $_.AccessControlType -eq 'Allow' -and
      (([long]$_.FileSystemRights -band $WriteMask) -ne 0)
  })
}
function Assert-NoReparse([string]$path) {
  if(!(Test-Path -LiteralPath $path)) {throw 'Expected path missing.'}
  if(((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
    throw 'BLOCKED: reparse point in protected code path.'
  }
}
function Assert-CleanTree([string]$root) {
  $p=[IO.Path]::GetFullPath($root)
  while($p -and (Test-Path -LiteralPath $p)) {
    Assert-NoReparse $p
    $parent=[IO.Path]::GetDirectoryName($p.TrimEnd('\'))
    if(!$parent -or $parent -eq $p){break}
    $p=$parent
  }
  $children=@(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop)
  foreach($child in $children) {
    if(($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'BLOCKED: reparse point below code directory.'}
  }
  $files=@($children | Where-Object { !$_.PSIsContainer })
  $total=($files|Measure-Object -Property Length -Sum).Sum
  if($files.Count -gt 6000 -or $total -gt 268435456){
    throw 'BLOCKED: source backup exceeds tested bounds (6000 files / 256 MiB).'
  }
  Write-Host ('CODE_FILE_COUNT='+$files.Count)
  Write-Host ('CODE_TOTAL_MB='+[math]::Round(([double]$total/1MB),1))
}
function TaskHash([string]$name) {
  $task=Get-ScheduledTask -TaskName $name -ErrorAction Stop
  $xml=Export-ScheduledTask -TaskName $name -TaskPath $task.TaskPath -ErrorAction Stop
  $hash=[Security.Cryptography.SHA256]::Create()
  try {
    $raw=[Text.Encoding]::UTF8.GetBytes($xml)
    ([BitConverter]::ToString($hash.ComputeHash($raw))).Replace('-','').ToLowerInvariant()
  } finally {$hash.Dispose()}
}
function Audit-Live([bool]$requireBefore) {
  Assert-LocalAdmin
  Assert-CleanTree $Target
  if((SHA $Portal) -cne $PortalHash){throw 'BLOCKED: deployed V5 code hash drift.'}
  if((SHA (Join-Path (Split-Path $Portal) 'public\index.html')) -cne $HtmlHash){throw 'BLOCKED: accepted V5 HTML drift.'}
  if((SHA (Join-Path (Split-Path $Portal) 'public\tp-font.woff2')) -cne $FontHash){throw 'BLOCKED: accepted private font drift.'}
  if((TaskHash $TaskName) -cne $TaskXmlHash){throw 'BLOCKED: portal scheduled-task XML changed.'}
  $task=Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if($task.State -ne 'Running' -or @($task.Actions).Count -ne 1 -or
     $task.Principal.LogonType -ne 'S4U' -or $task.Principal.RunLevel -ne 'Limited') {
    throw 'BLOCKED: unexpected portal task state or identity.'
  }
  foreach($port in @(8788,8790,8791)) {
    $listeners=@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)
    if(@($listeners | Select-Object -ExpandProperty OwningProcess -Unique).Count -ne 1 -or
       @($listeners | Where-Object {$_.LocalAddress -notin @('127.0.0.1','::1')}).Count -gt 0) {
      throw 'BLOCKED: changed loopback listener structure.'
    }
  }
  $portalSocket=@(Get-NetTCPConnection -LocalPort 8791 -State Listen -ErrorAction Stop)[0]
  $proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+[string]$portalSocket.OwningProcess) -ErrorAction Stop
  if(!$proc -or $proc.Name -ne 'node.exe' -or [string]$proc.CommandLine -notlike ('*'+$Portal+'*')) {
    throw 'BLOCKED: portal process does not correspond to approved entrypoint.'
  }
  $cmd=[string]$proc.CommandLine
  $config=Arg $cmd '--authority-config'
  $oauth=Arg $cmd '--oauth-config'
  if(!$config -or !$oauth){throw 'BLOCKED: live authority and OAuth config path not both resolvable.'}
  foreach($file in @($config,$oauth)){
    if(Under $file $Target){throw 'BLOCKED: configuration inside immutable code subtree.'}
    if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw 'BLOCKED: declared config missing.'}
  }
  $authority=Get-Content -LiteralPath $config -Raw -ErrorAction Stop | ConvertFrom-Json
  if(!$authority.journalPath -or !$authority.checkpointPath){throw 'BLOCKED: audit paths unavailable.'}
  foreach($path in @($authority.journalPath,$authority.checkpointPath,
                     ([string]$authority.journalPath+'.writer.lock'),
                     ([string]$authority.checkpointPath+'.pending-check'))) {
    if(Under $path $Target){throw 'BLOCKED: portal audit/lock writes inside code subtree.'}
  }
  foreach($p in @($authority.journalPath,$authority.checkpointPath)) {
    if(!(Test-Path -LiteralPath $p -PathType Leaf)){throw 'BLOCKED: protected audit file missing.'}
  }
  $action=[string]$task.Actions[0].Execute
  $actionBase=[IO.Path]::GetFileName($action).ToLowerInvariant()
  # A wrapper can redirect logs into the code folder without advertising them
  # in the Node command line. Do not mutate under an unreviewed wrapper.
  if($actionBase -notin @('node.exe','node')) {
    throw 'BLOCKED: portal starts via wrapper; owner must first review write/log destinations.'
  }
  if(([string]$task.Actions[0].Arguments) -notlike ('*'+$Portal+'*')) {
    throw 'BLOCKED: task source differs from running process.'
  }
  $writeRules=@(UsersWriteRules $Target)
  if($requireBefore -and $writeRules.Count -ne 1){throw 'BLOCKED: unexpected original Users Write ACE count.'}
  if(!$requireBefore -and $writeRules.Count -ne 0){throw 'BLOCKED: Users Write ACE still present.'}
  if(!$requireBefore -and !(Get-Acl -LiteralPath $Target).AreAccessRulesProtected){throw 'BLOCKED: target inheritance not protected.'}
  $dirs=@((Get-Item -LiteralPath $Target)) + @(Get-ChildItem -LiteralPath $Target -Recurse -Directory -Force)
  foreach($dir in $dirs){
    if(!$requireBefore -and @(UsersWriteRules $dir.FullName).Count -gt 0){throw 'BLOCKED: descendant directory still writable to Users.'}
  }
  $h=[ordered]@{
    Portal=(SHA $Portal);
    Html=(SHA (Join-Path (Split-Path $Portal) 'public\index.html'));
    Font=(SHA (Join-Path (Split-Path $Portal) 'public\tp-font.woff2'));
    Task=(TaskHash $TaskName);
    NodePid=[int]$proc.ProcessId;
    Dacl=(Get-Acl -LiteralPath $Target).Sddl
  }
  Write-Host 'LIVE_PORTAL_IDENTITY=VERIFIED'
  Write-Host 'LIVE_PORTAL_WRITE_PATHS=OUTSIDE_CODE_SUBTREE'
  Write-Host 'LIVE_LOOPBACK_SERVICES=VERIFIED'
  Write-Host ('TARGET_USERS_WRITE_ACE_COUNT='+$writeRules.Count)
  return [pscustomobject]$h
}
function SecureBackupDir([string]$path) {
  if(!(Test-Path -LiteralPath $path)){New-Item -ItemType Directory -Path $path -Force | Out-Null}
  $acl=Get-Acl -LiteralPath $path
  $acl.SetAccessRuleProtection($true,$false)
  foreach($sidText in @($SystemSid,$AdminsSid,([Security.Principal.WindowsIdentity]::GetCurrent().User.Value))) {
    $sid=New-Object Security.Principal.SecurityIdentifier($sidText)
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $acl
  if(!(Get-Acl -LiteralPath $path).AreAccessRulesProtected){throw 'Backup ACL not protected.'}
  if(@(UsersWriteRules $path).Count -ne 0){throw 'Backup directory broadly writable.'}
}
function ProtectBytes([byte[]]$bytes) {
  [Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
}
function UnprotectBytes([byte[]]$bytes) {
  [Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
}
function ByteHash([byte[]]$bytes) {
  $h=[Security.Cryptography.SHA256]::Create()
  try {([BitConverter]::ToString($h.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}
  finally {$h.Dispose()}
}
function PrepareBackup($live) {
  if(Under $BackupRoot $Target){throw 'Backup directory inside code subtree.'}
  SecureBackupDir $BackupRoot
  $id=([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))+'-'+[guid]::NewGuid().ToString('N')
  $folder=Join-Path $BackupRoot $id
  SecureBackupDir $folder
  $tempZip=Join-Path $folder 'snapshot-plaintext.tmp.zip'
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($Target,$tempZip,[IO.Compression.CompressionLevel]::Optimal,$true)
    if((Get-Item -LiteralPath $tempZip).Length -gt 134217728){throw 'BLOCKED: compressed rollback package exceeds 128 MiB.'}
    $plain=[IO.File]::ReadAllBytes($tempZip)
    $plainHash=ByteHash $plain
    $encrypted=ProtectBytes $plain
    [IO.File]::WriteAllBytes((Join-Path $folder 'code.zip.dpapi'),$encrypted)
    $restored=UnprotectBytes ([IO.File]::ReadAllBytes((Join-Path $folder 'code.zip.dpapi')))
    if((ByteHash $restored) -cne $plainHash){throw 'Encrypted snapshot cannot be independently decrypted.'}
    $tmp=Join-Path $folder 'restore-check'
    New-Item -ItemType Directory -Path $tmp -ErrorAction Stop | Out-Null
    try {
      $checkZip=Join-Path $folder 'restore-check.tmp.zip'
      try {
        [IO.File]::WriteAllBytes($checkZip,$restored)
        [IO.Compression.ZipFile]::ExtractToDirectory($checkZip,$tmp)
        $base=Join-Path $tmp 'ControlCenterReleases'
        foreach($relative in @(
          (Join-Path $Edition 'oauth.mjs'),
          (Join-Path $Edition 'public\index.html'),
          (Join-Path $Edition 'public\tp-font.woff2')
        )) {
          $src=Join-Path $Target $relative
          $recovered=Join-Path $base $relative
          if((SHA $src) -cne (SHA $recovered)){throw 'Encrypted code backup restore hash verification failed.'}
        }
      } finally {
        if(Test-Path $checkZip){Remove-Item -LiteralPath $checkZip -Force}
      }
    } finally {
      if(Test-Path $tmp){Remove-Item -LiteralPath $tmp -Recurse -Force}
    }
    $task=Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $taskXml=Export-ScheduledTask -TaskName $TaskName -TaskPath $task.TaskPath
    [IO.File]::WriteAllBytes((Join-Path $folder 'task.xml.dpapi'),(ProtectBytes ([Text.Encoding]::UTF8.GetBytes($taskXml))))
    $restoredTaskXml = [Text.Encoding]::UTF8.GetString((UnprotectBytes ([IO.File]::ReadAllBytes((Join-Path $folder 'task.xml.dpapi')))))
    if($restoredTaskXml -cne $taskXml){throw 'Protected task export verification failed.'}
    $record=[ordered]@{
      version=1;state='PREPARED';receiptId=$id;host=$env:COMPUTERNAME;
      userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      target=$Target;utc=[DateTime]::UtcNow.ToString('o');
      beforeSddl=$live.Dacl;portalSha=$live.Portal;htmlSha=$live.Html;
      fontSha=$live.Font;taskXmlSha=$live.Task;codeZipSha=$plainHash;
      encryptedZipSha=ByteHash $encrypted;afterSddl=$null
    }
    $json=ConvertTo-Json $record -Depth 5
    [IO.File]::WriteAllText((Join-Path $folder 'receipt.json'),$json,[Text.UTF8Encoding]::new($false))
    Write-Host ('BACKUP_RECEIPT_ID='+$id)
    Write-Host 'ENCRYPTED_CODE_BACKUP_VERIFIED=True'
    Write-Host 'ENCRYPTED_TASK_XML_BACKUP_VERIFIED=True'
    Write-Host 'SOURCE_RESTORE_HASH_VERIFIED=True'
    Write-Host 'LOCAL_OWNER_DPAPI_BACKUP_ONLY=True'
    return $id
  } finally {
    if(Test-Path -LiteralPath $tempZip){Remove-Item -LiteralPath $tempZip -Force}
  }
}
function LoadReceipt([string]$id) {
  if($id -notmatch '^\d{8}T\d{6}Z-[a-f0-9]{32}$'){throw 'BLOCKED: receipt ID invalid.'}
  $folder=Join-Path $BackupRoot $id
  $p=Join-Path $folder 'receipt.json'
  if(!(Test-Path -LiteralPath $p -PathType Leaf)){throw 'BLOCKED: receipt file unavailable.'}
  $data=Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
  if($data.version -ne 1 -or $data.receiptId -cne $id -or
     $data.host -cne 'VAULTER' -or $data.target -cne $Target -or
     $data.userSid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'BLOCKED: protected receipt identity mismatch.'}
  if(@(UsersWriteRules $folder).Count -ne 0 -or !(Get-Acl $folder).AreAccessRulesProtected){throw 'BLOCKED: backup ACL insecure.'}
  $zip=Join-Path $folder 'code.zip.dpapi'
  $encrypted=[IO.File]::ReadAllBytes($zip)
  if((ByteHash $encrypted) -cne $data.encryptedZipSha){throw 'BLOCKED: ciphertext backup changed.'}
  if((ByteHash (UnprotectBytes $encrypted)) -cne $data.codeZipSha){throw 'BLOCKED: protected backup cannot be restored.'}
  $taskBytes=UnprotectBytes ([IO.File]::ReadAllBytes((Join-Path $folder 'task.xml.dpapi')))
  $h=ByteHash $taskBytes
  if($h -cne $data.taskXmlSha){throw 'BLOCKED: encrypted scheduled-task receipt mismatched.'}
  return [pscustomobject]@{Data=$data;Folder=$folder;File=$p}
}
function SaveReceipt($receipt) {
  $json=ConvertTo-Json $receipt.Data -Depth 5
  $pending=$receipt.File+'.pending'
  [IO.File]::WriteAllText($pending,$json,[Text.UTF8Encoding]::new($false))
  # Atomic replacement keeps the original receipt readable on abrupt process exit.
  [IO.File]::Replace($pending,$receipt.File,$null)
}
function Acquire-ExclusiveReceiptLock {
  if(!(Test-Path -LiteralPath $BackupRoot -PathType Container)){
    throw 'Protected backup root does not exist.'
  }
  $lock=Join-Path $BackupRoot 'exclusive-operation.lock'
  try {
    $script:ReceiptLock=[IO.File]::Open($lock,[IO.FileMode]::OpenOrCreate,
      [IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  } catch {throw 'Another Tetherplane ACL operation is running or lock is unavailable.'}
}
function RestoreDacl([string]$sddl) {
  $a=Get-Acl -LiteralPath $Target
  $a.SetSecurityDescriptorSddlForm($sddl,[Security.AccessControl.AccessControlSections]::Access)
  Set-Acl -LiteralPath $Target -AclObject $a
  $now=(Get-Acl -LiteralPath $Target).Sddl
  if($now -cne $sddl){throw 'DACL restore result differs from original SDDL.'}
}
function ApplyDacl {
  $a=Get-Acl -LiteralPath $Target
  $a.SetAccessRuleProtection($true,$true)
  Set-Acl -LiteralPath $Target -AclObject $a
  $a=Get-Acl -LiteralPath $Target
  if(!$a.AreAccessRulesProtected){throw 'Inheritance protection did not persist.'}
  $remove=@(UsersWriteRules $Target)
  if($remove.Count -ne 1 -or $remove[0].IsInherited){throw 'Unexpected copied ACL: refusing to remove.'}
  $a.RemoveAccessRuleSpecific($remove[0])
  Set-Acl -LiteralPath $Target -AclObject $a
}

if($Mode -eq 'SelfTest') {
  if((([long][Security.AccessControl.FileSystemRights]::Read -band $WriteMask) -ne 0) -or
     (([long][Security.AccessControl.FileSystemRights]::Write -band $WriteMask) -eq 0)) {
    throw 'ACL write-mask self-test failed.'
  }
  $sim=Join-Path $env:TEMP ('tp-v5-acl-script-selftest-'+[guid]::NewGuid().ToString('N'))
  $savedTarget=$Target
  try {
    $example=Join-Path $sim 'ControlCenterReleases'
    $nested=Join-Path $example 'accepted-v5\public'
    New-Item -ItemType Directory -Path $nested -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $nested 'index.html'),'synthetic')
    $sample=[Text.Encoding]::UTF8.GetBytes('Tetherplane private synthetic rehearsal')
    $encoded=ProtectBytes $sample
    if((ByteHash (UnprotectBytes $encoded)) -cne (ByteHash $sample)){throw 'DPAPI self-test failed.'}
    $acl=Get-Acl -LiteralPath $sim
    $sid=New-Object Security.Principal.SecurityIdentifier($UsersSid)
    $rx=New-Object Security.AccessControl.FileSystemAccessRule($sid,
      [Security.AccessControl.FileSystemRights]::ReadAndExecute,
      [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow)
    $write=New-Object Security.AccessControl.FileSystemAccessRule($sid,
      [Security.AccessControl.FileSystemRights]::Write,
      [Security.AccessControl.InheritanceFlags]::ContainerInherit,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rx)
    $acl.AddAccessRule($write)
    Set-Acl -LiteralPath $sim -AclObject $acl
    $script:Target=$example
    $before=(Get-Acl -LiteralPath $example).Sddl
    if(@(UsersWriteRules $example).Count -ne 1){throw 'Synthetic ACL baseline not established.'}
    ApplyDacl
    foreach($dir in @($example,$nested)) {
      if(@(UsersWriteRules $dir).Count -ne 0){throw 'Synthetic ACL repair failed.'}
    }
    RestoreDacl $before
    if(@(UsersWriteRules $example).Count -ne 1){throw 'Synthetic ACL rollback failed.'}
    Write-Output 'ACL_MASK_SELFTEST=PASS'
    Write-Output 'DPAPI_CURRENT_USER_SELFTEST=PASS'
    Write-Output 'EXACT_TWO_PASS_ACL_AND_ROLLBACK_SELFTEST=PASS'
  } finally {
    $script:Target=$savedTarget
    if(Test-Path $sim){Remove-Item -LiteralPath $sim -Recurse -Force}
  }
  return
}
if($Mode -eq 'Prepare') {
  $live=Audit-Live $true
  SecureBackupDir $BackupRoot
  Acquire-ExclusiveReceiptLock
  [void](PrepareBackup $live)
  Write-Output 'PREPARED_ONLY: NO LIVE ACL WAS CHANGED.'
  return
}
if($Mode -eq 'Apply') {
  Assert-LocalAdmin
  Acquire-ExclusiveReceiptLock
  $receipt=LoadReceipt $ReceiptId
  if($receipt.Data.state -ne 'PREPARED'){throw 'BLOCKED: only a prepared receipt can be applied.'}
  $live=Audit-Live $true
  if($live.Dacl -cne $receipt.Data.beforeSddl -or $live.Task -cne $receipt.Data.taskXmlSha -or
     $live.Portal -cne $receipt.Data.portalSha){throw 'BLOCKED: baseline changed since backup.'}
  $receipt.Data.state='APPLY_STARTED';SaveReceipt $receipt
  try {
    ApplyDacl
    $after=Audit-Live $false
    if($after.Portal -cne $receipt.Data.portalSha -or $after.Html -cne $receipt.Data.htmlSha -or
       $after.Font -cne $receipt.Data.fontSha){throw 'Protected assets changed during ACL update.'}
    $receipt.Data.afterSddl=$after.Dacl
    $receipt.Data.state='APPLIED';SaveReceipt $receipt
    Write-Output 'VAULTER_V5_ACL_HARDENING=APPLIED_AND_VERIFIED'
    Write-Output ('BACKUP_RECEIPT_ID='+$ReceiptId)
    Write-Output 'AUTHENTICATION_AND_TASKS_UNCHANGED=True'
  } catch {
    $errorSummary=$_.Exception.Message
    try {
      RestoreDacl $receipt.Data.beforeSddl
      $receipt.Data.state='AUTO_ROLLED_BACK';SaveReceipt $receipt
      Write-Output 'AUTOMATIC_ACL_ROLLBACK=VERIFIED'
    } catch {
      Write-Output 'AUTOMATIC_ACL_ROLLBACK=UNCONFIRMED; LOCAL_OWNER_RECOVERY_REQUIRED'
    }
    throw ('ACL apply stopped: '+$errorSummary)
  }
  return
}
if($Mode -eq 'Verify') {
  $receipt=LoadReceipt $ReceiptId
  if($receipt.Data.state -ne 'APPLIED'){throw 'Receipt does not identify applied ACL.'}
  $live=Audit-Live $false
  if($live.Dacl -cne $receipt.Data.afterSddl){throw 'ACL drift after apply.'}
  Write-Output 'VAULTER_V5_ACL_VERIFICATION=PASS'
  return
}
if($Mode -eq 'Rollback') {
  Assert-LocalAdmin
  Acquire-ExclusiveReceiptLock
  $receipt=LoadReceipt $ReceiptId
  if($receipt.Data.state -notin @('APPLIED','APPLY_STARTED')){throw 'No unapplied receipt to roll back.'}
  if($receipt.Data.afterSddl -and (Get-Acl $Target).Sddl -cne $receipt.Data.afterSddl){
    throw 'BLOCKED: new ACL changes detected; do not overwrite independently changed permissions.'
  }
  if((SHA $Portal) -cne $receipt.Data.portalSha){throw 'BLOCKED: source changed since ACL update.'}
  RestoreDacl $receipt.Data.beforeSddl
  $receipt.Data.state='ROLLED_BACK';SaveReceipt $receipt
  Write-Output 'VAULTER_V5_ORIGINAL_ACL_ROLLBACK=VERIFIED'
  return
}
