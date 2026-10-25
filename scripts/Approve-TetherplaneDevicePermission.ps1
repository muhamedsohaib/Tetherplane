# Tetherplane device-local policy editor. Never run through the remote relay.
# Portal review requests are UNTRUSTED until an operator on the target device
# inspects their exact contents and confirms them at the physical console.
[CmdletBinding()]
param(
    [string]$RequestPath='',
    [Parameter(Mandatory=$true)][string]$PrincipalPath,
    [ValidateSet('Inspect','Apply','Restore')][string]$Mode='Inspect',
    [string]$ExpectedPrincipalSha256='',
    [string]$ReceiptPath=''
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Assert([bool]$ok,[string]$why) { if(-not $ok) { throw $why } }
function HashFile([string]$p) { return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
function CheckPath([string]$p) {
    $full=[IO.Path]::GetFullPath($p)
    Assert (-not $full.StartsWith('\\')) 'UNC paths are not supported for protected policy operations'
    $cur=$full;$root=[IO.Path]::GetPathRoot($cur)
    while($cur) {
        if(Test-Path -LiteralPath $cur) {
            $item=Get-Item -LiteralPath $cur -Force
            Assert (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Refuse redirected protected path'
        }
        if($cur -eq $root){break}
        $next=[IO.Path]::GetDirectoryName($cur)
        if(-not $next -or $next -eq $cur){break}
        $cur=$next
    }
    return $full
}
function JsonFile([string]$p) {
    try{return (Get-Content -LiteralPath $p -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop)}
    catch{throw 'Invalid JSON in local policy or approval request'}
}
function Field($v,[string]$name) {
    $property=$v.PSObject.Properties[$name]
    Assert ($null -ne $property) ('Missing required field '+$name)
    return $property.Value
}
function WriteJsonNew([string]$path,$value) {
    Assert (-not (Test-Path -LiteralPath $path)) 'Refuse to overwrite local evidence'
    $utf8=New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($path,(ConvertTo-Json -InputObject $value -Depth 12)+([char]10),$utf8)
}
function ContainedIn([string]$target,[string]$root) {
    $a=[IO.Path]::GetFullPath($target).TrimEnd('\')
    $b=[IO.Path]::GetFullPath($root).TrimEnd('\')
    return ($a.Equals($b,[StringComparison]::OrdinalIgnoreCase) -or
        $a.StartsWith($b+'\', [StringComparison]::OrdinalIgnoreCase))
}
function AssertProtectedDacl([string]$path) {
    $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
    Assert ($acl.AreAccessRulesProtected) 'Permission profile and parent must have inheritance disabled and a reviewed protected ACL'
    $write=[int][Security.AccessControl.FileSystemRights]::Write
    $modify=[int][Security.AccessControl.FileSystemRights]::Modify
    $full=[int][Security.AccessControl.FileSystemRights]::FullControl
    foreach($rule in $acl.Access) {
        if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}
        if((([int]$rule.FileSystemRights) -band ($write -bor $modify -bor $full)) -eq 0){continue}
        $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        Assert ($sid -in @('S-1-5-18','S-1-5-32-544')) 'Device policy write access must be restricted to SYSTEM and Administrators'
    }
}
function ConfirmLocal([string]$exact) {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $operator=New-Object Security.Principal.WindowsPrincipal($identity)
    Assert ($operator.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'Elevated local Windows administrator required'
    Assert ($Host.Name -eq 'ConsoleHost') 'A local Windows console is required'
    Assert (-not [Console]::IsInputRedirected) 'A local interactive keyboard is required; piped input denied'
    $answer=Read-Host ('On THIS DEVICE, type '+$exact)
    Assert ($answer -ceq $exact) 'Local operator did not enter the exact approval phrase'
}
if($Mode -eq 'Restore') {
    Assert (-not [string]::IsNullOrWhiteSpace($ReceiptPath)) 'ReceiptPath is required for restore'
    $profilePath=CheckPath $PrincipalPath
    $recordPath=CheckPath $ReceiptPath
    Assert (Test-Path -LiteralPath $profilePath -PathType Leaf) 'Principal file missing'
    Assert (Test-Path -LiteralPath $recordPath -PathType Leaf) 'Recovery receipt missing'
    Assert ([IO.Path]::GetDirectoryName($recordPath) -ieq [IO.Path]::GetDirectoryName($profilePath)) 'Recovery receipt must accompany the protected principal'
    $record=JsonFile $recordPath
    Assert ((Field $record 'schema') -ceq 'tetherplane.device_local_policy_recovery.v1') 'Unrecognized recovery schema'
    $deviceId=[string](Field $record 'deviceId')
    $capability=[string](Field $record 'capability')
    Assert ($deviceId -cmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') 'Invalid recovery device ID'
    Assert ($capability -cmatch '^(filesystem|process|browser|desktop|batch)\.[a-z][a-z0-9_]{0,63}$') 'Invalid recovery capability'
    Assert ((Field $record 'principalPath') -ceq $profilePath) 'Recovery receipt is for another profile'
    $oldHash=[string](Field $record 'oldSha256')
    $newHash=[string](Field $record 'newSha256')
    Assert ($oldHash -cmatch '^[a-f0-9]{64}$' -and $newHash -cmatch '^[a-f0-9]{64}$') 'Malformed recovery hashes'
    $backup=CheckPath ([string](Field $record 'backupPath'))
    Assert ($backup.StartsWith($profilePath+'.backup-',[StringComparison]::OrdinalIgnoreCase)) 'Unrecognized backup location'
    Assert (Test-Path -LiteralPath $backup -PathType Leaf) 'Original backup missing'
    Assert ((HashFile $backup) -ceq $oldHash) 'Backup fingerprint mismatch'
    Assert ((HashFile $profilePath) -ceq $newHash) 'Current principal differs from recorded update; no overwrite'
    $current=JsonFile $profilePath
    Assert (@(Field $current 'allowed_devices') -ccontains $deviceId) 'Principal device changed since update'
    AssertProtectedDacl $profilePath
    AssertProtectedDacl ([IO.Path]::GetDirectoryName($profilePath))
    ConfirmLocal ('RESTORE '+$deviceId+' '+$capability)
    $temp=$profilePath+'.restore-'+[guid]::NewGuid().ToString('N')
    $displaced=$profilePath+'.displaced-'+[guid]::NewGuid().ToString('N')
    Copy-Item -LiteralPath $backup -Destination $temp -ErrorAction Stop
    Assert ((HashFile $profilePath) -ceq $newHash) 'Concurrent policy change; no restore'
    [IO.File]::Replace($temp,$profilePath,$displaced,$true)
    Assert ((HashFile $profilePath) -ceq $oldHash) 'Restore not verified; stop for local recovery'
    Write-Output 'LOCAL_PRINCIPAL_RESTORED=YES'
    Write-Output 'AGENT_RESTART_REQUIRED_FOR_EFFECT=YES'
    Write-Output 'NO_AGENT_RESTART_OR_RELAY_CHANGE_PERFORMED=YES'
    exit 0
}

Assert (-not [string]::IsNullOrWhiteSpace($RequestPath)) 'RequestPath is required for Inspect and Apply'
$reqPath=CheckPath $RequestPath
$profilePath=CheckPath $PrincipalPath
Assert (Test-Path -LiteralPath $reqPath -PathType Leaf) 'Approval request missing'
Assert (Test-Path -LiteralPath $profilePath -PathType Leaf) 'Launch-bound principal profile missing'
Assert ($reqPath -ine $profilePath) 'Request cannot overwrite the principal'
$profile=JsonFile $profilePath
$request=JsonFile $reqPath
Assert ((Field $request 'schema') -ceq 'tetherplane.device_local_review_request.v1') 'Wrong request schema'
Assert ((Field $request 'requiresLocalOperator') -ceq $true) 'Local operator requirement missing'
Assert ((Field $request 'remotelyApplied') -ceq $false) 'Request incorrectly claims a remote policy change'
Assert ((Field $request 'cryptographicDeviceApproval') -ceq $false) 'Request incorrectly claims device approval'
$deviceId=[string](Field $request 'deviceId')
$intent=[string](Field $request 'intent')
$capability=[string](Field $request 'capability')
Assert ($deviceId -cmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') 'Invalid device ID'
Assert ($intent -cin @('grant','revoke')) 'Invalid action'
Assert ($capability -cmatch '^(filesystem|process|browser|desktop|batch)\.[a-z][a-z0-9_]{0,63}$') 'Unexpected capability'
$reason=[string](Field $request 'reason')
Assert ($reason.Length -ge 8 -and $reason.Length -le 200 -and $reason -cnotmatch '[\x00-\x1f\x7f]') 'Invalid reason'
$created=[DateTimeOffset]::Parse([string](Field $request 'createdAt'))
$expires=[DateTimeOffset]::Parse([string](Field $request 'expiresAt'))
$now=[DateTimeOffset]::UtcNow
Assert ($created -le $now.AddMinutes(5) -and $expires -gt $now -and
    ($expires-$created).TotalHours -le 24.1) 'Expired or invalid request time window'
Assert ((Field $profile 'authentication') -ceq 'local_process_binding') 'Unknown principal authentication'
$principalId=[string](Field $profile 'principal_id')
Assert ($principalId.Length -ge 1 -and $principalId.Length -le 256) 'Invalid principal ID'
$devices=@(Field $profile 'allowed_devices')
Assert ($devices -ccontains $deviceId) 'Device does not match local principal allowed_devices'
$capabilities=@(Field $profile 'allowed_capabilities')
Assert (@($capabilities|Where-Object {$_ -isnot [string]}).Count -eq 0) 'Malformed capability list'
Assert ($capabilities.Count -eq @($capabilities|Select-Object -Unique).Count) 'Duplicate capabilities'
$directories=@(Field $profile 'allowed_directories')
Assert (@($directories|Where-Object {$_ -isnot [string]}).Count -eq 0) 'Malformed directory list'
$directory=Field $request 'directory'
if($capability.StartsWith('filesystem.')) {
    Assert ($directory -is [string] -and $directory -cmatch '^[A-Za-z]:\\.+') 'Filesystem requests require an exact non-root folder'
    Assert ($directory -notmatch '(^|[\\/])\.\.([\\/]|$)') 'Parent traversal denied'
    $directory=CheckPath $directory
    Assert (Test-Path -LiteralPath $directory -PathType Container) 'Requested directory must exist'
    Assert (@($directories|Where-Object {ContainedIn $directory ([string]$_)}).Count -gt 0) 'Directory outside existing principal roots; separate approved local root/launcher update required'
}else{
    Assert ($null -eq $directory) 'Non-filesystem request cannot contain a directory'
}
$before=HashFile $profilePath
Write-Output ('DEVICE='+$deviceId)
Write-Output ('INTENT='+$intent)
Write-Output ('EXACT_CAPABILITY='+$capability)
Write-Output ('EXISTING_PRINCIPAL_SHA256='+$before)
Write-Output 'DEVICE_LOCAL_OPERATOR_REVIEW_REQUIRED=YES'
if($Mode -eq 'Inspect') {
    Write-Output 'DEVICE_LOCAL_INSPECTION=PASS'
    Write-Output 'NO_PERMISSION_CHANGE=YES'
    Write-Output 'PROTECTED_DACL_AND_INTERACTIVE_ELEVATION_REQUIRED_BEFORE_APPLY=YES'
    exit 0
}
Assert ($Mode -eq 'Apply') 'Unsupported mode'
Assert ($ExpectedPrincipalSha256 -cmatch '^[a-f0-9]{64}$' -and
    $before -ceq $ExpectedPrincipalSha256) 'Stale or unverified principal fingerprint'
if($intent -eq 'grant') {
    Assert ($capabilities -cnotcontains $capability) 'Already allowed; no update'
    $profile.allowed_capabilities=@($capabilities+$capability|Sort-Object -Unique)
}else{
    Assert ($capabilities -ccontains $capability) 'Already denied; no update'
    $profile.allowed_capabilities=@($capabilities|Where-Object {$_ -cne $capability})
}
$known=@('principal_id','authentication','allowed_devices','allowed_capabilities','allowed_directories')
Assert (@($profile.PSObject.Properties.Name|Where-Object {$known -cnotcontains $_}).Count -eq 0) 'Unknown principal fields: manual review'
AssertProtectedDacl $profilePath
AssertProtectedDacl ([IO.Path]::GetDirectoryName($profilePath))
ConfirmLocal ('APPROVE '+$deviceId+' '+$capability+' '+$intent)
Assert ((HashFile $profilePath) -ceq $before) 'Concurrent profile change: no write'
$guid=[guid]::NewGuid().ToString('N')
$temp=$profilePath+'.pending-'+$guid
$backup=$profilePath+'.backup-'+$guid
$receiptPath=$profilePath+'.receipt-'+$guid+'.json'
$utf8=New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($temp,(ConvertTo-Json -InputObject $profile -Depth 10)+([char]10),$utf8)
$after=HashFile $temp
$receipt=[ordered]@{
    schema='tetherplane.device_local_policy_recovery.v1';status='prepared'
    deviceId=$deviceId;intent=$intent;capability=$capability
    principalPath=$profilePath;requestSha256=(HashFile $reqPath)
    oldSha256=$before;newSha256=$after;backupPath=$backup
    createdAt=([DateTimeOffset]::UtcNow.ToString('o'))
}
WriteJsonNew $receiptPath $receipt
Assert ((HashFile $profilePath) -ceq $before) 'Concurrent change before atomic replace'
[IO.File]::Replace($temp,$profilePath,$backup,$true)
Assert ((HashFile $backup) -ceq $before) 'Backup mismatch: stop for manual recovery'
Assert ((HashFile $profilePath) -ceq $after) 'Updated profile mismatch: stop for manual recovery'
$receipt.status='committed'
$receipt.verifiedAt=[DateTimeOffset]::UtcNow.ToString('o')
$receiptStage=$receiptPath+'.pending-'+[guid]::NewGuid().ToString('N')
[IO.File]::WriteAllText($receiptStage,(ConvertTo-Json -InputObject $receipt -Depth 10)+([char]10),$utf8)
[IO.File]::Replace($receiptStage,$receiptPath,$null,$true)
Write-Output ('LOCAL_POLICY_NEW_SHA256='+$after)
Write-Output ('LOCAL_POLICY_ROLLBACK_RECEIPT='+$receiptPath)
Write-Output 'LOCAL_PRINCIPAL_FILE_UPDATED=YES'
Write-Output 'AGENT_RESTART_REQUIRED_FOR_EFFECT=YES'
Write-Output 'NO_AGENT_RESTART_OR_RELAY_CHANGE_PERFORMED=YES'
