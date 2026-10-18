# Safely request reconnection of an EXISTING, locally owned Windows Tetherplane task.
# This is not an installer, a pairing grant, a signature bypass, or account-side proof.
[CmdletBinding()]
param(
    [ValidateSet("Leno", "RTX", "Surface", "Vaulter")]
    [string]$DeviceId = "Leno",
    [switch]$Run
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-TetherplaneTaskName {
    param([Parameter(Mandatory = $true)][string]$DeviceId)
    if ($DeviceId -cnotin @("Leno", "RTX", "Surface", "Vaulter")) {
        throw "unsupported device identifier"
    }
    if ($DeviceId -ceq "Leno") { return "Tetherplane Leno Agent" }
    return "Tetherplane Agent"
}

function Assert-TetherplaneOwnedTask {
    param(
        [Parameter(Mandatory = $true)]$Task,
        [Parameter(Mandatory = $true)][string[]]$AllowedOwners
    )
    if (@($Task.Actions).Count -ne 1) { throw "task has an unexpected action count; refusing start" }
    $owner = [string]$Task.Principal.UserId
    if (-not $owner -or $owner -notin $AllowedOwners) {
        throw "task owner cannot be authenticated as this Windows user; refusing start"
    }
    $action = $Task.Actions[0]
    $executor = [string]$action.Execute
    if ([IO.Path]::GetFileName($executor) -ine "powershell.exe") {
        throw "task does not use the expected Windows PowerShell supervisor"
    }
    $argsText = [string]$action.Arguments
    if ($argsText -notmatch '(?i)(?:^|\s)-File\s+"?[^"]*\\launch\\tetherplane-agent\.ps1"?(?:\s|$)') {
        throw "task does not reference a recognized Tetherplane supervisor"
    }
}

function Invoke-TetherplaneConnect {
    param(
        [Parameter(Mandatory = $true)][string]$DeviceId,
        [string[]]$AllowedOwners = @(
            ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value,
            ([Security.Principal.WindowsIdentity]::GetCurrent()).Name,
            $env:USERNAME
        ),
        [switch]$NoWait
    )
    $taskName = Resolve-TetherplaneTaskName -DeviceId $DeviceId
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath "\" -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        throw "no existing owned Tetherplane task named '$taskName'. Use the verified device-kit onboarding procedure; do not create or re-pair blindly."
    }
    Assert-TetherplaneOwnedTask -Task $task -AllowedOwners $AllowedOwners
    $status = "already_running"
    if ([string]$task.State -ne "Running") {
        Start-ScheduledTask -TaskName $taskName -TaskPath "\" -ErrorAction Stop
        $status = "start_requested"
    }
    if (-not $NoWait) {
        Start-Sleep -Seconds 4
        $current = Get-ScheduledTask -TaskName $taskName -TaskPath "\" -ErrorAction Stop
        if ([string]$current.State -ne "Running") {
            $status = "not_running"
        } else {
            $status = "task_running"
        }
    }
    return [ordered]@{
        device = $DeviceId
        task = $taskName
        status = $status
        account_verified = $false
        next = "Confirm through the authenticated Tetherplane MCP device tool with op=status and device=$DeviceId. A running task alone does not prove the relay or ChatGPT can reach it. Windows Smart App Control may block an unsigned agent."
    }
}

if ($MyInvocation.InvocationName -ne ".") {
    Invoke-TetherplaneConnect -DeviceId $DeviceId | ConvertTo-Json -Compress
}
