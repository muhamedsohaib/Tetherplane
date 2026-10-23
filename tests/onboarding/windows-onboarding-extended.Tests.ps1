
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
. (Join-Path $PSScriptRoot "helpers.ps1")

Describe "managed install integrity and repair" {
    BeforeEach {
        . (Join-Path $repo "scripts\setup-windows-device.ps1")
        $script:tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-repair-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $script:tempRoot | Out-Null
        $script:pkg = New-TestPackage $script:tempRoot
        $script:install = Join-Path $script:tempRoot "install"
    }
    AfterEach {
        if ($script:tempRoot) { Remove-Item -LiteralPath $script:tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "rejects a tampered package file" {
        Add-Content -LiteralPath (Join-Path $script:pkg "bin\tetherd.exe") -Value "tampered" -Encoding Ascii
        { Confirm-DevicePackage -PackagePath $script:pkg } | Should Throw
    }

    It "requires the hash manifest and full kit coverage" {
        Remove-Item -LiteralPath (Join-Path $script:pkg "manifest.sha256")
        { Confirm-DevicePackage -PackagePath $script:pkg } | Should Throw
    }

    It "repairs managed files without touching unknown files" {
        Install-ManagedDeviceFiles -PackagePath $script:pkg -InstallPrefix $script:install | Out-Null
        Remove-Item -LiteralPath (Join-Path $script:install "bin\tetherd.exe")
        Set-Content -LiteralPath (Join-Path $script:install "unknown-keep.txt") -Value "user file" -Encoding Ascii
        $result = Install-ManagedDeviceFiles -PackagePath $script:pkg -InstallPrefix $script:install
        $result.repaired | Should Be $true
        Test-Path -LiteralPath (Join-Path $script:install "bin\tetherd.exe") | Should Be $true
        Test-Path -LiteralPath (Join-Path $script:install "unknown-keep.txt") | Should Be $true
    }

    It "verifies a package even when launched with a PowerShell 7 module path" {
        $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
        if (-not $pwsh) {
            Set-TestInconclusive "pwsh 7 is not installed, so a polluted module path cannot be simulated here"
            return
        }
        $ps7Home = (& pwsh -NoProfile -Command '$PSHOME' 2>$null | Select-Object -First 1)
        $ps7Modules = if ($ps7Home) { Join-Path $ps7Home "Modules" } else { "" }
        if (-not $ps7Modules -or -not (Test-Path -LiteralPath (Join-Path $ps7Modules "Microsoft.PowerShell.Utility"))) {
            Set-TestInconclusive "pwsh 7 Microsoft.PowerShell.Utility module was not found under $ps7Modules"
            return
        }
        $clean = "$env:ProgramFiles\WindowsPowerShell\Modules;$env:SystemRoot\system32\WindowsPowerShell\v1.0\Modules"
        $setupScript = Join-Path $repo "scripts\setup-windows-device.ps1"
        $outFile = Join-Path $script:tempRoot "child-out.txt"
        $errFile = Join-Path $script:tempRoot "child-err.txt"
        $command = ". '{0}'; (Confirm-DevicePackage -PackagePath '{1}').ok" -f $setupScript, $script:pkg
        $previous = $env:PSModulePath
        $child = $null
        try {
            $env:PSModulePath = $ps7Modules + ";" + $clean
            $child = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ('"' + $command + '"')) -RedirectStandardOutput $outFile -RedirectStandardError $errFile -WindowStyle Hidden -PassThru
        } finally {
            $env:PSModulePath = $previous
        }
        try {
            $exited = $child.WaitForExit(60000)
            $exited | Should Be $true
            $stdout = (Get-Content -LiteralPath $outFile -Raw -ErrorAction SilentlyContinue)
            $stderr = (Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue)
            if ("$stdout".Trim() -ne "True") {
                throw ("package verification failed under a polluted module path. stdout: " + $stdout + " stderr: " + $stderr)
            }
        } finally {
            if ($child -and -not $child.HasExited) { try { $child.Kill() } catch { } }
            if ($child) { $child.Dispose() }
        }
    }

    It "refuses an unmanaged prefix and has no force override" {
        New-Item -ItemType Directory -Force -Path $script:install | Out-Null
        Set-Content -LiteralPath (Join-Path $script:install "stranger.txt") -Value "x" -Encoding Ascii
        { Install-ManagedDeviceFiles -PackagePath $script:pkg -InstallPrefix $script:install } | Should Throw
        (Get-Command Install-ManagedDeviceFiles).Parameters.ContainsKey("Force") | Should Be $false
        Test-Path -LiteralPath (Join-Path $script:install "stranger.txt") | Should Be $true
    }

    It "writes a least-privilege principal once and keeps existing policy" {
        Install-ManagedDeviceFiles -PackagePath $script:pkg -InstallPrefix $script:install | Out-Null
        $state = Join-Path $script:tempRoot "state"
        Install-DeviceIdentity -StateDir $state -DeviceId "TESTPC01" | Out-Null
        Mock Get-ScheduledTask { return $null }
        Mock Register-ScheduledTask { return $null }
        Mock Start-ScheduledTask { return $null }
        $task = Install-DeviceAgentTask -InstallPrefix $script:install -StateDir $state -DeviceId "TESTPC01" -RelayUrl "wss://x/device"
        $principal = Get-Content -LiteralPath (Join-Path $state "principal.json") -Raw | ConvertFrom-Json
        $principal.authentication | Should Be "local_process_binding"
        @($principal.allowed_capabilities) | Should Be @("device.status")
        @($principal.allowed_devices) | Should Be @("TESTPC01")
        $bytes = [IO.File]::ReadAllBytes((Join-Path $state "principal.json"))
        ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) | Should Be $false
        $task.agent_args -contains "--device-credential-file" | Should Be $true
        $task.agent_args -contains (Join-Path $state "device.credential") | Should Be $true
        Set-Content -LiteralPath (Join-Path $state "principal.json") -Value '{"custom":true}' -Encoding Ascii
        $again = Install-DeviceAgentTask -InstallPrefix $script:install -StateDir $state -DeviceId "TESTPC01" -RelayUrl "wss://x/device"
        $again.principal_kept | Should Be $true
        (Get-Content -LiteralPath (Join-Path $state "principal.json") -Raw) | Should Match "custom"
    }

    It "registers a per-user limited task with single-instance semantics and starts it now" {
        Install-ManagedDeviceFiles -PackagePath $script:pkg -InstallPrefix $script:install | Out-Null
        $state = Join-Path $script:tempRoot "state"
        Install-DeviceIdentity -StateDir $state -DeviceId "TESTPC01" | Out-Null
        Mock Get-ScheduledTask { return $null }
        Mock Register-ScheduledTask { return $null }
        Mock Start-ScheduledTask { return $null }
        $task = Install-DeviceAgentTask -InstallPrefix $script:install -StateDir $state -DeviceId "TESTPC01" -RelayUrl "wss://x/device"
        @($task).Count | Should Be 1
        $task.started | Should Be $true
        Assert-MockCalled Register-ScheduledTask -Exactly 1 -Scope It -ParameterFilter {
            [string]$Settings.MultipleInstances -eq "IgnoreNew" -and
            [string]$Principal.RunLevel -eq "Limited" -and
            [string]$Principal.LogonType -eq "Interactive"
        }
        Assert-MockCalled Start-ScheduledTask -Exactly 1 -Scope It
    }

    It "refuses an unmanaged task and never duplicates a managed one" {
        Install-ManagedDeviceFiles -PackagePath $script:pkg -InstallPrefix $script:install | Out-Null
        $state = Join-Path $script:tempRoot "state"
        Install-DeviceIdentity -StateDir $state -DeviceId "TESTPC01" | Out-Null
        Mock Get-ScheduledTask { [pscustomobject]@{ TaskName = "Tetherplane Agent"; Principal = [pscustomobject]@{ UserId = "S-1-5-21-foreign" }; Actions = @([pscustomobject]@{ Execute = "C:\Other\tetherd.exe"; Arguments = "--arguments-file C:\Other\args.json" }); State = "Ready" } }
        Mock Register-ScheduledTask { return $null }
        { Install-DeviceAgentTask -InstallPrefix $script:install -StateDir $state -DeviceId "TESTPC01" -RelayUrl "wss://x/device" } | Should Throw
        $argsFile = Join-Path $script:install "config\agent-args.json"
        [IO.File]::WriteAllText($argsFile, '["--relay-url","wss://x/device"]', [Text.UTF8Encoding]::new($false))
        $nativeAction = [pscustomobject]@{
            Execute = (Join-Path $script:install "bin\tetherd.exe")
            Arguments = ('--arguments-file "' + $argsFile + '"')
        }
        Mock Get-ScheduledTask { [pscustomobject]@{ TaskName = "Tetherplane Agent"; Principal = [pscustomobject]@{ UserId = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value }; Actions = @($nativeAction); State = "Ready" } }
        $reused = Install-DeviceAgentTask -InstallPrefix $script:install -StateDir $state -DeviceId "TESTPC01" -RelayUrl "wss://x/device"
        $reused.reused | Should Be $true
        $reused.native_task | Should Be $true
        Assert-MockCalled Register-ScheduledTask -Times 0 -Exactly -Scope It
    }
}

Describe "pairing record and resume" {
    BeforeEach {
        . (Join-Path $repo "scripts\pair-windows-device.ps1")
        $script:tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-resume-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $script:tempRoot | Out-Null
        $script:mock = Start-MockRelay $script:tempRoot
        $script:state = Join-Path $script:tempRoot "state"
        New-Item -ItemType Directory -Force -Path $script:state | Out-Null
    }
    AfterEach {
        Stop-MockRelay $script:mock
        if ($script:tempRoot) { Remove-Item -LiteralPath $script:tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "reuses an unexpired recorded code without a new request" {
        @{ device_id = "TESTPC01"; userCode = "ABCD-1234"; expiresAt = "2099-01-01T00:00:00Z" } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $script:state "pairing.json") -Encoding Ascii
        $result = Request-DevicePairing -RelayUrl $script:mock.Url -DeviceId "TESTPC01" -Credential "TEST-CREDENTIAL-ABCDEFGHIJKLMNOP" -StateDir $script:state
        $result.userCode | Should Be "ABCD-1234"
        $result.resumed | Should Be $true
        Test-Path -LiteralPath (Join-Path $script:tempRoot "requests.log") | Should Be $false
    }

    It "renews an expired recorded code" {
        @{ device_id = "TESTPC01"; userCode = "OLD-0000"; expiresAt = "2000-01-01T00:00:00Z" } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $script:state "pairing.json") -Encoding Ascii
        $result = Request-DevicePairing -RelayUrl $script:mock.Url -DeviceId "TESTPC01" -Credential "TEST-CREDENTIAL-ABCDEFGHIJKLMNOP" -StateDir $script:state
        $result.userCode | Should Be "ABCD-1234"
        Test-Path -LiteralPath (Join-Path $script:tempRoot "requests.log") | Should Be $true
    }
}

Describe "composed setup CLI" {
    BeforeEach {
        $script:tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-composed-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $script:tempRoot | Out-Null
        . (Join-Path $repo "scripts\pair-windows-device.ps1")
        $script:pkg = New-TestPackage $script:tempRoot
        $script:mock = Start-MockRelay $script:tempRoot
    }
    AfterEach {
        Stop-MockRelay $script:mock
        if ($script:tempRoot) { Remove-Item -LiteralPath $script:tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "runs verify, install, identity and pairing end to end without scope clobber" {
        $install = Join-Path $script:tempRoot "install"
        $state = Join-Path $script:tempRoot "state"
        $first = & (Join-Path $repo "scripts\setup-windows-device.ps1") -Run -PackagePath $script:pkg -DeviceId "TESTPC01" -InstallPrefix $install -StateDir $state -Pair -PairingOrigin $script:mock.Url | ConvertFrom-Json
        $first.ok | Should Be $true
        $first.pairing.userCode | Should Be "ABCD-1234"
        $first.approval_instruction | Should Match "http://127[.]0[.]0[.]1:8791"
        $first.approval_instruction | Should Match "VAULTER"
        $first.approval_instruction | Should Match "Pairing"
        $first.approval_instruction | Should Match "ABCD-1234"
        $first.approval_instruction | Should Match "TESTPC01"
        $first.approval_instruction | Should Not Match "approve_pairing"
        Test-Path -LiteralPath (Join-Path $state "pairing.json") | Should Be $true
        Remove-Item -LiteralPath (Join-Path $script:tempRoot "requests.log")
        $second = & (Join-Path $repo "scripts\setup-windows-device.ps1") -Run -PackagePath $script:pkg -DeviceId "TESTPC01" -InstallPrefix $install -StateDir $state -Pair -PairingOrigin $script:mock.Url | ConvertFrom-Json
        $second.pairing.userCode | Should Be "ABCD-1234"
        $second.pairing.resumed | Should Be $true
        $second.approval_instruction | Should Match "http://127[.]0[.]0[.]1:8791"
        $second.approval_instruction | Should Match "ABCD-1234"
        $second.approval_instruction | Should Match "TESTPC01"
        $second.approval_instruction | Should Not Match "approve_pairing"
        Test-Path -LiteralPath (Join-Path $script:tempRoot "requests.log") | Should Be $false
    }
}
