#requires -Version 5.1
<#
VAULTER V5 owner-admin READ-ONLY recovery coverage audit.
No backups are created, decrypted, copied, exported or modified.
Checks the existing local DPAPI receipt and live service identities without
printing credentials, task arguments, SDDL, user IDs, registry, or XML contents.
The existing receipt is portal-code + one task only, NOT whole-stack disaster
recovery. This must not be used to perform or authorize a production cutover.
#>
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)]
 [ValidatePattern('^\d{8}T\d{6}Z-[a-f0-9]{32}$')]
 [string]$ReceiptId
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if([Environment]::MachineName -ine 'VAULTER'){
 throw 'HOST_GUARD_BLOCKED: owner-run this audit locally on VAULTER only.'
}
$backupRoot=Join-Path $env:LOCALAPPDATA 'Tetherplane\V5AclRollback'
$folder=Join-Path $backupRoot $ReceiptId
$target='C:\ProgramData\Tetherplane\ControlCenterReleases'
$edition='20261025-effective-access-09ea09b'
$portal=Join-Path (Join-Path $target $edition) 'oauth.mjs'
$portalExpected='afab023ea2de6d64d717314082c0d3c1f919ef1d84d426cf1bd9212b612f0a59'
$htmlExpected='4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8'
$fontExpected='18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e'
$taskName='Tetherplane Control Center OAuth 20261024'
$taskHash='4c66a33f4e4b0493f1aa5a964bf60831bc5f9c0e86e5f2598b375c53679b1323'
$writeMask=[long]852310
function Assert([bool]$condition,[string]$reason) {
 if(!$condition){throw ('READONLY_RECOVERY_BLOCKED: '+$reason)}
}
function Hash([string]$path){
 Assert (Test-Path -LiteralPath $path -PathType Leaf) 'expected file is absent'
 return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function HashBytes([byte[]]$bytes){
 $sha=[Security.Cryptography.SHA256]::Create()
 try{return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}
 finally{$sha.Dispose()}
}
function NoReparse([string]$path){
 $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
 Assert (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'symlink/reparse material is not acceptable'
}
function SecureAcl([string]$path){
 $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
 Assert ($acl.AreAccessRulesProtected) 'recovery folder DACL inheritance not protected'
 $bad=@($acl.Access | Where-Object {
   if($_.AccessControlType -ne 'Allow'){return $false}
   $sid=try{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{''}
   return ($sid -in @('S-1-1-0','S-1-5-11','S-1-5-32-545')) -and
     (([long]$_.FileSystemRights -band $writeMask) -ne 0)
 })
 Assert ($bad.Count -eq 0) 'broad group can modify receipt folder'
}
function CurrentUserSid {
 return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}
function TaskFingerprint {
 $task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
 Assert ($task.State -eq 'Running') 'protected Control Center task not running'
 Assert (@($task.Actions).Count -eq 1) 'protected task action-count changed'
 Assert ($task.Principal.LogonType -eq 'S4U' -and $task.Principal.RunLevel -eq 'Limited') 'protected task principal changed'
 $xml=[Text.Encoding]::UTF8.GetBytes((Export-ScheduledTask -TaskName $taskName -TaskPath $task.TaskPath))
 return (HashBytes $xml)
}
function MatchFile([string]$path,[string]$expected,[string]$label){
 $actual=Hash $path
 Assert ($actual -ceq $expected) ($label+' fingerprint changed')
}
Write-Output '=== VAULTER V5 RECOVERY COVERAGE AUDIT - READ ONLY ==='
Write-Output ('OBSERVED_UTC='+[DateTime]::UtcNow.ToString('o'))
Write-Output 'HOST_GUARD=VAULTER'
Write-Output 'TASK_ARGUMENTS_CREDENTIALS_AND_RECEIPT_CONTENTS_REDACTED=TRUE'
NoReparse $backupRoot
NoReparse $folder
SecureAcl $backupRoot
SecureAcl $folder
Write-Output 'DPAPI_LOCAL_BACKUP_DIRECTORY_ACL=PASS'
$receiptFile=Join-Path $folder 'receipt.json'
$zipFile=Join-Path $folder 'code.zip.dpapi'
$xmlFile=Join-Path $folder 'task.xml.dpapi'
foreach($f in @($receiptFile,$zipFile,$xmlFile)){NoReparse $f}
$receipt=Get-Content -LiteralPath $receiptFile -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop
Assert ($receipt.version -eq 1 -and $receipt.receiptId -ceq $ReceiptId -and $receipt.host -ceq 'VAULTER') 'receipt identity/version mismatch'
Assert ($receipt.target -ceq $target -and $receipt.userSid -ceq (CurrentUserSid)) 'owner or target changed'
Assert ($receipt.state -ceq 'APPLIED') 'expected completed owner ACL-application receipt absent'
Assert ([string]$receipt.codeZipSha -cmatch '^[0-9a-f]{64}$') 'plaintext receipt checksum malformed'
Assert ([string]$receipt.encryptedZipSha -cmatch '^[0-9a-f]{64}$') 'encrypted checksum malformed'
Assert ([string]$receipt.taskXmlSha -cmatch '^[0-9a-f]{64}$') 'task checksum malformed'
Assert ([string]$receipt.beforeSddl -match '^O:|^D:') 'original DACL recovery receipt missing'
Assert ([string]$receipt.afterSddl -match '^O:|^D:') 'post-apply DACL receipt missing'
$encrypted=[IO.File]::ReadAllBytes($zipFile)
Assert ($encrypted.Length -gt 0 -and $encrypted.Length -le 268435456) 'DPAPI protected archive size unreasonable'
Assert ((HashBytes $encrypted) -ceq [string]$receipt.encryptedZipSha) 'DPAPI ciphertext hash does not match owner receipt'
$taskBlob=[IO.File]::ReadAllBytes($xmlFile)
Assert ($taskBlob.Length -gt 0 -and $taskBlob.Length -le 1048576) 'DPAPI task XML blob size unreasonable'
Write-Output 'RECEIPT_STATE_APPLIED_AND_ENCRYPTED_HASH=PASS'
Write-Output 'DPAPI_PROFILE_DEPENDENCY=YES'
Write-Output 'CURRENT_USER_DPAPI_DECRYPTION_NOT_ATTEMPTED=TRUE'
MatchFile $portal $portalExpected 'V5 portal'
$public=Join-Path (Split-Path -Parent $portal) 'public'
MatchFile (Join-Path $public 'index.html') $htmlExpected 'V5 accepted private HTML'
MatchFile (Join-Path $public 'tp-font.woff2') $fontExpected 'V5 accepted private font'
Write-Output 'LIVE_ACCEPTED_V5_CODE_AND_ARTWORK=PASS'
Assert ((TaskFingerprint) -ceq $taskHash) 'protected task XML hash drift'
Write-Output 'LIVE_PORTAL_TASK_IDENTITY_AND_HASH=PASS'
$port=@(Get-NetTCPConnection -State Listen -LocalPort 8791 -ErrorAction Stop)
Assert ($port.Count -ge 1 -and @($port|Select-Object -ExpandProperty OwningProcess -Unique).Count -eq 1) 'portal listener ambiguity'
Assert (@($port|Where-Object{$_.LocalAddress -notin @('127.0.0.1','::1')}).Count -eq 0) 'portal no longer loopback-only'
Write-Output 'PORTAL_LISTENER_LOOPBACK_AND_SINGLE_OWNER=PASS'
Write-Output 'RECEIPT_COVERAGE=CONTROL_CENTER_CODE_PLUS_ONE_TASK_XML_AND_DACL'
Write-Output 'RELAY_RUNTIME_AUTH_SERVICE_AND_DEVICE_REGISTRY_RECOVERY=NOT_INCLUDED_IN_RECEIPT'
Write-Output 'OFF_HOST_PRIVATE_RECOVERY_KEY=NOT_VERIFIED'
Write-Output 'CROSS_HOST_REAL_BACKUP_DECRYPTION=NOT_TESTED'
Write-Output 'AUDIT_PERFORMED_NO_OAUTH_DEVICE_OR_TASK_MUTATIONS=TRUE'
Write-Output 'RECOVERY_COVERAGE_AUDIT_COMPLETE_NO_GO_FOR_CUTOVER'
