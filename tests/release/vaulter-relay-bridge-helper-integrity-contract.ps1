# RED/GREEN: protected bridge helper MUST be hash-verified before dot-sourcing.
# Synthetic temp files only. Never executes the relay or a scheduled task.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$scriptPath=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-bounded-supervisor.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $scriptPath).Path,[ref]$tokens,[ref]$errors)
if(@($errors).Count -ne 0){throw 'Supervisor has invalid PowerShell syntax.'}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $scriptPath).Path)
$guard='Assert-TrustedBridgeChildHelper'
$dotSource='. $helperPath'
if($source.IndexOf($guard,[StringComparison]::Ordinal) -lt 0){
  throw 'RED: bridge helper is sourced before independently validating its SHA256.'
}
$callIndex=$source.IndexOf($guard+' -StageDirectory',[StringComparison]::Ordinal)
$dotIndex=$source.IndexOf($dotSource,[StringComparison]::Ordinal)
if($callIndex -lt 0 -or $dotIndex -lt 0 -or $callIndex -ge $dotIndex){
  throw 'RED: runtime does not verify bridge helper BEFORE dot-sourcing.'
}
$function=$ast.Find({
  param($n)
  $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
  $n.Name -ceq 'Assert-TrustedBridgeChildHelper'
},$true)
if($null -eq $function){throw 'Verified helper integrity function missing.'}
Invoke-Expression $function.Extent.Text
$stage=Join-Path ([IO.Path]::GetTempPath()) ('bridge-helper-contract-'+[Guid]::NewGuid().ToString('N'))
$helper=Join-Path $stage 'vaulter-relay-supervised-bridge-child.ps1'
$manifest=Join-Path $stage 'manifest.json'
function MustReject([scriptblock]$action,[string]$label){
  $failed=$false
  try{& $action | Out-Null}catch{$failed=$true}
  if(-not $failed){throw "Untrusted helper accepted: $label"}
}
try{
  New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
  $acl=Get-Acl -LiteralPath $stage
  $acl.SetAccessRuleProtection($true,$true)
  Set-Acl -LiteralPath $stage -AclObject $acl
  [IO.File]::WriteAllText($helper,'# reviewed helper')
  $hash=(Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash
  [IO.File]::WriteAllText($manifest,('{"BridgeHelperSha256":"'+$hash+'"}'))
  Assert-TrustedBridgeChildHelper -StageDirectory $stage
  [IO.File]::AppendAllText($helper, '# changed')
  MustReject {Assert-TrustedBridgeChildHelper -StageDirectory $stage} 'tampered helper'
  [IO.File]::WriteAllText($helper,'# reviewed helper')
  [IO.File]::WriteAllText($manifest,'{"BridgeHelperSha256":"invalid"}')
  MustReject {Assert-TrustedBridgeChildHelper -StageDirectory $stage} 'invalid manifest hash'
  Remove-Item -LiteralPath $manifest -Force
  MustReject {Assert-TrustedBridgeChildHelper -StageDirectory $stage} 'missing manifest'
  Write-Output 'VAULTER BRIDGE HELPER PRE-SOURCE INTEGRITY CONTRACT PASS'
}finally{
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
