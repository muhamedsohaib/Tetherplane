$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

. (Join-Path $PSScriptRoot "helpers.ps1")

Describe "connection profile" {
    It "parses and carries only non-secret public endpoints" {
        $profilePath = Join-Path $repo "docs\remote\connection-profile.json"
        $profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
        $profile.profile_version | Should Not BeNullOrEmpty
        $profile.mcp_url | Should Match "^https://"
        $profile.oidc_issuer | Should Match "^https://"
        $profile.mcp_resource | Should Be $profile.mcp_url
        $profile.scopes -contains "tetherplane:access" | Should Be $true
        @($profile.native_connection.oauth_public_client_ids).Count | Should Be 2
        $profile.device_transport.relay_url | Should Be "wss://vaulter.tailf65eba.ts.net:10000/device"
        $profile.chatgpt_use.reuse_connection | Should Be $true
        $raw = Get-Content -LiteralPath $profilePath -Raw
        $raw | Should Not Match "client_secret"
    }
}

Describe "setup-windows-device" {
    BeforeEach {
        . (Join-Path $repo "scripts\setup-windows-device.ps1")
        $script:tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-onboard-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $script:tempRoot | Out-Null
        $script:pkg = New-TestPackage $script:tempRoot
        $script:state = Join-Path $script:tempRoot "state"
    }
    AfterEach {
        if ($script:tempRoot) { Remove-Item -LiteralPath $script:tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "rejects a package with a missing manifest" {
        Remove-Item -LiteralPath (Join-Path $script:pkg "manifest.json")
        { Confirm-DevicePackage -PackagePath $script:pkg } | Should Throw
    }

    It "rejects a package with a missing agent binary" {
        Remove-Item -LiteralPath (Join-Path $script:pkg "bin\tetherd.exe")
        { Confirm-DevicePackage -PackagePath $script:pkg } | Should Throw
    }

    It "rejects an architecture mismatch" {
        $manifest = Get-Content -LiteralPath (Join-Path $script:pkg "manifest.json") -Raw | ConvertFrom-Json
        $manifest.architecture = "arm64"
        $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $script:pkg "manifest.json") -Encoding UTF8
        { Confirm-DevicePackage -PackagePath $script:pkg } | Should Throw
    }

    It "creates a restricted credential and stable device ID on first setup" {
        $result = Install-DeviceIdentity -StateDir $script:state -DeviceId "TESTPC01"
        $credentialPath = Join-Path $script:state "device.credential"
        Test-Path -LiteralPath $credentialPath | Should Be $true
        $credential = (Get-Content -LiteralPath $credentialPath -Raw).Trim()
        $credential.Length | Should BeGreaterThan 15
        (Get-Content -LiteralPath (Join-Path $script:state "device-id.txt") -Raw).Trim() | Should Be "TESTPC01"
        $acl = Get-Acl -LiteralPath $credentialPath
        $others = @($acl.Access | Where-Object { $_.IdentityReference -notmatch "SYSTEM|Administrators|$env:USERNAME" })
        $others.Count | Should Be 0
        ($result | Out-String) | Should Not Match ([regex]::Escape($credential))
    }

    It "preserves credential and device ID on rerun" {
        Install-DeviceIdentity -StateDir $script:state -DeviceId "TESTPC01" | Out-Null
        $before = (Get-Content -LiteralPath (Join-Path $script:state "device.credential") -Raw).Trim()
        Install-DeviceIdentity -StateDir $script:state -DeviceId "TESTPC01" | Out-Null
        (Get-Content -LiteralPath (Join-Path $script:state "device.credential") -Raw).Trim() | Should Be $before
    }

    It "stops on conflicting identity with an actionable error" {
        Install-DeviceIdentity -StateDir $script:state -DeviceId "TESTPC01" | Out-Null
        { Install-DeviceIdentity -StateDir $script:state -DeviceId "OTHERPC" } | Should Throw
    }
}

Describe "pair-windows-device against a loopback mock relay" {
    BeforeEach {
        . (Join-Path $repo "scripts\pair-windows-device.ps1")
        $script:tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-pair-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $script:tempRoot | Out-Null
        $script:mock = Start-MockRelay $script:tempRoot
    }
    AfterEach {
        Stop-MockRelay $script:mock
        if ($script:tempRoot) { Remove-Item -LiteralPath $script:tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "posts only the credential hash and shows the approval code" {
        $credential = "TEST-CREDENTIAL-ABCDEFGHIJKLMNOP"
        $result = Request-DevicePairing -RelayUrl $script:mock.Url -DeviceId "TESTPC01" -Credential $credential
        $result.userCode | Should Match "^[0-9A-F]{4}-[0-9A-F]{4}$"
        $result.expiresAt | Should Not BeNullOrEmpty
        $logged = Get-Content -LiteralPath (Join-Path $script:tempRoot "requests.log") -Raw
        $logged | Should Match (Test-CredentialHash $credential)
        $logged | Should Match "TESTPC01"
        $logged | Should Not Match ([regex]::Escape($credential))
    }

    It "reports an expired code with an exact diagnostic" {
        Set-Content -LiteralPath (Join-Path $script:tempRoot "mode.txt") -Value "expired" -Encoding Ascii
        $thrown = $false
        try { Request-DevicePairing -RelayUrl $script:mock.Url -DeviceId "TESTPC01" -Credential "TEST-CREDENTIAL-ABCDEFGHIJKLMNOP" | Out-Null } catch { $thrown = $_.Exception.Message }
        $thrown | Should Match "(?i)expir"
    }

    It "reports an already-paired device with the repair path" {
        Set-Content -LiteralPath (Join-Path $script:tempRoot "mode.txt") -Value "paired" -Encoding Ascii
        $thrown = $false
        try { Request-DevicePairing -RelayUrl $script:mock.Url -DeviceId "TESTPC01" -Credential "TEST-CREDENTIAL-ABCDEFGHIJKLMNOP" | Out-Null } catch { $thrown = $_.Exception.Message }
        $thrown | Should Match "(?i)already paired"
    }
}

Describe "doctor-tetherplane" {
    BeforeEach {
        . (Join-Path $repo "scripts\doctor-tetherplane.ps1")
        $script:tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-doc-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $script:tempRoot | Out-Null
    }
    AfterEach {
        if ($script:tempRoot) { Remove-Item -LiteralPath $script:tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "fails a missing install with the install action" {
        $result = Test-DeviceInstall -InstallPrefix (Join-Path ([IO.Path]::GetTempPath()) ("tp-missing-" + [Guid]::NewGuid().ToString("N")))
        $result.ok | Should Be $false
        $result.next | Should Match "(?i)install"
    }

    It "skips bearer-gated checks cleanly without a bearer file" {
        $result = Test-AccountPairing -RelayUrl "http://127.0.0.1:9" -BearerTokenFile ""
        $result.ok | Should Be $false
        $result.skipped | Should Be $true
        $result.next | Should Match "(?i)owner|bearer|approv"
    }

    It "validates pairing through the authenticated plane without exposing the bearer" {
        $tokenPath = Join-Path $script:tempRoot "bearer.txt"
        Set-Content -LiteralPath $tokenPath -Value "owner-token" -Encoding Ascii -NoNewline
        $script:mock = Start-MockRelay $script:tempRoot
        try {
            $result = Test-AccountPairing -RelayUrl $script:mock.Url -BearerTokenFile $tokenPath
            $result.ok | Should Be $true
            ($result | Out-String) | Should Not Match "owner-token"
        } finally {
            Stop-MockRelay $script:mock
        }
    }

    It "correlates the managed agent PID with its relay connection" {
        $procs = @([pscustomobject]@{ Id = 4242 })
        $conns = @([pscustomobject]@{ OwningProcess = 4242; RemoteAddress = "10.9.8.7"; RemotePort = 10000 })
        $result = Test-DeviceOnline -InstallPrefix "C:\Tether" -RelayHost "10.9.8.7" -RelayPort 10000 -ProcessList $procs -ConnectionList $conns
        $result.ok | Should Be $true
        $result.transport | Should Be "tcp-established"
        $result.remote_functional | Should Be "unverified"
        $bad = Test-DeviceOnline -InstallPrefix "C:\Tether" -RelayHost "10.9.8.7" -RelayPort 9999 -ProcessList $procs -ConnectionList $conns
        $bad.ok | Should Be $false
    }

    It "never reports an untested optional check as passing" {
        $browser = Test-BrowserProvider
        $browser.ok | Should Be $false
        $browser.skipped | Should Be $true
        $browser.next | Should Match "(?i)optional|unverified"
    }

    It "derives the relay endpoint from the connection profile" {
        $endpoint = Get-RelayEndpoint -ProfilePath (Join-Path $repo "docs\remote\connection-profile.json")
        $endpoint.host | Should Be "vaulter.tailf65eba.ts.net"
        $endpoint.port | Should Be 10000
        $endpoint.pairing_origin | Should Match "^https://vaulter\.tailf65eba\.ts\.net$"
    }

    It "reports the relay transport reachable when the endpoint accepts a connection" {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
        $listener.Start()
        try {
            $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
            $result = Test-RelayTransport -RelayHost "127.0.0.1" -RelayPort $port -TimeoutMs 3000
            $result.ok | Should Be $true
        } finally {
            $listener.Stop()
        }
    }

    It "tells the user to join the tailnet when the relay port is unreachable" {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
        $listener.Stop()
        $result = Test-RelayTransport -RelayHost "127.0.0.1" -RelayPort $port -TimeoutMs 1500
        $result.ok | Should Be $false
        $result.next | Should Match "(?i)tailnet|tailscale"
    }

    It "resolves launch-bound policy from agent args" {
        $prefix = Join-Path $script:tempRoot "prefix"
        New-Item -ItemType Directory -Force -Path (Join-Path $prefix "config") | Out-Null
        $principal = Join-Path $script:tempRoot "principal.json"
        Set-Content -LiteralPath $principal -Value '{"principal_id":"human:owner"}' -Encoding Ascii
        @("--relay-url", "wss://x/device", "--principal-profile", $principal) | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $prefix "config\agent-args.json") -Encoding UTF8
        (Test-LocalPolicy -InstallPrefix $prefix).ok | Should Be $true
        (Test-LocalPolicy -InstallPrefix (Join-Path $script:tempRoot "nope")).ok | Should Be $false
    }
}
