# Exercise a settings-only S4U task repair without contacting a scheduler.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$path = Join-Path $PSScriptRoot '..\..\scripts\vaulter-tether-auth-restart-settings-repair.ps1'
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw 'Missing guarded task restart settings repair script.'
}
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $path).Path, [ref]$tokens, [ref]$errors
)
if (@($errors).Count -gt 0) { throw 'Restart policy repair must parse.' }
$source = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path)
foreach ($required in @(
    '[switch]$Apply', 'if (-not $Apply)',
    'COMPUTERNAME', 'vaulter', 'Tetherplane-TetherAuth-Startup',
    'vaulter-tether-auth-supervised-postcheck.ps1',
    'AreAccessRulesProtected', 'Get-ScheduledTask', 'Export-ScheduledTask',
    'Set-ScheduledTask', 'TaskPath', 'RestartCount', 'RestartInterval',
    '10', '255', 'PT1M', 'NewGuid', 'WriteAllText',
    'Invoke-GuardedSettingsCorrection', 'Test-RestartCountRange',
    'Test-OnlyRestartCountChanged', 'Get-NetTCPConnection',
    'No changes made', 'ROLLED BACK', 'ROLLBACK UNVERIFIED',
    'No task actions, principals or triggers changed'
)) {
    if (-not $source.Contains($required)) { throw "Missing safety requirement: $required" }
}
if ($source -match '(?i)Stop-Process|Start-Process|Start-ScheduledTask|Stop-ScheduledTask|Restart-Service|funnel\s+(?:reset|off)|gh auth token') {
    throw 'Restart repair must not start/stop processes, task instances or Funnel.'
}
$commands = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst]
}, $true) | ForEach-Object { $_.GetCommandName() })
foreach ($bad in @('Register-ScheduledTask','Unregister-ScheduledTask','New-ScheduledTaskPrincipal',
    'New-ScheduledTaskAction','Disable-ScheduledTask','Enable-ScheduledTask','Set-Acl',
    'Invoke-Expression','Write-Host')) {
    if ($commands -contains $bad) { throw "Unexpected unsafe command $bad" }
}
if ($source -match '(?im)Write-(?:Output|Host|Warning).*?(?:Arguments|Principal|CommandLine|BridgeToken|JWKS|OuterXml)') {
    throw 'Do not print task action arguments, identity, exported XML or private materials.'
}
foreach ($name in @('Test-RestartCountRange','Test-OnlyRestartCountChanged',
    'Invoke-GuardedSettingsCorrection')) {
    $found = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $name
    }.GetNewClosure(), $true)
    if ($null -eq $found) { throw "Missing testable helper $name" }
    Invoke-Expression $found.Extent.Text
}
foreach ($item in @(
    @(1,$true),@(10,$true),@(255,$true),
    @(0,$false),@(-1,$false),@(256,$false),@(999,$false)
)) {
    if ((Test-RestartCountRange -Count $item[0]) -ne $item[1]) {
        throw "Restart schema bounds were incorrectly handled for count $($item[0])."
    }
}
$before = '<Task><RegistrationInfo><URI>\Tetherplane-TetherAuth-Startup</URI></RegistrationInfo><Principals><Principal><UserId>PRIVATE</UserId></Principal></Principals><Settings><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings><Actions><Exec><Command>PRIVATE</Command></Exec></Actions></Task>'
$after = $before.Replace('<Count>999</Count>', '<Count>10</Count>')
if (-not (Test-OnlyRestartCountChanged -BeforeXml $before -AfterXml $after -OldCount 999 -NewCount 10)) {
    throw 'Expected single restart-count correction was rejected.'
}
$wrongAction = $after.Replace('<Command>PRIVATE</Command>', '<Command>CHANGED</Command>')
if (Test-OnlyRestartCountChanged -BeforeXml $before -AfterXml $wrongAction -OldCount 999 -NewCount 10) {
    throw 'Task action changes must be rejected.'
}
$wrongInterval = $after.Replace('<Interval>PT1M</Interval>', '<Interval>PT2M</Interval>')
if (Test-OnlyRestartCountChanged -BeforeXml $before -AfterXml $wrongInterval -OldCount 999 -NewCount 10) {
    throw 'Restart interval changes must be rejected.'
}
$wrongPrincipal = $after.Replace('<UserId>PRIVATE</UserId>', '<UserId>OTHER</UserId>')
if (Test-OnlyRestartCountChanged -BeforeXml $before -AfterXml $wrongPrincipal -OldCount 999 -NewCount 10) {
    throw 'Task owner changes must be rejected.'
}

function New-Fixture([string[]]$fail) {
    $events = New-Object 'System.Collections.Generic.List[string]'
    $ops = @{}
    foreach ($step in @('VerifyBefore','BackupTask','ApplyCount',
                        'VerifyAfter','RestorePrior','VerifyRestored')) {
        $name = $step
        $ops[$step] = {
            $events.Add($name)
            if ($fail -ccontains $name) { throw 'simulated failure' }
        }.GetNewClosure()
    }
    return @{ Ops=$ops; Events=$events }
}
$pass = New-Fixture @()
if ((Invoke-GuardedSettingsCorrection -Operations $pass.Ops) -cne 'corrected' -or
    ($pass.Events -join ',') -cne 'VerifyBefore,BackupTask,ApplyCount,VerifyAfter') {
    throw 'Successful correction must back up, update, and verify exactly once.'
}
foreach ($precheck in @('VerifyBefore','BackupTask')) {
    $fixture = New-Fixture @($precheck)
    try {
        Invoke-GuardedSettingsCorrection -Operations $fixture.Ops | Out-Null
        throw 'Unexpected success for unsafe precondition.'
    } catch {
        if ($_.Exception.Message -eq 'Unexpected success for unsafe precondition.') { throw }
    }
    if (($fixture.Events -join ',') -notmatch "^(VerifyBefore|VerifyBefore,BackupTask)$") {
        throw 'No update or rollback allowed before initial gates pass.'
    }
}
foreach ($failed in @('ApplyCount','VerifyAfter')) {
    $fixture = New-Fixture @($failed)
    try {
        Invoke-GuardedSettingsCorrection -Operations $fixture.Ops | Out-Null
        throw 'Unexpected success after setting failure.'
    } catch {
        if ($_.Exception.Message -eq 'Unexpected success after setting failure.') { throw }
        if ($_.Exception.Message -notmatch 'ROLLED BACK') { throw }
    }
    if (($fixture.Events -join ',') -notmatch 'RestorePrior,VerifyRestored$') {
        throw 'Correction failure must restore and verify the prior task settings.'
    }
}
$unverified = New-Fixture @('VerifyAfter','VerifyRestored')
try {
    Invoke-GuardedSettingsCorrection -Operations $unverified.Ops | Out-Null
    throw 'Unexpected success after unverified rollback.'
} catch {
    if ($_.Exception.Message -eq 'Unexpected success after unverified rollback.') { throw }
    if ($_.Exception.Message -notmatch 'ROLLBACK UNVERIFIED') { throw }
}
Write-Output 'Restart-settings repair, XML-only delta, and rollback contracts passed.'
