$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Real filesystem failure injection; only the OS process/task boundaries are
# intercepted. No installed agent, registry entry, task or credential is used.
$installer = Join-Path $PSScriptRoot '..\..\scripts\install-windows.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('tetherplane-install-rollback-' + [guid]::NewGuid().ToString('N'))
$package = Join-Path $root 'package'
$global:tpRollbackInjectCopyFailure = $false
$global:tpRollbackInjectTaskFailure = $false
$global:tpRollbackRegisteredTask = $null
$global:tpRollbackTaskAttempted = $false
$global:tpRollbackPartialRegistration = $false
function Get-CimInstance { [CmdletBinding()] param($ClassName, $Filter) return @() }
function Get-ScheduledTask {
    [CmdletBinding()] param($TaskName)
    if ($TaskName -and $global:tpRollbackTaskAttempted) {
        throw 'CmdletizationQuery_NotFound_TaskName: requested task does not exist'
    }
    if ($global:tpRollbackRegisteredTask) { return $global:tpRollbackRegisteredTask }
    return @()
}
function New-ScheduledTaskAction { param($Execute, $Argument) return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument } }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn) return @{} }
function New-ScheduledTaskSettingsSet {
    param($MultipleInstances, $RestartCount, $RestartInterval, $ExecutionTimeLimit,
        [switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries)
    return @{}
}
function Register-ScheduledTask {
    param($TaskName, $Action, $Trigger, $Settings, $RunLevel)
    $global:tpRollbackTaskAttempted = $true
    if ($global:tpRollbackInjectTaskFailure -and -not $global:tpRollbackPartialRegistration) { throw 'INJECTED_TASK_REGISTRATION_FAILURE' }
    $global:tpRollbackRegisteredTask = [pscustomobject]@{
        TaskName = $TaskName; State = 'Ready'; Principal = [pscustomobject]@{ RunLevel = $RunLevel }
        Actions = @([pscustomobject]@{ Execute = $Action.Execute; Arguments = $Action.Arguments })
    }
    if ($global:tpRollbackPartialRegistration) { throw 'INJECTED_TASK_REGISTRATION_FAILURE_AFTER_CREATION' }
}
function Unregister-ScheduledTask {
    [CmdletBinding()] param($TaskName, $Confirm)
    if ($global:tpRollbackRegisteredTask.TaskName -cne $TaskName) { throw 'unexpected task removal' }
    $global:tpRollbackRegisteredTask = $null
}
function Get-ItemProperty { [CmdletBinding()] param($Path, $Name) return $null }
function Remove-ItemProperty { throw 'test forbids registry changes' }
function Stop-Process { throw 'test forbids process termination' }
function Copy-Item {
    [CmdletBinding()]
    param($LiteralPath, $Destination, [switch]$Recurse, [switch]$Force)
    if ($global:tpRollbackInjectCopyFailure -and $LiteralPath -eq (Join-Path $package 'adapters')) {
        throw 'INJECTED_COPY_FAILURE'
    }
    Microsoft.PowerShell.Management\Copy-Item @PSBoundParameters
}

function Assert-True($Condition, $Message) { if (-not $Condition) { throw $Message } }
function Assert-No-Scratch($Parent) {
    $scratch = @(Get-ChildItem -LiteralPath $Parent -Force | Where-Object Name -Match '^\.tetherplane-(install|backup)-')
    Assert-True ($scratch.Count -eq 0) 'failed install left staging/backup debris'
}

try {
    foreach ($relative in @('bin\tetherd.exe', 'bin\tetherd-agentw.exe',
        'bin\tetherplane-browserw.exe', 'bin\tetherplane-modelw.exe',
        'adapters\compact-mcp\dist\stdio-server.js', 'protocol\schemas\result.schema.json',
        'launch\tetherplane-mcp.ps1', 'launch\tetherplane-browser.ps1', 'launch\tetherplane-browser-setup.ps1',
        'browser\host.mjs', 'browser\extension\manifest.json', 'browser\extension\dist\background.js',
        'browser\extension\dist\pair.js', 'manifest.json', 'uninstall-windows.ps1')) {
        $file = Join-Path $package $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
        [IO.File]::WriteAllText($file, 'new-candidate-fixture')
    }
    $install = Join-Path $root 'install'
    $state = Join-Path $root 'state'
    foreach ($overlap in @((Join-Path $install 'state'), $install, $root)) {
        $denied = $false
        try { & $installer -PackagePath $package -InstallPrefix $install -StateDir $overlap }
        catch { if ($_.Exception.Message -notmatch 'state and install directories must be separate') { throw }; $denied = $true }
        Assert-True $denied 'installer accepted overlapping state/install paths'
        Assert-True (-not (Test-Path -LiteralPath $install)) 'overlap denial modified install'
    }
    Write-Output 'WINDOWS_OVERLAPPING_STATE_DENIED_BEFORE_WRITE_OK'
    $fileState = Join-Path $root 'state-is-file'
    [IO.File]::WriteAllText($fileState, 'preserve-existing-file')
    $denied = $false
    try { & $installer -PackagePath $package -InstallPrefix $install -StateDir $fileState }
    catch { if ($_.Exception.Message -notmatch 'existing state path must be a directory') { throw }; $denied = $true }
    Assert-True $denied 'installer accepted a file as existing state directory'
    Assert-True (-not (Test-Path -LiteralPath $install)) 'invalid state path modified install'
    Assert-True ([IO.File]::ReadAllText($fileState) -ceq 'preserve-existing-file') 'invalid state path changed owner file'
    Write-Output 'WINDOWS_STATE_FILE_DENIED_BEFORE_WRITE_OK'
    $global:tpRollbackInjectCopyFailure = $true
    $failed = $false
    try { & $installer -PackagePath $package -InstallPrefix $install -StateDir $state }
    catch { if ($_.Exception.Message -notmatch 'INJECTED_COPY_FAILURE') { throw }; $failed = $true }
    Assert-True $failed 'copy injection did not fail'
    Assert-True (-not (Test-Path -LiteralPath $install)) 'failed fresh copy left a partial installation'
    Assert-True (-not (Test-Path -LiteralPath $state)) 'failed fresh copy created state'
    Assert-No-Scratch $root
    Write-Output 'WINDOWS_FRESH_COPY_FAILURE_NO_PARTIAL_INSTALL_OK'

    $global:tpRollbackInjectCopyFailure = $false
    & $installer -PackagePath $package -InstallPrefix $install -StateDir $state
    $receiptPath = Join-Path $install 'config\install.json'
    $receiptBefore = [IO.File]::ReadAllText($receiptPath)
    [IO.File]::WriteAllText((Join-Path $install 'bin\tetherd.exe'), 'old-reviewed-candidate')
    [IO.File]::WriteAllText((Join-Path $state 'owner-data.txt'), 'preserve-owner-state')

    foreach ($failure in @('copy', 'task', 'task-after-creation')) {
        $global:tpRollbackTaskAttempted = $false
        $global:tpRollbackInjectCopyFailure = $failure -eq 'copy'
        $global:tpRollbackInjectTaskFailure = $failure -like 'task*'
        $global:tpRollbackPartialRegistration = $failure -eq 'task-after-creation'
        $options = @{ PackagePath = $package; InstallPrefix = $install; StateDir = $state; Force = $true }
        if ($failure -like 'task*') {
            $argumentsFile = Join-Path $root 'synthetic-args.json'
            [IO.File]::WriteAllText($argumentsFile, '["--relay-url","wss://localhost.invalid/device","--device-id","fixture","--device-credential-file","C:\\synthetic-not-read"]')
            $options.InstallScheduledTask = $true
            $options.AgentArgumentsFile = $argumentsFile
            $options.AgentTaskName = 'Tetherplane CI-Rollback'
        }
        $failed = $false
        try { & $installer @options }
        catch { if ($_.Exception.Message -notmatch 'INJECTED_(COPY|TASK_REGISTRATION)_FAILURE') { throw }; $failed = $true }
        Assert-True $failed 'failure injection unexpectedly succeeded'
        Assert-True (Test-Path -LiteralPath $receiptPath) 'upgrade failure deleted prior receipt'
        Assert-True ([IO.File]::ReadAllText($receiptPath) -ceq $receiptBefore) 'upgrade failure changed prior receipt'
        Assert-True ([IO.File]::ReadAllText((Join-Path $install 'bin\tetherd.exe')) -ceq 'old-reviewed-candidate') 'upgrade failure lost prior binary'
        Assert-True ([IO.File]::ReadAllText((Join-Path $state 'owner-data.txt')) -ceq 'preserve-owner-state') 'upgrade failure altered owner state'
        Assert-True ($null -eq $global:tpRollbackRegisteredTask) 'failed install registered a task'
        Assert-No-Scratch $root
        Write-Output ('WINDOWS_UPGRADE_ROLLBACK_OK ' + $failure)
    }
    $global:tpRollbackInjectCopyFailure = $false
    $global:tpRollbackInjectTaskFailure = $false
    $global:tpRollbackTaskAttempted = $false
    $global:tpRollbackPartialRegistration = $false
    & $installer -PackagePath $package -InstallPrefix $install -StateDir $state -Force
    Assert-True ([IO.File]::ReadAllText((Join-Path $install 'bin\tetherd.exe')) -ceq 'new-candidate-fixture') 'successful upgrade did not install candidate'
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    Assert-True ([bool]$receipt.state_created_by_installer) 'upgrade lost prior installer state ownership'
    Assert-True ([IO.File]::ReadAllText((Join-Path $state 'owner-data.txt')) -ceq 'preserve-owner-state') 'successful upgrade changed state'
    Assert-No-Scratch $root
    Write-Output 'WINDOWS_UPGRADE_PRESERVES_STATE_OWNERSHIP_OK'
    # Legacy receipts may predate the install-side overlap guard. Refuse
    # ordinary uninstall BEFORE it can recursively remove nested owner data.
    $nestedState = Join-Path $install 'legacy-state'
    New-Item -ItemType Directory -Path $nestedState | Out-Null
    $marker = Join-Path $nestedState 'owner-data.txt'
    [IO.File]::WriteAllText($marker, 'preserve-legacy-state')
    $receipt.state_dir = $nestedState
    $receipt | ConvertTo-Json | Set-Content -LiteralPath $receiptPath
    $denied = $false
    try { & $installer -PackagePath $package -InstallPrefix $install -StateDir (Join-Path $root 'new-state') -Force }
    catch { if ($_.Exception.Message -notmatch 'previous state and install directories overlap') { throw }; $denied = $true }
    Assert-True $denied 'upgrade accepted prior nested state and could purge it with the backup'
    Assert-True ([IO.File]::ReadAllText($marker) -ceq 'preserve-legacy-state') 'upgrade lost prior nested owner data'
    Write-Output 'WINDOWS_LEGACY_NESTED_STATE_UPGRADE_DENIED_OK'
    $denied = $false
    try { & (Join-Path $PSScriptRoot '..\..\scripts\uninstall-windows.ps1') -InstallPrefix $install }
    catch { if ($_.Exception.Message -notmatch 'state and install directories overlap') { throw }; $denied = $true }
    Assert-True $denied 'ordinary uninstall accepted a legacy overlapping state directory'
    Assert-True ([IO.File]::ReadAllText($marker) -ceq 'preserve-legacy-state') 'ordinary uninstall lost legacy owner data'
    Write-Output 'WINDOWS_LEGACY_NESTED_STATE_UNINSTALL_DENIED_OK'
} finally {
    $safeParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ([IO.Path]::GetFullPath($root).StartsWith($safeParent + 'tetherplane-install-rollback-', [StringComparison]::OrdinalIgnoreCase)) {
        Microsoft.PowerShell.Management\Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}
