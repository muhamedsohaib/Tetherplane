# Isolated Windows PowerShell 5.1/7 offline v1 rescue contracts.
# Run only on CI fixture files. NEVER touches Vaulter protected auth state.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$scriptPath = Join-Path $root 'scripts\vaulter-tether-auth-offline-restore.ps1'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw 'Missing offline v1 restoration entry point: a stopped auth listener must not block protected-file recovery.'
}
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath,[ref]$tokens,[ref]$errors)
if (@($errors).Count -ne 0) {
    $issues = @($errors | ForEach-Object { 'line=' + $_.Extent.StartLineNumber + '; kind=' + $_.ErrorId })
    throw ('Offline v1 restoration script has PowerShell syntax errors: ' + ($issues -join ' | '))
}
$source = [IO.File]::ReadAllText($scriptPath)
foreach ($required in @(
    '[switch]$RestoreV1', '[switch]$StartV1Task',
    'Get-VerifiedRunnerVersion', 'Tetherplane-TetherAuth-Startup',
    'tether-auth-startup-runner.v1-backup.ps1',
    'AreAccessRulesProtected', 'S4U', 'RestartCount', 'RestartInterval',
    'Invoke-OfflineRestoreTransaction', 'Invoke-OfflineStartTransaction',
    'Assert-OfflineTaskShape', 'Invoke-OfflineFileSwap',
    'Get-NetTCPConnection', 'Get-FileHash', 'Get-ScheduledTask',
    'OFFLINE V1 PREFLIGHT', 'OFFLINE V1 RESTORE VERIFIED',
    'OFFLINE V1 TASK START VERIFIED', 'ROLLBACK UNVERIFIED',
    'No changes made'
)) {
    if (-not $source.Contains($required)) { throw "Missing offline recovery contract: $required" }
}
if ($source -match '(?i)\b(?:Stop-Process|Stop-ScheduledTask|Unregister-ScheduledTask|Register-ScheduledTask|Set-ScheduledTask|Set-Clipboard)\b' -or
    $source -match '(?i)\b(?:tailscale funnel|tailscale serve|gh auth token)\b' -or
    $source -match '(?im)^\s*Write-(?:Host|Output|Warning|Error).*?(?:bridgeToken|privateKey|CommandLine)') {
    throw 'Offline recovery must not stop processes, edit task registrations, modify Funnel, or print secrets.'
}
if ($source -notmatch 'if \(\$RestoreV1 -and \$StartV1Task\)') {
    throw 'File restoration and task startup must be separate, mutually exclusive actions.'
}
if ($source -notmatch 'Start-ScheduledTask -TaskName \$script:taskName -TaskPath') {
    throw 'Only the exact named, existing task may be started explicitly.'
}
if ($source -match 'Start-ScheduledTask -TaskName (?!\$script:taskName)') {
    throw 'Unexpected task startup target.'
}
# The preflight must not depend on local auth readyz/postcheck. A working
# auth endpoint cannot be a prerequisite for recovery from its outage.
$defaultBlock = $source.Substring(0,$source.IndexOf('if ($RestoreV1)'))
if ($defaultBlock -match 'Invoke-RestMethod|readyz|SUPERVISED AUTH POSTCHECK PASS') {
    throw 'Offline restore has an accidental healthy-listener prerequisite.'
}

foreach ($name in @(
    'Assert-OfflineTaskShape',
    'Test-OfflinePrincipal',
    'Invoke-OfflineRestoreTransaction',
    'Invoke-OfflineStartTransaction',
    'Invoke-OfflineFileSwap',
    'Test-OfflineAclEquivalent'
)) {
    $fn = $ast.Find({
        param($n)
        $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name
    },$true)
    if ($null -eq $fn) { throw "Missing independently testable offline recovery function: $name" }
    Invoke-Expression $fn.Extent.Text
}

$runner = 'C:\ProtectedAuth\tether-auth-startup-runner.ps1'
$task = [pscustomobject]@{
    State = 'Ready'
    Settings = [pscustomobject]@{ Enabled=$true; RestartCount=10; RestartInterval='PT1M' }
    Principal = [pscustomobject]@{ LogonType='S4U'; UserId='S-1-5-18' }
    Actions = @([pscustomobject]@{ Arguments=('-NoLogo -File "'+$runner+'" -Serve') })
    Triggers = @([pscustomobject]@{ CimClass=[pscustomobject]@{ CimClassName='MSFT_TaskBootTrigger' } })
}
Assert-OfflineTaskShape -Task $task -ProtectedRunnerPath $runner
foreach ($bad in @('Running','Disabled')) {
    $task.State = $bad
    try {
        Assert-OfflineTaskShape -Task $task -ProtectedRunnerPath $runner
        throw 'Unsafe scheduled-task state was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'Unsafe scheduled-task state was accepted.') { throw }
    }
}
$task.State = 'Ready'
$task.Actions[0].Arguments = '-File "C:\other\runner.ps1" -Serve'
try {
    Assert-OfflineTaskShape -Task $task -ProtectedRunnerPath $runner
    throw 'Unexpected task action was accepted.'
} catch {
    if ($_.Exception.Message -eq 'Unexpected task action was accepted.') { throw }
}
$task.Actions[0].Arguments = '-File "'+$runner+'" -Serve'
$task.Principal.LogonType = 'Password'
try {
    Assert-OfflineTaskShape -Task $task -ProtectedRunnerPath $runner
    throw 'Non-S4U principal was accepted.'
} catch {
    if ($_.Exception.Message -eq 'Non-S4U principal was accepted.') { throw }
}

function New-OffRecoveryFixture([string[]]$Failures) {
    $state = @{
        Events = New-Object 'System.Collections.Generic.List[string]'
        Failures = $Failures
    }
    $ops = @{}
    foreach ($label in @('VerifyBaseline','Prepare','Replace','VerifyV1','RestoreV2','VerifyV2')) {
        $step = $label
        $ops[$label] = {
            $state.Events.Add($step)
            if ($state.Failures -ccontains $step) { throw 'simulated offline file failure' }
        }.GetNewClosure()
    }
    return @{ Ops=$ops; State=$state }
}
$ok = New-OffRecoveryFixture @()
if ((Invoke-OfflineRestoreTransaction -Operations $ok.Ops) -cne 'restored' -or
    ($ok.State.Events -join ',') -cne 'VerifyBaseline,Prepare,Replace,VerifyV1') {
    throw 'Offline file restore must independently validate the new v1 bytes.'
}
foreach ($step in @('VerifyBaseline','Prepare')) {
    $fault = New-OffRecoveryFixture @($step)
    try {
        Invoke-OfflineRestoreTransaction -Operations $fault.Ops | Out-Null
        throw 'Failed offline preflight was incorrectly accepted.'
    } catch {
        if ($_.Exception.Message -eq 'Failed offline preflight was incorrectly accepted.') { throw }
    }
    if ($fault.State.Events -ccontains 'Replace' -or $fault.State.Events -ccontains 'RestoreV2') {
        throw 'Failed offline preflight may not mutate the protected runner.'
    }
}
foreach ($step in @('Replace','VerifyV1')) {
    $fault = New-OffRecoveryFixture @($step)
    try {
        Invoke-OfflineRestoreTransaction -Operations $fault.Ops | Out-Null
        throw 'Failed offline restoration was reported successful.'
    } catch {
        if ($_.Exception.Message -eq 'Failed offline restoration was reported successful.') { throw }
        if ($_.Exception.Message -notmatch 'ROLLED BACK') { throw }
    }
    if (($fault.State.Events -join ',') -notmatch 'RestoreV2,VerifyV2$') {
        throw 'Potentially changed v2 bytes must be restored and verified after a failed swap.'
    }
}
$badRollback = New-OffRecoveryFixture @('VerifyV1','VerifyV2')
try {
    Invoke-OfflineRestoreTransaction -Operations $badRollback.Ops | Out-Null
    throw 'Unverified offline rollback was reported successful.'
} catch {
    if ($_.Exception.Message -eq 'Unverified offline rollback was reported successful.') { throw }
    if ($_.Exception.Message -notmatch 'ROLLBACK UNVERIFIED') { throw }
}

$startEvents = New-Object 'System.Collections.Generic.List[string]'
$startOps = @{
    VerifyReady = { $startEvents.Add('ready') }.GetNewClosure()
    StartNamedTask = { $startEvents.Add('start') }.GetNewClosure()
    VerifyHealthy = { $startEvents.Add('healthy') }.GetNewClosure()
}
if ((Invoke-OfflineStartTransaction -Operations $startOps) -cne 'healthy' -or
    ($startEvents -join ',') -cne 'ready,start,healthy') {
    throw 'Explicit task recovery must verify readiness before and health after start.'
}

# Real atomic fixture: installed v2 -> protected v1, preserving source backup,
# both owners and effective DACLs. No live task or authentication is involved.
$dir = Join-Path ([IO.Path]::GetTempPath()) ('tp-offline-rescue-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null
    $installed = Join-Path $dir 'installed.ps1'
    $backup = Join-Path $dir 'v1-backup.ps1'
    $staged = Join-Path $dir 'v1-staged.tmp'
    $evidence = Join-Path $dir 'replaced-v2.tmp'
    [IO.File]::WriteAllText($installed, 'verified-v2-bytes')
    [IO.File]::WriteAllText($backup, 'verified-v1-bytes')
    [IO.File]::WriteAllText($staged, 'verified-v1-bytes')
    $acl = Get-Acl -LiteralPath $installed
    Invoke-OfflineFileSwap -StagedPath $staged -TargetPath $installed -EvidencePath $evidence
    if ([IO.File]::ReadAllText($installed) -cne 'verified-v1-bytes' -or
        [IO.File]::ReadAllText($backup) -cne 'verified-v1-bytes' -or
        [IO.File]::ReadAllText($evidence) -cne 'verified-v2-bytes') {
        throw 'Real offline recovery must retain protected backup and pre-restore v2 evidence.'
    }
    if (-not (Test-OfflineAclEquivalent -Expected $acl -Actual (Get-Acl -LiteralPath $installed)) -or
        -not (Test-OfflineAclEquivalent -Expected $acl -Actual (Get-Acl -LiteralPath $evidence))) {
        throw 'Real offline recovery must preserve original ownership and effective ACLs.'
    }
    $other = Join-Path ([IO.Path]::GetTempPath()) ('tp-offline-foreign-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($other,'untrusted')
    try {
        Invoke-OfflineFileSwap -StagedPath $other -TargetPath $installed -EvidencePath (Join-Path $dir 'second.tmp')
        throw 'Cross-directory offline file replacement was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'Cross-directory offline file replacement was accepted.') { throw }
    } finally {
        Remove-Item -LiteralPath $other -Force -ErrorAction SilentlyContinue
    }
} finally {
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
}

# The real Vaulter guard must reject an untrusted task principal even if the
# task state and action look plausible.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (Test-OfflinePrincipal -Identity $identity -TaskUserId $identity.User.Value) -or
    -not (Test-OfflinePrincipal -Identity $identity -TaskUserId $identity.Name)) {
    throw 'Offline rescue must accept only exact account-name/SID equivalence.'
}
$other = if ($identity.User.Value -ceq 'S-1-5-18') { 'S-1-5-19' } else { 'S-1-5-18' }
if (Test-OfflinePrincipal -Identity $identity -TaskUserId $other) {
    throw 'Offline recovery must reject another task principal.'
}
if (Test-OfflinePrincipal -Identity $identity -TaskUserId 'definitely-not-an-account') {
    throw 'Unknown S4U principals may not authorize offline recovery.'
}
$task.Principal.LogonType = 'S4U'
$task.Settings.RestartCount = 999
try {
    Assert-OfflineTaskShape -Task $task -ProtectedRunnerPath $runner
    throw 'Changed task retry count was accepted.'
} catch {
    if ($_.Exception.Message -eq 'Changed task retry count was accepted.') { throw }
} finally { $task.Settings.RestartCount = 10 }
$task.Triggers = @([pscustomobject]@{ CimClass=[pscustomobject]@{ CimClassName='MSFT_TaskLogonTrigger' } })
try {
    Assert-OfflineTaskShape -Task $task -ProtectedRunnerPath $runner
    throw 'Removed boot trigger was accepted.'
} catch {
    if ($_.Exception.Message -eq 'Removed boot trigger was accepted.') { throw }
}

# Starting the existing task must be strictly opt-in. A fault at any stage
# prevents declaring recovery success and must not start on failed preflight.
foreach ($failPhase in @('VerifyReady','StartNamedTask','VerifyHealthy')) {
    $trace = New-Object 'System.Collections.Generic.List[string]'
    $ops = @{
        VerifyReady = {
            $trace.Add('preflight')
            if ($failPhase -eq 'VerifyReady') { throw 'simulated bad offline task' }
        }.GetNewClosure()
        StartNamedTask = {
            $trace.Add('start')
            if ($failPhase -eq 'StartNamedTask') { throw 'simulated failed named start' }
        }.GetNewClosure()
        VerifyHealthy = {
            $trace.Add('health')
            if ($failPhase -eq 'VerifyHealthy') { throw 'simulated failed readiness' }
        }.GetNewClosure()
    }
    try {
        Invoke-OfflineStartTransaction -Operations $ops | Out-Null
        throw 'A failed named task start was incorrectly reported healthy.'
    } catch {
        if ($_.Exception.Message -eq 'A failed named task start was incorrectly reported healthy.') { throw }
    }
    if ($failPhase -ceq 'VerifyReady' -and ($trace -join ',') -cne 'preflight') {
        throw 'Preflight errors may never trigger task startup.'
    }
}
$restoreStart = $source.IndexOf('if ($RestoreV1) {')
$restoreEnd = $source.IndexOf('# Separate explicit recovery operation')
if ($restoreStart -lt 0 -or $restoreEnd -le $restoreStart -or
    $source.Substring($restoreStart,$restoreEnd-$restoreStart) -match 'Start-ScheduledTask') {
    throw 'Offline v1 file restoration must never start a task implicitly.'
}

Write-Output 'Offline v1 rescue task-state, atomic file, and rollback contracts passed.'
