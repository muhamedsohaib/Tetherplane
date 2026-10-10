# Synthetic controlled fault recovery contract for the NEW task-owned supervisor.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$path=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-supervised-rehearsal.ps1'
if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw 'RED: supervised crash acceptance test is missing.'}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $path).Path,[ref]$tokens,[ref]$errors)
if(@($errors).Count -gt 0){throw 'Supervised recovery acceptance syntax invalid.'}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path)
foreach($required in @(
  '[switch]$Exercise','if(-not $Exercise)',
  'COMPUTERNAME','Vaulter','Tetherplane Relay',
  'Get-ScheduledTask','Export-ScheduledTask',
  'Get-NetTCPConnection','Get-CimInstance','CreationDate',
  'ParentProcessId','AreAccessRulesProtected','Get-FileHash',
  'Stop-Process','-Id','Wait-Recovered',
  'Invoke-VerifiedSupervisedRecovery','VerifyBefore','VerifyTarget',
  'InjectCrash','WaitAutomatic','Rollback','VerifyOriginal',
  'AUTOMATIC RECOVERY VERIFIED','RECOVERY UNVERIFIED','NO CHANGES MADE',
  'vaulter-relay-supervisor-handover.ps1','vaulter-tether-auth-supervised-postcheck.ps1'
)){
  if(-not $source.Contains($required)){throw "Supervised rehearsal missing requirement: $required"}
}
if($source -match '(?i)\b(?:Register-ScheduledTask|Set-ScheduledTask|Stop-Process\s+-Name|Set-Clipboard)\b|gh auth token|tailscale\s+(?:serve|funnel)\s+(?:off|reset|--set-path)'){
  throw 'Supervised rehearsal cannot mutate task definitions, routes, or unrelated processes.'
}
$f=$ast.Find({
  param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
  $node.Name -eq 'Invoke-VerifiedSupervisedRecovery'
},$true)
if($null -eq $f){throw 'Recovery transaction function missing.'}
Invoke-Expression $f.Extent.Text
function Fixture([string[]]$Fails){
  $steps=New-Object 'System.Collections.Generic.List[string]'
  $ops=@{}
  foreach($name in @('VerifyBefore','VerifyTarget','InjectCrash','WaitAutomatic','Rollback','VerifyOriginal')){
    $n=$name
    $ops[$n]={
      $steps.Add($n)
      if($Fails -ccontains $n){throw 'synthetic failure'}
    }.GetNewClosure()
  }
  return @{Steps=$steps;Ops=$ops}
}
$a=Fixture @()
$result=Invoke-VerifiedSupervisedRecovery -Operations $a.Ops
if($result -cne 'automatic' -or ($a.Steps -join ',') -cne 'VerifyBefore,VerifyTarget,InjectCrash,WaitAutomatic'){
  throw 'Automatic restart must prove recovery without invoking any rollback.'
}
foreach($step in @('VerifyBefore','VerifyTarget')){
  $f=Fixture @($step)
  $caught=$false
  try{Invoke-VerifiedSupervisedRecovery -Operations $f.Ops | Out-Null}catch{$caught=$true}
  if(-not $caught -or $f.Steps.Contains('InjectCrash')){throw 'Unverified preconditions must not inject any crash.'}
}
$b=Fixture @('WaitAutomatic')
$err=''
try{Invoke-VerifiedSupervisedRecovery -Operations $b.Ops|Out-Null}catch{$err=$_.Exception.Message}
if($err -notmatch 'RECOVERY UNVERIFIED' -or
  ($b.Steps -join ',') -cne 'VerifyBefore,VerifyTarget,InjectCrash,WaitAutomatic,Rollback,VerifyOriginal'){
  throw 'Failed automatic recovery must attempt original recovery without claiming success.'
}
$c=Fixture @('WaitAutomatic','Rollback')
$err=''
try{Invoke-VerifiedSupervisedRecovery -Operations $c.Ops|Out-Null}catch{$err=$_.Exception.Message}
if($err -notmatch 'ROLLBACK UNVERIFIED'){throw 'Unverified rollback requires explicit stop report.'}
Write-Output 'VAULTER SUPERVISED RECOVERY ACCEPTANCE CONTRACT PASS'
