# Synthetic ACL allowlist contract; no private state is read or modified.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$scriptPath=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-supervised-bridge-handover.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $scriptPath).Path,[ref]$tokens,[ref]$errors)
if(@($errors).Count -ne 0){throw 'Bridge handover source does not parse.'}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $scriptPath).Path)
if(-not $source.Contains('Test-ApprovedBridgeAcl') -or
   -not $source.Contains('Test-ApprovedBridgeAcl -Acl $acl')){
  throw 'RED: protected directory check does not validate owner and allowed DACL principals.'
}
$fn=$ast.Find({
  param($n)
  $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $n.Name -ceq 'Test-ApprovedBridgeAcl'
},$true)
if($null -eq $fn){throw 'RED: private ACL allowlist helper missing.'}
Invoke-Expression $fn.Extent.Text
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')
$acl.AddAccessRule($rule)
if(-not(Test-ApprovedBridgeAcl -Acl $acl -CurrentSid $sid)){
  throw 'Protected current-user-only ACL rejected.'
}
$anyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$badRule=New-Object Security.AccessControl.FileSystemAccessRule($anyone,'ReadAndExecute','Allow')
$acl.AddAccessRule($badRule)
if(Test-ApprovedBridgeAcl -Acl $acl -CurrentSid $sid){
  throw 'Broad Everyone allow ACE accepted for private bridge staging.'
}
$acl.RemoveAccessRuleSpecific($badRule)
$acl.SetOwner($anyone)
if(Test-ApprovedBridgeAcl -Acl $acl -CurrentSid $sid){
  throw 'Untrusted private stage owner accepted.'
}
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($false,$true)
if(Test-ApprovedBridgeAcl -Acl $acl -CurrentSid $sid){
  throw 'Inherited private stage ACL accepted.'
}
Write-Output 'VAULTER SUPERVISED BRIDGE PRIVATE ACL CONTRACT PASS'
