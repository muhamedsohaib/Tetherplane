# The obsolete launcher/supervisor runtime test is replaced by the PR44
# native Scheduled Task ownership contract. All process/task calls below are
# mocked; real task lifecycle proof is in windows-native-onboarding-kit.ps1
# on an explicitly opted-in disposable GitHub Windows runner.
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

Describe "native Scheduled Task ownership for a newly paired Windows device" {
    BeforeEach {
        . (Join-Path $repo "scripts\setup-windows-device.ps1")
        $script:tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-native-task-unit-" + [Guid]::NewGuid().ToString("N"))
        $script:install = Join-Path $script:tempRoot "install"
        $script:state = Join-Path $script:tempRoot "state"
        $script:exe = Join-Path $script:install "bin\tetherd.exe"
        $script:argsPath = Join-Path $script:install "config\agent-args.json"
        New-Item -ItemType Directory -Path (Join-Path $script:install "bin"),(Join-Path $script:install "config") -Force | Out-Null
        [IO.File]::WriteAllText($script:exe, "CI synthetic executable - never launch")
        [void](Install-DeviceIdentity -StateDir $script:state -DeviceId "TESTPC01")
        Mock Get-ScheduledTask { return $null }
        Mock Register-ScheduledTask { return $null }
        Mock Start-ScheduledTask { return $null }
    }
    AfterEach {
        if ($script:tempRoot -and (Test-Path -LiteralPath $script:tempRoot)) {
            Remove-Item -LiteralPath $script:tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "owns tetherd directly and hides device identity behind an arguments file" {
        Mock Get-CimInstance { return @() }
        $result = Install-DeviceAgentTask -InstallPrefix $script:install -StateDir $script:state -DeviceId "TESTPC01" -RelayUrl "wss://example.invalid/device"
        $result.native_task | Should Be $true
        $result.started | Should Be $true
        $script:expectedArguments = '--arguments-file "' + $script:argsPath + '"'
        Assert-MockCalled Register-ScheduledTask -Exactly 1 -Scope It -ParameterFilter {
            [string]$Action.Execute -ieq $script:exe -and
            [string]$Action.Arguments -ceq $script:expectedArguments -and
            [string]$Settings.MultipleInstances -eq "IgnoreNew" -and
            [int]$Settings.RestartCount -eq 99 -and
            [string]$Principal.RunLevel -eq "Limited"
        }
        Assert-MockCalled Start-ScheduledTask -Exactly 1 -Scope It
        $args = @(Get-Content -LiteralPath $script:argsPath -Raw | ConvertFrom-Json)
        $args -contains "--device-credential-file" | Should Be $true
        $args -contains (Join-Path $script:state "device.credential") | Should Be $true
        $args -contains "--principal-profile" | Should Be $true
        $profile = Get-Content -LiteralPath (Join-Path $script:state "principal.json") -Raw | ConvertFrom-Json
        @($profile.allowed_capabilities) | Should Be @("device.status")
    }

    It "rejects an already running agent before registering a competing task" {
        Mock Get-CimInstance {
            return [pscustomobject]@{
                Name = "tetherd.exe"
                ExecutablePath = $script:exe
            }
        }
        { Install-DeviceAgentTask -InstallPrefix $script:install -StateDir $script:state -DeviceId "TESTPC01" -RelayUrl "wss://example.invalid/device" } | Should Throw
        Assert-MockCalled Register-ScheduledTask -Times 0 -Exactly -Scope It
        Assert-MockCalled Start-ScheduledTask -Times 0 -Exactly -Scope It
        Test-Path -LiteralPath $script:argsPath | Should Be $false
    }
}
