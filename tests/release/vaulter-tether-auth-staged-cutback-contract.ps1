$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$path = Join-Path $PSScriptRoot '..\..\scripts\vaulter-tether-auth-staged-cutback.ps1'
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'RED: staged cutback script missing.' }
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $path).Path,[ref]$tokens,[ref]$errors)
if (@($errors).Count) { throw ('Staged cutback parse errors: ' + ((@($errors) | ForEach-Object { 'line ' + $_.Extent.StartLineNumber + ': ' + $_.Message }) -join '; ')) }
$source = [IO.File]::ReadAllText((Resolve-Path $path).Path)
foreach ($required in @('ApplyCutback','Get-NetTCPConnection','CreationDate','ParentProcessId',
  'Get-ScheduledTask','Disabled','Tetherplane-TetherAuth-Startup','Stop-Process',
  'vaulter-tether-auth-offline-restore.ps1','-RestoreV1','-EnableV1Task','-StartV1Task',
  'Invoke-StagedCutbackTransaction','ROLLBACK UNVERIFIED','No changes made',
  'tether-auth-owned-staged-fallback.json','Get-PublicKeyFingerprint',
  'https://tetherplane-dev.eu.auth0.com/','baselineKeys')) {
  if (-not $source.Contains($required)) { throw "Missing cutback safeguard: $required" }
}
foreach ($forbidden in @('Stop-Process -Name','Unregister-ScheduledTask','Register-ScheduledTask','gh auth token')) {
  if ($source.Contains($forbidden)) { throw "Forbidden cutback operation: $forbidden" }
}
$recoveryPath=Join-Path $PSScriptRoot '..\..\scripts\vaulter-tether-auth-recovery-rehearsal.ps1'
$recovery=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $recoveryPath).Path)
foreach($required in @('tether-auth-owned-staged-fallback.json',
 'tether-auth-owned-stage/v1','startedStagePid','CreationDate','ConvertTo-Json',
 'Set-Acl','File]::Replace')) {
 if (-not $recovery.Contains($required)) {throw "Recovery lacks protected owned-stage evidence: $required"}
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
# Rollback guards are transaction gates, not best-effort cleanup.
# An unknown listener or stale task identity must abort BEFORE any staged relaunch.
$blocked=New-Fixture @('VerifyVacant','PrepareStagedRollback')
try {
 Invoke-StagedCutbackTransaction -Operations $blocked.Operations | Out-Null
 throw 'Unverified rollback unexpectedly succeeded.'
} catch {
 if ($_.Exception.Message -eq 'Unverified rollback unexpectedly succeeded.' -or
     $_.Exception.Message -notmatch 'ROLLBACK UNVERIFIED') { throw }
}
if ($blocked.Events -ccontains 'RestoreStage' -or $blocked.Events -ccontains 'VerifyStage') {
 throw 'RED: failed rollback preflight still attempted to restart auth on an unverified port.'
}
$restoreFailed=New-Fixture @('VerifyS4U','RestoreStage')
try {
 Invoke-StagedCutbackTransaction -Operations $restoreFailed.Operations | Out-Null
 throw 'Stage relaunch failure unexpectedly succeeded.'
} catch {
 if ($_.Exception.Message -eq 'Stage relaunch failure unexpectedly succeeded.' -or
     $_.Exception.Message -notmatch 'ROLLBACK UNVERIFIED') { throw }
}
if ($restoreFailed.Events -ccontains 'VerifyStage') {
 throw 'RED: stage verification ran even after rollback launch failed.'
}

Write-Output 'Staged cutback transaction contract passed.'
