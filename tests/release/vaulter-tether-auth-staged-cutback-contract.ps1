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

# Pure command-line identity must reject decoys that satisfy substring checks.
$identityAst=$ast.Find({
 param($n)
 $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
 $n.Name -eq 'Test-OwnedStageCommandLine'
},$true)
if ($null -eq $identityAst) {throw 'RED: strict staged Node command identity predicate missing.'}
Invoke-Expression $identityAst.Extent.Text
$config='C:\Auth State\tether-auth-config.json'
$good='"C:\Program Files\nodejs\node.exe" auth/dist/cli.js --config "' + $config +
 '" --host 127.0.0.1 --port 8790 --allow-insecure-localhost'
if (-not (Test-OwnedStageCommandLine -CommandLine $good -ExpectedConfig $config)) {
 throw 'Valid staged Node command was rejected.'
}
$invalid=@(
 $good.Replace($config,$config + '.backup'),
 $good.Replace('--host 127.0.0.1','--host 127.0.0.1.evil'),
 $good.Replace('--port 8790','--port 87900'),
 $good.Replace('--allow-insecure-localhost','--allow-insecure-localhost-extra'),
 ($good + ' --port 8790'),
 ($good + ' --config "' + $config + '"'),
 $good.Replace('auth/dist/cli.js','auth/dist/cli.js.evil')
)
foreach($cmd in $invalid) {
 if (Test-OwnedStageCommandLine -CommandLine $cmd -ExpectedConfig $config) {
  throw 'RED: spoofed staged Node command accepted; would permit wrong-process termination.'
 }
}
$listenerFunction=$ast.Find({
 param($n)
 $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
 $n.Name -eq 'Get-ProvenStagedListener'
},$true)
if ($null -eq $listenerFunction -or
    -not $listenerFunction.Extent.Text.Contains('Test-OwnedStageCommandLine')) {
 throw 'RED: proven listener does not enforce strict command identity.'
}

# Already-restored v1 bytes must be accepted: activation fallback may have
# restored the protected file before its S4U task failed to start.
$decisionAst=$ast.Find({
 param($n)
 $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
 $n.Name -eq 'Get-CutbackV1RestoreDecision'
},$true)
if ($null -eq $decisionAst) {throw 'RED: idempotent v1 restore decision missing.'}
Invoke-Expression $decisionAst.Extent.Text
if ((Get-CutbackV1RestoreDecision -InstalledVersion 'v1') -cne 'already_v1' -or
    (Get-CutbackV1RestoreDecision -InstalledVersion 'v2') -cne 'restore_v1') {
 throw 'An exact installed v1/v2 runner must have a safe cutback decision.'
}
try {
 Get-CutbackV1RestoreDecision -InstalledVersion 'untrusted' | Out-Null
 throw 'Untrusted runner was accepted.'
} catch {if ($_.Exception.Message -eq 'Untrusted runner was accepted.'){throw}}
$restoreBlockStart=$source.IndexOf('    RestoreV1 = {',[StringComparison]::Ordinal)
$restoreBlockEnd=$source.IndexOf('    EnableTask = {',$restoreBlockStart,[StringComparison]::Ordinal)
if ($restoreBlockStart -lt 0 -or $restoreBlockEnd -le $restoreBlockStart -or
    -not $source.Substring($restoreBlockStart,$restoreBlockEnd-$restoreBlockStart).Contains('Get-CutbackV1RestoreDecision')) {
 throw 'Cutback fails to use version-aware v1 restore.'
}

# Original signing keys must also be compared AFTER S4U task recovery.
if ($source -notmatch '(?s)VerifyS4U\s*=\s*\{[^}]*Assert-StagedHealth') {
 throw 'RED: S4U recovery can silently change signing keys or Auth0 metadata.'
}
# A task reconfiguration between initial preflight and staged Node termination
# must not strand the authorization listener.
$quiesceStart=$source.IndexOf('    QuiesceOwnedStage = {',[StringComparison]::Ordinal)
$quiesceEnd=$source.IndexOf('    VerifyVacant = {',$quiesceStart,[StringComparison]::Ordinal)
if ($quiesceStart -lt 0 -or $quiesceEnd -le $quiesceStart) {throw 'Missing cutback quiesce block.'}
$quiesce=$source.Substring($quiesceStart,$quiesceEnd-$quiesceStart)
if (-not $quiesce.Contains('Get-TaskSnapshot') -or
    $quiesce.IndexOf('Get-TaskSnapshot') -ge $quiesce.IndexOf('Stop-Process')) {
 throw 'RED: task definition is not reverified before terminating staged auth.'
}

# Trust the protected ownership record only if its effective ACL policy
# matches the protected runner, not merely if inheritance is disabled.
$aclAst=$ast.Find({
 param($n)
 $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
 $n.Name -eq 'Test-CutbackProofAclEquivalent'
},$true)
if ($null -eq $aclAst) {throw 'RED: strict protected proof ACL comparison missing.'}
Invoke-Expression $aclAst.Extent.Text
$rule=[pscustomobject]@{
 IdentityReference=[pscustomobject]@{Value='S-1-5-21-1234'};
 FileSystemRights='FullControl';AccessControlType='Allow';
 InheritanceFlags='None';PropagationFlags='None'
}
$expectedAcl=[pscustomobject]@{
 Owner='S-1-5-21-1234';Group='S-1-5-21-1234';
 AreAccessRulesProtected=$true; Access=@($rule)
}
$trustedAcl=[pscustomobject]@{
 Owner='S-1-5-21-1234';Group='S-1-5-21-1234';
 AreAccessRulesProtected=$true; Access=@($rule)
}
$wrongOwner=[pscustomobject]@{
 Owner='S-1-5-21-9999';Group='S-1-5-21-1234';
 AreAccessRulesProtected=$true; Access=@($rule)
}
$wrongRule=[pscustomobject]@{
 Owner='S-1-5-21-1234';Group='S-1-5-21-1234';
 AreAccessRulesProtected=$true; Access=@()
}
if (-not (Test-CutbackProofAclEquivalent -Expected $expectedAcl -Actual $trustedAcl) -or
    (Test-CutbackProofAclEquivalent -Expected $expectedAcl -Actual $wrongOwner) -or
    (Test-CutbackProofAclEquivalent -Expected $expectedAcl -Actual $wrongRule)) {
 throw 'Proof ACL equivalence accepted an unauthorized owner or access policy.'
}
if (-not $listenerFunction.Extent.Text.Contains('Test-CutbackProofAclEquivalent')) {
 throw 'RED: staged listener trusts proof without comparing protected ACLs.'
}
# Recovered staged success must independently recheck the disabled named
# task and the exact observed Node command, not only a PID and ready response.
$stageBlockStart=$source.IndexOf('    VerifyStage = {',[StringComparison]::Ordinal)
if ($stageBlockStart -lt 0) {throw 'Missing staged rollback verification.'}
$stageBlock=$source.Substring($stageBlockStart)
if (-not $stageBlock.Contains('Get-TaskSnapshot') -or
    -not $stageBlock.Contains('Test-OwnedStageCommandLine')) {
 throw 'RED: staged rollback may report success without task/CLI re-verification.'
}

Write-Output 'Staged cutback transaction contract passed.'
