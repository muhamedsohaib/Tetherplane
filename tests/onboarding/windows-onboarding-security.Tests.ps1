$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

Describe "device credential directory protection" {
    BeforeEach {
        . (Join-Path $repo "scripts\setup-windows-device.ps1")
        $script:securityRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-credential-acl-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $script:securityRoot | Out-Null
    }
    AfterEach {
        if ($script:securityRoot) { Remove-Item -LiteralPath $script:securityRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It "refuses an explicit foreign directory grant before writing any credential" {
        $acl = Get-Acl -LiteralPath $script:securityRoot
        $everyone = New-Object Security.Principal.SecurityIdentifier("S-1-1-0")
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($everyone, "ReadAndExecute", "ContainerInherit,ObjectInherit", "None", "Allow")
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $script:securityRoot -AclObject $acl
        { Install-DeviceIdentity -StateDir $script:securityRoot -DeviceId "AclProtectedPC" } | Should Throw
        Test-Path -LiteralPath (Join-Path $script:securityRoot "device.credential") | Should Be $false
        Test-Path -LiteralPath (Join-Path $script:securityRoot "device-id.txt") | Should Be $false
    }
}

. (Join-Path $PSScriptRoot "helpers.ps1")
Describe "managed destination containment" {
    BeforeEach {
        . (Join-Path $repo "scripts\setup-windows-device.ps1")
        $script:containRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-containment-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $script:containRoot | Out-Null
        $script:pkg = New-TestPackage $script:containRoot
        $script:install = Join-Path $script:containRoot "install"
        $script:outside = Join-Path $script:containRoot "outside"
        New-Item -ItemType Directory -Path $script:outside | Out-Null
    }
    AfterEach {
        if ($script:containRoot) { Remove-Item -LiteralPath $script:containRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It "rejects a forged or mismatched receipt before overwriting files" {
        New-Item -ItemType Directory -Path (Join-Path $script:install "config"),(Join-Path $script:install "bin") | Out-Null
        $target = Join-Path $script:install "bin\tetherd.exe"
        Set-Content -LiteralPath $target -Value "unmanaged original" -Encoding Ascii -NoNewline
        foreach ($receipt in @(
            @{ managed_by = "another-installer"; install_prefix = $script:install },
            @{ managed_by = "setup-windows-device.ps1"; install_prefix = $script:outside }
        )) {
            $receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:install "config\install.json")
            { Install-ManagedDeviceFiles -PackagePath $script:pkg -InstallPrefix $script:install } | Should Throw
            (Get-Content -LiteralPath $target -Raw) | Should Be "unmanaged original"
        }
    }
    It "rejects a managed bin junction without overwriting its external target" {
        Install-ManagedDeviceFiles -PackagePath $script:pkg -InstallPrefix $script:install | Out-Null
        Remove-Item -LiteralPath (Join-Path $script:install "bin") -Recurse -Force
        $target = Join-Path $script:outside "tetherd.exe"
        Set-Content -LiteralPath $target -Value "outside original" -Encoding Ascii -NoNewline
        New-Item -ItemType Junction -Path (Join-Path $script:install "bin") -Target $script:outside | Out-Null
        { Install-ManagedDeviceFiles -PackagePath $script:pkg -InstallPrefix $script:install } | Should Throw
        (Get-Content -LiteralPath $target -Raw) | Should Be "outside original"
    }
    It "rejects a state junction before changing permissions or creating credentials" {
        $state = Join-Path $script:containRoot "state"
        New-Item -ItemType Junction -Path $state -Target $script:outside | Out-Null
        $before = (Get-Acl -LiteralPath $script:outside).Sddl
        { Install-DeviceIdentity -StateDir $state -DeviceId "RedirectedPC" } | Should Throw
        (Get-Acl -LiteralPath $script:outside).Sddl | Should Be $before
        Test-Path -LiteralPath (Join-Path $script:outside "device.credential") | Should Be $false
    }
}

Describe "managed write leaf containment" {
    BeforeEach {
        . (Join-Path $repo "scripts\setup-windows-device.ps1")
        . (Join-Path $repo "scripts\pair-windows-device.ps1")
        $script:leafRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-write-leaf-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $script:leafRoot | Out-Null
        $script:leafPackage = New-TestPackage $script:leafRoot
        $script:leafInstall = Join-Path $script:leafRoot "install"
        Install-ManagedDeviceFiles -PackagePath $script:leafPackage -InstallPrefix $script:leafInstall | Out-Null
        $script:leafState = Join-Path $script:leafRoot "state"
        $script:leafOutside = Join-Path $script:leafRoot "outside"
        New-Item -ItemType Directory -Path $script:leafState,$script:leafOutside | Out-Null
        Set-Content -LiteralPath (Join-Path $script:leafState "device.credential") -Value "test-only-device-credential" -Encoding Ascii -NoNewline
        $script:leafLinks = @()
        Mock Get-ScheduledTask { return $null }
        Mock Register-ScheduledTask { return $null }
        Mock Start-ScheduledTask { return $null }
    }
    AfterEach {
        if ($script:leafRoot) {
            $root = [IO.Path]::GetFullPath($script:leafRoot)
            $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\") + "\"
            if (-not $root.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or
                (Split-Path -Leaf $root) -notmatch "^tp-write-leaf-[a-f0-9]{32}$") {
                throw "refusing unsafe test cleanup"
            }
            foreach ($link in $script:leafLinks) {
                $resolved = [IO.Path]::GetFullPath($link)
                if (-not $resolved.StartsWith(($root + "\"), [StringComparison]::OrdinalIgnoreCase)) {
                    throw "refusing cleanup of a link outside the test workspace"
                }
                if (Test-Path -LiteralPath $resolved) {
                    if ((Get-Item -LiteralPath $resolved -Force).PSIsContainer) {
                        [IO.Directory]::Delete($resolved)
                    } else {
                        Remove-Item -LiteralPath $resolved -Force
                    }
                }
            }
            Remove-Item -LiteralPath $root -Recurse -Force
        }
    }

    It "rejects a redirected launch-arguments leaf without overwriting its target" {
        $target = Join-Path $script:leafOutside "agent-args.json"
        Set-Content -LiteralPath $target -Value "outside original" -Encoding Ascii -NoNewline
        $link = Join-Path $script:leafInstall "config\agent-args.json"
        New-Item -ItemType SymbolicLink -Path $link -Target $target | Out-Null
        $script:leafLinks += $link
        $message = ""
        try {
            Install-DeviceAgentTask -InstallPrefix $script:leafInstall -StateDir $script:leafState -DeviceId "LEAFTEST01" -RelayUrl "wss://example.invalid/device" | Out-Null
        } catch { $message = $_.Exception.Message }
        (Get-Content -LiteralPath $target -Raw) | Should Be "outside original"
        $message | Should Match "refusing redirected"
        Test-Path -LiteralPath (Join-Path $script:leafState "principal.json") | Should Be $false
    }

    It "rejects a redirected pairing-record leaf without overwriting its target" {
        $target = Join-Path $script:leafOutside "pairing.json"
        Set-Content -LiteralPath $target -Value "outside original" -Encoding Ascii -NoNewline
        $link = Join-Path $script:leafState "pairing.json"
        New-Item -ItemType SymbolicLink -Path $link -Target $target | Out-Null
        $script:leafLinks += $link
        $message = ""
        try {
            Write-PairingRecord -StateDir $script:leafState -DeviceId "LEAFTEST01" -UserCode "ABCD-1234" -ExpiresAt "2099-01-01T00:00:00Z"
        } catch { $message = $_.Exception.Message }
        (Get-Content -LiteralPath $target -Raw) | Should Be "outside original"
        $message | Should Match "refusing redirected"
    }

    It "rejects a redirected standalone pairing state without overwriting its target" {
        $target = Join-Path $script:leafOutside "pairing.json"
        Set-Content -LiteralPath $target -Value "outside original" -Encoding Ascii -NoNewline
        $link = Join-Path $script:leafRoot "pairing-state"
        New-Item -ItemType Junction -Path $link -Target $script:leafOutside | Out-Null
        $script:leafLinks += $link
        $message = ""
        try {
            Write-PairingRecord -StateDir $link -DeviceId "LEAFTEST01" -UserCode "ABCD-1234" -ExpiresAt "2099-01-01T00:00:00Z"
        } catch { $message = $_.Exception.Message }
        (Get-Content -LiteralPath $target -Raw) | Should Be "outside original"
        $message | Should Match "refusing redirected"
    }
}
