$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$path = Join-Path $PSScriptRoot '..\..\scripts\vaulter-tether-auth-staged-cutback.ps1'
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'RED: staged cutback script missing.' }
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $path).Path,[ref]$tokens,[ref]$errors)
if (@($errors).Count) { throw 'Staged cutback must parse under Windows PowerShell.' }
$source = [IO.File]::ReadAllText((Resolve-Path $path).Path)
foreach ($required in @('ApplyCutback','Get-NetTCPConnection','CreationDate','ParentProcessId',
  'Get-ScheduledTask','Disabled','Tetherplane-TetherAuth-Startup','Stop-Process',
  'vaulter-tether-auth-offline-restore.ps1','-RestoreV1','-EnableV1Task','-StartV1Task',
  'Invoke-StagedCutbackTransaction','ROLLBACK UNVERIFIED','No changes made')) {
  if (-not $source.Contains($required)) { throw "Missing cutback safeguard: $required" }
}
foreach ($forbidden in @('Stop-Process -Name','Unregister-ScheduledTask','Register-ScheduledTask','gh auth token')) {
  if ($source.Contains($forbidden)) { throw "Forbidden cutback operation: $forbidden" }
}
$f = $ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
  $n.Name -eq 'Invoke-StagedCutbackTransaction'},$true)
if ($null -eq $f) { throw 'Cutback transaction missing.' }
Invoke-Expression $f.Extent.Text
function New-Fixture([string[]]$fail) {
 $events = New-Object 'Collections.Generic.List[string]'
 $ops = @{}
 foreach($step in @('VerifyBaseline','VerifyOwnedTarget','QuiesceOwnedStage','VerifyVacant',
   'RestoreV1','EnableTask','StartTask','VerifyS4U',
   'PrepareStagedRollback','RestoreStage','VerifyStage')) {
   $n=$step
   $ops[$step]={ $events.Add($n); if($fail -ccontains $n) {throw "simulated $n failure"} }.GetNewClosure()
 }
 return @{Events=$events;Operations=$ops}
}
$ok=New-Fixture @()
if ((Invoke-StagedCutbackTransaction -Operations $ok.Operations) -cne 's4u_restored') {throw 'Verified S4U cutback not returned.'}
if (($ok.Events -join ',') -cne 'VerifyBaseline,VerifyOwnedTarget,QuiesceOwnedStage,VerifyVacant,RestoreV1,EnableTask,StartTask,VerifyS4U') {throw 'Cutback order changed.'}
foreach($failure in @('VerifyBaseline','VerifyOwnedTarget')) {
 $f=New-Fixture @($failure)
 try { Invoke-StagedCutbackTransaction -Operations $f.Operations | Out-Null; throw 'Expected failed guard' }
 catch {if($_.Exception.Message -eq 'Expected failed guard'){throw}}
 if ($f.Events -ccontains 'QuiesceOwnedStage') { throw 'Preflight failure caused mutation.' }
}
$f=New-Fixture @('VerifyS4U')
try {Invoke-StagedCutbackTransaction -Operations $f.Operations | Out-Null;throw 'Expected failure'}
catch { if($_.Exception.Message -eq 'Expected failure' -or $_.Exception.Message -notmatch 'staged auth restored') {throw} }
if (($f.Events -join ',') -notmatch 'PrepareStagedRollback,RestoreStage,VerifyStage$') {throw 'No verified staged rollback.'}
$f=New-Fixture @('VerifyS4U','VerifyStage')
try {Invoke-StagedCutbackTransaction -Operations $f.Operations | Out-Null;throw 'Expected failure'}
catch { if($_.Exception.Message -eq 'Expected failure' -or $_.Exception.Message -notmatch 'ROLLBACK UNVERIFIED') {throw} }
Write-Output 'Staged cutback transaction contract passed.'
