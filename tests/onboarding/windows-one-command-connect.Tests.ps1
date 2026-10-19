$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
. (Join-Path $repo "scripts\connect-windows-device.ps1")

function New-ConnectFixtureTask {
    param([string]$Owner = "TESTER", [string]$Execute = "powershell.exe",
        [string]$Arguments = '-NoProfile -NonInteractive -File "C:\Users\Tester\AppData\Local\Programs\Tetherplane\launch\tetherplane-agent.ps1"',
        [string]$State = "Ready")
    return [pscustomobject]@{
        Principal = [pscustomobject]@{ UserId = $Owner }
        Actions = @([pscustomobject]@{ Execute = $Execute; Arguments = $Arguments })
        State = $State
    }
}

Describe "one-command existing Windows device recovery" {
    # Pester 3 defaults to Describe-wide mock call history; isolate each assertion to its It.
    It "uses the legacy Leno task without guessing a new identity" {
        (Resolve-TetherplaneTaskName -DeviceId "Leno") | Should Be "Tetherplane Leno Agent"
        (Resolve-TetherplaneTaskName -DeviceId "Surface") | Should Be "Tetherplane Agent"
    }

    It "rejects unsafe device identifiers before looking for tasks" {
        { Resolve-TetherplaneTaskName -DeviceId "../Leno" } | Should Throw
        { Resolve-TetherplaneTaskName -DeviceId "Leno; whoami" } | Should Throw
    }

    It "requires task owner, PowerShell executable and an agent supervisor file" {
        $valid = New-ConnectFixtureTask
        { Assert-TetherplaneOwnedTask -Task $valid -AllowedOwners @("TESTER") } | Should Not Throw
        { Assert-TetherplaneOwnedTask -Task (New-ConnectFixtureTask -Owner "OTHER") -AllowedOwners @("TESTER") } | Should Throw
        { Assert-TetherplaneOwnedTask -Task (New-ConnectFixtureTask -Execute "cmd.exe") -AllowedOwners @("TESTER") } | Should Throw
        { Assert-TetherplaneOwnedTask -Task (New-ConnectFixtureTask -Arguments '-Command "Invoke-Expression unsafe"') -AllowedOwners @("TESTER") } | Should Throw
    }

    It "will not start an already running owned task or declare ChatGPT connectivity" {
        Mock Get-ScheduledTask { New-ConnectFixtureTask -State "Running" }
        Mock Start-ScheduledTask { throw "must not restart" }
        $result = Invoke-TetherplaneConnect -DeviceId "Leno" -AllowedOwners @("TESTER") -NoWait
        $result.status | Should Be "already_running"
        $result.account_verified | Should Be $false
        Assert-MockCalled Start-ScheduledTask -Times 0 -Exactly -Scope It
    }

    It "starts only a verified stopped task and returns unverified account status" {
        Mock Get-ScheduledTask { New-ConnectFixtureTask }
        Mock Start-ScheduledTask { }
        $result = Invoke-TetherplaneConnect -DeviceId "Leno" -AllowedOwners @("TESTER") -NoWait
        $result.status | Should Be "start_requested"
        $result.account_verified | Should Be $false
        Assert-MockCalled Start-ScheduledTask -Times 1 -Exactly -Scope It
    }

    It "never starts a foreign task" {
        Mock Get-ScheduledTask { New-ConnectFixtureTask -Owner "OTHER" }
        Mock Start-ScheduledTask { throw "must not start" }
        { Invoke-TetherplaneConnect -DeviceId "Leno" -AllowedOwners @("TESTER") -NoWait } | Should Throw
        Assert-MockCalled Start-ScheduledTask -Times 0 -Exactly -Scope It
    }
}
