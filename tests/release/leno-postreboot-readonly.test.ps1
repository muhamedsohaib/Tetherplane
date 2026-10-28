# Only synthetic tests on disposable same-repository Windows Actions runners.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -cne 'true' -or
    $env:GITHUB_EVENT_NAME -cne 'pull_request' -or
    $env:RUNNER_OS -cne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_HEAD_REF -notlike 'fix/leno-postreboot-diagnostic-*') {
    throw 'LENOREBOOT_CI_ONLY: refusing to run outside disposable GitHub Windows PR runner'
}
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$target = Join-Path $root 'scripts\msix-store\Assess-Leno-PostReboot-ReadOnly.ps1'
$global:TPFixture = @{}

function global:Get-CimInstance {
    param([string]$ClassName,[string]$Filter,[object]$ErrorAction)
    if ($ClassName -eq 'Win32_Process') { return $global:TPFixture.agents }
    if ($ClassName -eq 'Win32_OperatingSystem') {
        return [pscustomobject]@{LastBootUpTime=(Get-Date).AddMinutes(-10)}
    }
    throw 'unexpected synthetic CIM request'
}
function global:Get-ScheduledTask {
    param([string]$TaskName,[object]$ErrorAction)
    if ($TaskName -ne 'Tetherplane Leno Canary') { throw 'unexpected synthetic task' }
    if ($null -eq $global:TPFixture.task) { throw 'synthetic missing task' }
    return $global:TPFixture.task
}
function global:Get-ScheduledTaskInfo {
    param([string]$TaskName,[string]$TaskPath,[object]$ErrorAction)
    return [pscustomobject]@{LastTaskResult=$global:TPFixture.lastResult}
}
function global:Get-AuthenticodeSignature {
    param([string]$LiteralPath,[object]$ErrorAction)
    if ($LiteralPath -notmatch '(?i)tetherd[.]exe$') { throw 'unexpected signature request' }
    return [pscustomobject]@{Status=$global:TPFixture.signature}
}
function global:Get-ItemProperty {
    param([string]$LiteralPath,[string]$Name,[object]$ErrorAction)
    if ($Name -ne 'VerifiedAndReputablePolicyState') { throw 'unexpected policy read' }
    if ($null -eq $global:TPFixture.sac) { throw 'synthetic unavailable registry' }
    return [pscustomobject]@{VerifiedAndReputablePolicyState=$global:TPFixture.sac}
}
function global:Get-WinEvent {
    param([hashtable]$FilterHashtable,[int]$MaxEvents,[object]$ErrorAction)
    if ($MaxEvents -ne 100 -or $FilterHashtable.Id -ne 3077) {
        throw 'unexpected event query'
    }
    if ($global:TPFixture.eventsUnavailable) { throw 'no synthetic events accessible' }
    return $global:TPFixture.events
}
function New-MockedTask([string]$argsText) {
    return [pscustomobject]@{
        TaskName = 'Tetherplane Leno Canary'
        TaskPath = '\'
        State = 'Ready'
        Actions = @([pscustomobject]@{
            Execute = 'C:\synthetic\tetherd.exe'
            Arguments = $argsText
        })
    }
}
function Invoke-Case([string]$name,[string]$verdict,[string[]]$expected) {
    $raw = (& $target | Out-String).Trim()
    $result = $raw | ConvertFrom-Json -ErrorAction Stop
    if ($result.schema -ne 'tetherplane-leno-reboot-admission-v1' -or
        $result.evidence -ne 'LOCAL_READ_ONLY_NOT_REMOTE_ACCEPTANCE' -or
        $result.verdict -ne $verdict) {
        throw ('invalid decision/schema: '+$name)
    }
    foreach ($finding in $expected) {
        if (@($result.findings) -cnotcontains $finding) {
            throw ('missing finding '+$finding+' in '+$name)
        }
    }
    if ($raw -match 'NEVER_OUTPUT_THIS|not-a-real-relay|test-only-token|C:[\\]synthetic') {
        throw ('sensitive raw action argument or path leaked: '+$name)
    }
    return $result
}
try {
    $global:TPFixture = @{
        agents=@();task=$null;lastResult=0;signature='UNAVAILABLE';
        sac=$null;events=@();eventsUnavailable=$true
    }
    [void](Invoke-Case 'no-agent-no-task' 'NO_GO' @('AGENT_NOT_RUNNING','CANARY_TASK_NOT_READABLE'))

    $global:TPFixture = @{
        agents=@();task=(New-MockedTask '');lastResult=1;signature='NotSigned';
        sac=1;events=@();eventsUnavailable=$true
    }
    $blocked = Invoke-Case 'post-reboot-exact-shape' 'NO_GO' @(
        'AGENT_NOT_RUNNING','CANARY_REMOTE_ARGUMENTS_MISSING',
        'SAC_ON_NATIVE_TRUST_NOT_VERIFIED','CANARY_LAST_EXECUTION_NONZERO'
    )
    if ($blocked.code_integrity_query -ne 'NO_EVENTS_OR_ACCESS_DENIED' -or
        $blocked.post_boot_block_count -ne 'UNAVAILABLE') {
        throw 'unavailable Code Integrity query incorrectly treated as no blocks'
    }

    $argsText = '--relay-url "wss://not-a-real-relay.invalid/device" --device-id "Leno" --device-credential-file "C:\synthetic\NEVER_OUTPUT_THIS"'
    $global:TPFixture = @{
        agents=@([pscustomobject]@{ProcessId=123});task=(New-MockedTask $argsText);
        lastResult=0;signature='Valid';sac=1;events=@();eventsUnavailable=$false
    }
    $valid = Invoke-Case 'synthetic-complete-not-remote-proof' 'INCONCLUSIVE' @()
    if ($valid.device_id_class -ne 'EXACT_LENO' -or
        $valid.relay_argument -ne 'PRESENT' -or
        $valid.credential_argument -ne 'PRESENT') {
        throw 'complete synthetic task was not recognized'
    }

    $global:TPFixture = @{
        agents=@();task=(New-MockedTask '--relay-url "wss://not-a-real-relay.invalid/device" --device-id "Other" --device-credential-file "C:\synthetic\NEVER_OUTPUT_THIS"');
        lastResult=1;signature='NotSigned';sac=0;events=@();eventsUnavailable=$true
    }
    [void](Invoke-Case 'wrong-device-id' 'NO_GO' @('CANARY_DEVICE_ID_UNVERIFIED'))
    Write-Output 'LENOREBOOT_SYNTHETIC_PASS: four isolated scenarios, no real tasks or system changes'
} finally {
    foreach($name in @('Get-CimInstance','Get-ScheduledTask','Get-ScheduledTaskInfo','Get-AuthenticodeSignature','Get-ItemProperty','Get-WinEvent')) {
        Remove-Item ('Function:\global:'+$name) -Force -ErrorAction SilentlyContinue
    }
    Remove-Variable TPFixture -Scope Global -ErrorAction SilentlyContinue
}
