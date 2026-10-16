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
