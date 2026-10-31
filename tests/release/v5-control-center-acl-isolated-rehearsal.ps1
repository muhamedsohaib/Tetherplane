#requires -Version 5.1
<#
SYNTHETIC-ONLY Windows ACL rehearsal. Creates/discards temporary files under
the caller's TEMP. Never accepts a production path or alters any service.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$base=Join-Path $env:TEMP ('Tetherplane-V5-ACL-SIMULATION-'+[guid]::NewGuid().ToString('N'))
$release=Join-Path $base 'ControlCenterReleases'
$v5=Join-Path $release 'accepted-v5'
$public=Join-Path $v5 'public'
$entry=Join-Path $v5 'oauth.mjs'
$html=Join-Path $public 'index.html'
$users=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
$writeMask=[long]852310
function Rules([string]$p){
 @( (Get-Acl -LiteralPath $p).Access | Where-Object {
  $sid=try{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{''}
  $sid -eq 'S-1-5-32-545' -and $_.AccessControlType -eq 'Allow'
 })
}
function Check([string]$p,[bool]$expectedWrite,[string]$stage){
 $rules=@(Rules $p)
 $hasWrite=@($rules|Where-Object{([long]$_.FileSystemRights -band $writeMask) -ne 0}).Count -gt 0
 $hasRead=@($rules|Where-Object{([long]$_.FileSystemRights -band [long][Security.AccessControl.FileSystemRights]::ReadData) -ne 0}).Count -gt 0
 if($hasWrite -ne $expectedWrite -or !$hasRead){throw ('ACL_CHECK_FAILED '+$stage+' '+(Split-Path $p -Leaf))}
}
function AddUsers([string]$p,[Security.AccessControl.FileSystemRights]$rights,[Security.AccessControl.InheritanceFlags]$flags){
 $acl=Get-Acl -LiteralPath $p
 $rule=New-Object Security.AccessControl.FileSystemAccessRule($users,$rights,$flags,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
 $acl.AddAccessRule($rule)
 Set-Acl -LiteralPath $p -AclObject $acl
}
try{
 New-Item -ItemType Directory -Path $public -Force|Out-Null
 [IO.File]::WriteAllText($entry,'synthetic entry')
 [IO.File]::WriteAllText($html,'synthetic HTML')
 $hash1=(Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash
 $hash2=(Get-FileHash -LiteralPath $html -Algorithm SHA256).Hash
 AddUsers $base ([Security.AccessControl.FileSystemRights]::ReadAndExecute) ([Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit')
 AddUsers $base ([Security.AccessControl.FileSystemRights]::Write) ([Security.AccessControl.InheritanceFlags]::ContainerInherit)
 foreach($p in @($base,$release,$v5,$public)){Check $p $true 'BEFORE'}
 foreach($p in @($entry,$html)){Check $p $false 'BEFORE_FILE'}
 Write-Output 'BASELINE=PASS'
 $before=Get-Acl -LiteralPath $release
 $acl=Get-Acl -LiteralPath $release
 $acl.SetAccessRuleProtection($true,$true)
 Set-Acl -LiteralPath $release -AclObject $acl
 $acl=Get-Acl -LiteralPath $release
 if(!$acl.AreAccessRulesProtected){throw 'INHERITANCE_PROTECTION_MISSING'}
 $bad=@(Rules $release|Where-Object{([long]$_.FileSystemRights -band $writeMask) -ne 0})
 if($bad.Count -ne 1){throw 'UNEXPECTED_WRITE_ACE_COUNT'}
 foreach($rule in $bad){$acl.RemoveAccessRuleSpecific($rule)}
 Set-Acl -LiteralPath $release -AclObject $acl
 foreach($p in @($release,$v5,$public,$entry,$html)){Check $p $false 'AFTER'}
 Check $base $true 'UNRELATED_PARENT'
 if((Get-FileHash $entry -Algorithm SHA256).Hash -ne $hash1 -or (Get-FileHash $html -Algorithm SHA256).Hash -ne $hash2){throw 'FILE_HASH_CHANGED'}
 Write-Output 'SCOPED_HARDENING=PASS'
 Write-Output 'UNCHANGED_FILE_HASHES=PASS'
 Write-Output 'UNRELATED_PARENT_ACL_PRESERVED=PASS'
 $new=Join-Path $public 'new-subdir'
 New-Item -ItemType Directory -Path $new|Out-Null
 Check $new $false 'NEW_CHILD'
 Write-Output 'FUTURE_INHERITANCE=PASS'
 Set-Acl -LiteralPath $release -AclObject $before
 foreach($p in @($release,$v5,$public)){Check $p $true 'ROLLBACK'}
 if((Get-Acl $release).AreAccessRulesProtected){throw 'INHERITANCE_RESTORE_FAILED'}
 Write-Output 'RESTORE_ORIGINAL_ACL=PASS'
 Write-Output 'SYNTHETIC_REHEARSAL=PASS'
}finally{
 if(Test-Path -LiteralPath $base){Remove-Item -LiteralPath $base -Recurse -Force}
 Write-Output 'SYNTHETIC_TEST_DIRECTORY_REMOVED'
}
