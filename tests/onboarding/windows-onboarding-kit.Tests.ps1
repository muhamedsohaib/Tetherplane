$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
. (Join-Path $PSScriptRoot "helpers.ps1")

function New-FakeTetherd($dir) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $path = Join-Path $dir "tetherd.exe"
    Set-Content -LiteralPath $path -Value "fake-agent-binary-for-kit-tests" -Encoding Ascii -NoNewline
    return $path
}

function Build-TestKit($tempRoot, [switch]$Zip) {
    $fake = New-FakeTetherd (Join-Path $tempRoot "fake")
    $kit = Join-Path $tempRoot "kit"
    $builder = Join-Path $repo "scripts\package-windows-device-kit.ps1"
    if ($Zip) {
        & $builder -OutputPath $kit -SkipBuild -TetherdPath $fake -Zip | Out-Null
    } else {
        & $builder -OutputPath $kit -SkipBuild -TetherdPath $fake | Out-Null
    }
    return $kit
}

Describe "device kit builder" {
    BeforeEach {
        $script:tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-kit-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $script:tempRoot | Out-Null
    }
    AfterEach {
        if ($script:tempRoot) { Remove-Item -LiteralPath $script:tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "builds an agent-only kit that verifies and needs no source-build tooling" {
        $kit = Build-TestKit $script:tempRoot
        . (Join-Path $kit "setup-windows-device.ps1")
        $verified = Confirm-DevicePackage -PackagePath $kit
        $verified.ok | Should Be $true
        $verified.source_commit | Should Match "^[0-9a-f]{40}$"
        $manifest = Get-Content -LiteralPath (Join-Path $kit "manifest.json") -Raw | ConvertFrom-Json
        $manifest.node_runtime_required | Should Be $false
        $manifest.kit | Should Be "device-agent"
        foreach ($forbidden in @("adapters", "relay", "node_modules", "protocol")) {
            Test-Path -LiteralPath (Join-Path $kit $forbidden) | Should Be $false
        }
        foreach ($required in @("bin\tetherd.exe", "launch\tetherplane-agent.ps1", "setup-windows-device.ps1", "pair-windows-device.ps1", "doctor-tetherplane.ps1", "connection-profile.json", "setup.cmd", "README.txt")) {
            Test-Path -LiteralPath (Join-Path $kit $required) | Should Be $true
        }
    }

    It "records every shipped file in the hash manifest and detects tampering" {
        $kit = Build-TestKit $script:tempRoot
        . (Join-Path $kit "setup-windows-device.ps1")
        $listed = @(Get-Content -LiteralPath (Join-Path $kit "manifest.sha256") | Where-Object { $_.Trim() } | ForEach-Object { ($_ -split "\s+", 2)[1] })
        $shipped = @(Get-ChildItem -LiteralPath $kit -Recurse -File | Where-Object { $_.Name -ne "manifest.sha256" } | ForEach-Object {
            $_.FullName.Substring($kit.Length + 1).Replace("\", "/")
        })
        $missing = @($shipped | Where-Object { $listed -notcontains $_ })
        $missing.Count | Should Be 0
        Add-Content -LiteralPath (Join-Path $kit "launch\tetherplane-agent.ps1") -Value "# tampered" -Encoding Ascii
        { Confirm-DevicePackage -PackagePath $kit } | Should Throw
    }

    It "produces a zip whose SHA-256 file matches its content" {
        $kit = Build-TestKit $script:tempRoot -Zip
        $zip = $kit + ".zip"
        $sha = $zip + ".sha256"
        Test-Path -LiteralPath $zip | Should Be $true
        Test-Path -LiteralPath $sha | Should Be $true
        $recorded = ((Get-Content -LiteralPath $sha -Raw).Trim() -split "\s+")[0].ToLowerInvariant()
        $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
        $recorded | Should Be $actual
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [IO.Compression.ZipFile]::OpenRead($zip)
        try {
            $names = @($archive.Entries | ForEach-Object { $_.FullName })
            ($names -contains "setup-windows-device.ps1") | Should Be $true
            ($names -contains "bin/tetherd.exe") | Should Be $true
            @($names | Where-Object { $_ -like "*\*" }).Count | Should Be 0
        } finally {
            $archive.Dispose()
        }
    }

    It "runs setup straight from the unpacked kit without -Run or -PackagePath" {
        $kit = Build-TestKit $script:tempRoot
        $install = Join-Path $script:tempRoot "install"
        $state = Join-Path $script:tempRoot "state"
        $result = & (Join-Path $kit "setup-windows-device.ps1") -DeviceId "KITPC01" -InstallPrefix $install -StateDir $state | ConvertFrom-Json
        $result.ok | Should Be $true
        $result.identity.device_id | Should Be "KITPC01"
        Test-Path -LiteralPath (Join-Path $install "bin\tetherd.exe") | Should Be $true
        Test-Path -LiteralPath (Join-Path $state "device.credential") | Should Be $true
        (Get-Content -LiteralPath (Join-Path $install "config\install.json") -Raw | ConvertFrom-Json).managed_by | Should Be "setup-windows-device.ps1"
    }
}


Describe "rebuilding a device kit does not delete unrelated or modified files" {
    BeforeEach {
        $script:tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-rebuild-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $script:tempRoot | Out-Null
        $script:kit = Build-TestKit $script:tempRoot
        $script:builder = Join-Path $repo "scripts\package-windows-device-kit.ps1"
        $script:fake = Join-Path $script:tempRoot "fake\tetherd.exe"
    }
    AfterEach {
        if ($script:tempRoot) { Remove-Item -LiteralPath $script:tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "refuses to remove an unknown user file from a previous kit directory" {
        $unknown = Join-Path $script:kit "private-notes.txt"
        Set-Content -LiteralPath $unknown -Value "do-not-delete" -Encoding Ascii
        { & $script:builder -OutputPath $script:kit -SkipBuild -TetherdPath $script:fake } | Should Throw
        (Get-Content -LiteralPath $unknown -Raw).Trim() | Should Be "do-not-delete"
        Test-Path -LiteralPath (Join-Path $script:kit "bin\tetherd.exe") | Should Be $true
    }

    It "refuses to delete a previous kit whose managed file was modified" {
        $managed = Join-Path $script:kit "launch\tetherplane-agent.ps1"
        Add-Content -LiteralPath $managed -Value "local edit" -Encoding Ascii
        { & $script:builder -OutputPath $script:kit -SkipBuild -TetherdPath $script:fake } | Should Throw
        (Get-Content -LiteralPath $managed -Raw) | Should Match "local edit"
    }

    It "permits rebuilding an unchanged, verified prior kit" {
        & $script:builder -OutputPath $script:kit -SkipBuild -TetherdPath $script:fake | Out-Null
        . (Join-Path $script:kit "setup-windows-device.ps1")
        (Confirm-DevicePackage -PackagePath $script:kit).ok | Should Be $true
    }
}
