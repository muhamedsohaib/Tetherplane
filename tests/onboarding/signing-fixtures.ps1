# Fixture-only Windows metadata. This never signs a file or installs a root.
function New-ValidSigningFixture {
    $usage = New-Object Security.Cryptography.OidCollection
    [void]$usage.Add((New-Object Security.Cryptography.Oid "1.3.6.1.5.5.7.3.3"))
    $extension = New-Object Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($usage, $false)
    return [pscustomobject]@{
        Status = "Valid"; SignatureType = "Authenticode"
        SignerCertificate = [pscustomobject]@{
            Subject = "CN=Tetherplane Test Publisher"
            Thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567"
            Extensions = @($extension)
        }
        TimeStamperCertificate = [pscustomobject]@{ Subject = "CN=Trusted Timestamp Fixture" }
    }
}

function New-SignedPackagingFixture {
    param([string]$Root, [string]$SourceRepository)
    if ($env:OS -ne "Windows_NT") { throw "signed packaging integration fixtures require native Windows SIP" }
    $checkout = Join-Path $Root "source"
    $payload = Join-Path $Root "signed-payload"
    $unsigned = Join-Path $Root "unsigned-payload"
    foreach ($relative in @("scripts", "packaging/windows", "docs/remote")) {
        New-Item -ItemType Directory -Path (Join-Path $checkout $relative) -Force | Out-Null
    }
    foreach ($name in @("setup-windows-device.ps1", "pair-windows-device.ps1", "doctor-tetherplane.ps1", "package-windows-device-kit.ps1", "new-windows-signing-request.ps1", "windows-signing-content.ps1")) {
        Copy-Item -LiteralPath (Join-Path $SourceRepository "scripts/$name") -Destination (Join-Path $checkout "scripts/$name")
    }
    Copy-Item -LiteralPath (Join-Path $SourceRepository "packaging/windows/tetherplane-agent.ps1") -Destination (Join-Path $checkout "packaging/windows/tetherplane-agent.ps1")
    Copy-Item -LiteralPath (Join-Path $SourceRepository "docs/remote/connection-profile.json") -Destination (Join-Path $checkout "docs/remote/connection-profile.json")
    & git -C $checkout init --quiet
    if ($LASTEXITCODE -ne 0) { throw "fixture git initialization failed" }
    & git -C $checkout config user.name "Tetherplane Test Fixture"
    & git -C $checkout config user.email "fixture@invalid.example"
    & git -C $checkout config core.autocrlf false
    & git -C $checkout add .
    & git -C $checkout -c commit.gpgsign=false commit --quiet -m "Isolated signing fixture"
    if ($LASTEXITCODE -ne 0) { throw "fixture git commit failed" }
    $revision = (& git -C $checkout rev-parse HEAD | Out-String).Trim()
    foreach ($relative in @("bin/tetherd.exe", "launch/tetherplane-agent.ps1", "setup-windows-device.ps1", "pair-windows-device.ps1", "doctor-tetherplane.ps1")) {
        $path = Join-Path $unsigned $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
        if ($relative -eq "bin/tetherd.exe") {
            # A real PE is needed for Windows SIP. The copy is never executed;
            # only the certificate-policy API is mocked in these tests.
            $source = (Get-Process -Id $PID).Path
        } elseif ($relative -eq "launch/tetherplane-agent.ps1") {
            $source = Join-Path $checkout "packaging/windows/tetherplane-agent.ps1"
        } else { $source = Join-Path $checkout "scripts/$relative" }
        Copy-Item -LiteralPath $source -Destination $path
    }
    Copy-Item -LiteralPath $unsigned -Destination $payload -Recurse
    $requestPath = Join-Path $Root "request.json"
    $request = & (Join-Path $checkout "scripts/new-windows-signing-request.ps1") -PayloadPath $unsigned -OutputPath $requestPath -SourceCommit $revision
    return [pscustomobject]@{
        Repository = $checkout
        Payload = $payload
        Unsigned = $unsigned
        Builder = Join-Path $checkout "scripts/package-windows-device-kit.ps1"
        Arguments = @{
            OutputPath = Join-Path $Root "kit"
            TetherdPath = Join-Path $payload "bin/tetherd.exe"
            SkipBuild = $true
            RequireTrustedSignature = $true
            ExpectedPublisherSubject = "CN=Tetherplane Test Publisher"
            ExpectedSignerThumbprint = "0123456789ABCDEF0123456789ABCDEF01234567"
            ExpectedSourceCommit = $revision
            SignedPayloadPath = $payload
            SigningRequestPath = $requestPath
            ExpectedSigningRequestSha256 = $request.request_sha256
            UnsignedPayloadPath = $unsigned
        }
    }
}
