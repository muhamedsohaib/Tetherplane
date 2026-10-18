$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
. (Join-Path $PSScriptRoot "helpers.ps1")
. (Join-Path $repo "scripts\setup-windows-device.ps1")

$script:approvedSubject = "CN=Tetherplane Test Publisher"
$script:approvedThumbprint = "0123456789ABCDEF0123456789ABCDEF01234567"
$script:approvedRevision = "1111111111111111111111111111111111111111"
$script:signedCodePaths = @("bin/tetherd.exe", "launch/tetherplane-agent.ps1", "setup-windows-device.ps1", "pair-windows-device.ps1", "doctor-tetherplane.ps1")

function New-EnforcementSignature {
    $usage = New-Object Security.Cryptography.OidCollection
    [void]$usage.Add((New-Object Security.Cryptography.Oid "1.3.6.1.5.5.7.3.3"))
    $extension = New-Object Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($usage, $false)
    return [pscustomobject]@{
        Status = "Valid"
        SignatureType = "Authenticode"
        SignerCertificate = [pscustomobject]@{
            Subject = "CN=Tetherplane Test Publisher"
            Thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567"
            Extensions = @($extension)
        }
        TimeStamperCertificate = [pscustomobject]@{ Subject = "CN=Trusted Timestamp" }
    }
}

function New-EnforcementPackage($Root) {
    $package = New-TestPackage $Root
    $manifestPath = Join-Path $package "manifest.json"
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest.source_commit = $script:approvedRevision
    $manifest | Add-Member -NotePropertyName source_tree_dirty -NotePropertyValue $false
    $manifest | Add-Member -NotePropertyName signature -NotePropertyValue ([pscustomobject]@{
        scheme = "authenticode-public-trust-v2"
        publisher_subject = $script:approvedSubject
        signer_thumbprint = $script:approvedThumbprint
        signed_files = $script:signedCodePaths
    })
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Write-TestSha256 $package
    return $package
}

function New-EnforcementZip($Package, $Root) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = Join-Path $Root "candidate.zip"
    [IO.Compression.ZipFile]::CreateFromDirectory($Package, $zip)
    $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    Set-Content -LiteralPath ($zip + ".sha256") -Value "$hash  candidate.zip" -Encoding Ascii
    return $zip
}

Describe "independent Windows signing policy" {
    BeforeEach {
        $script:enforcementRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-enforce-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $script:enforcementRoot | Out-Null
        $script:enforcementPackage = New-EnforcementPackage $script:enforcementRoot
        Mock Get-AuthenticodeSignature { New-EnforcementSignature }
    }
    AfterEach {
        Remove-Item -LiteralPath $script:enforcementRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    It "rejects metadata removal when the caller independently requires a publisher" {
        $manifestPath = Join-Path $script:enforcementPackage "manifest.json"
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $manifest.PSObject.Properties.Remove("signature")
        $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath
        Write-TestSha256 $script:enforcementPackage
        { Confirm-DevicePackage -PackagePath $script:enforcementPackage -ExpectedPublisherSubject $script:approvedSubject } | Should Throw "signing metadata"
    }

    It "rejects whitespace identity inputs instead of falling back to unsigned mode" {
        $manifestPath = Join-Path $script:enforcementPackage "manifest.json"
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $manifest.PSObject.Properties.Remove("signature")
        $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath
        Write-TestSha256 $script:enforcementPackage
        { Confirm-DevicePackage -PackagePath $script:enforcementPackage -ExpectedPublisherSubject " " } | Should Throw "signing metadata"
        { Confirm-DevicePackage -PackagePath $script:enforcementPackage -ExpectedSignerThumbprint " " } | Should Throw "signing metadata"
    }

    It "accepts an externally pinned package only after every code file verifies" {
        $result = Confirm-DevicePackage -PackagePath $script:enforcementPackage -RequireTrustedSignature -ExpectedPublisherSubject $script:approvedSubject -ExpectedSignerThumbprint $script:approvedThumbprint -ExpectedSourceCommit $script:approvedRevision
        $result.trusted_signature_verified | Should Be $true
        $result.source_commit | Should Be $script:approvedRevision
    }

    It "requires an independent certificate pin even when the manifest supplies one" {
        { Confirm-DevicePackage -PackagePath $script:enforcementPackage -ExpectedPublisherSubject $script:approvedSubject } | Should Throw "independently approved signer thumbprint"
    }

    It "rejects a code-signing certificate without the code-signing EKU" {
        Mock Get-AuthenticodeSignature {
            $signature = New-EnforcementSignature
            $signature.SignerCertificate.Extensions = @()
            $signature
        }
        { Assert-TrustedDeviceSignature -Path (Join-Path $script:enforcementPackage "bin\tetherd.exe") -ExpectedPublisherSubject $script:approvedSubject } | Should Throw "code-signing usage"
    }

    It "does not substitute the manifest certificate for the externally approved certificate" {
        { Confirm-DevicePackage -PackagePath $script:enforcementPackage -ExpectedPublisherSubject $script:approvedSubject -ExpectedSignerThumbprint "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } | Should Throw "independently approved signer thumbprint"
    }

    It "rejects all tampered or unsigned shipped PowerShell scripts despite recalculated hashes" {
        foreach ($relative in @("launch/tetherplane-agent.ps1", "setup-windows-device.ps1", "pair-windows-device.ps1", "doctor-tetherplane.ps1")) {
            $script:untrustedLeaf = [IO.Path]::GetFileName($relative)
            Mock Get-AuthenticodeSignature {
                param($LiteralPath)
                if ([IO.Path]::GetFileName($LiteralPath) -eq $script:untrustedLeaf) {
                    return [pscustomobject]@{ Status = "NotSigned"; SignatureType = "None"; SignerCertificate = $null; TimeStamperCertificate = $null }
                }
                New-EnforcementSignature
            }
            { Confirm-DevicePackage -PackagePath $script:enforcementPackage -ExpectedPublisherSubject $script:approvedSubject -ExpectedSignerThumbprint $script:approvedThumbprint } | Should Throw "Authenticode signature is not trusted"
        }
    }

    It "rejects an incomplete signed-file declaration" {
        $manifestPath = Join-Path $script:enforcementPackage "manifest.json"
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $manifest.signature.signed_files = @("bin/tetherd.exe")
        $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath
        Write-TestSha256 $script:enforcementPackage
        { Confirm-DevicePackage -PackagePath $script:enforcementPackage -ExpectedPublisherSubject $script:approvedSubject -ExpectedSignerThumbprint $script:approvedThumbprint } | Should Throw "signed-file declaration"
    }

    It "rejects a signed source revision that differs from the independently selected revision" {
        { Confirm-DevicePackage -PackagePath $script:enforcementPackage -ExpectedPublisherSubject $script:approvedSubject -ExpectedSignerThumbprint $script:approvedThumbprint -ExpectedSourceCommit "2222222222222222222222222222222222222222" } | Should Throw "source revision"
    }

    It "rejects dirty-source claims in a signed candidate" {
        $manifestPath = Join-Path $script:enforcementPackage "manifest.json"
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $manifest.source_tree_dirty = $true
        $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath
        Write-TestSha256 $script:enforcementPackage
        { Confirm-DevicePackage -PackagePath $script:enforcementPackage -ExpectedPublisherSubject $script:approvedSubject -ExpectedSignerThumbprint $script:approvedThumbprint } | Should Throw "clean source"
    }
}

Describe "trusted ZIP verification before package execution" {
    BeforeEach {
        $script:enforcementRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-ziptrust-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $script:enforcementRoot | Out-Null
        $script:enforcementPackage = New-EnforcementPackage $script:enforcementRoot
        $script:marker = Join-Path $script:enforcementRoot "untrusted-code-ran.txt"
        $script:zipVerifier = Join-Path $repo "scripts\verify-windows-device-kit.ps1"
    }
    AfterEach {
        Remove-Item -LiteralPath $script:enforcementRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Variable -Name TetherplaneZipRaceFixture -Scope Global -ErrorAction SilentlyContinue
    }

    It "never executes extracted setup code before checking trust" {
        # Existing verifier parameters deliberately exercise the recovered path.
        $statement = "[IO.File]::WriteAllText('" + $script:marker.Replace("'", "''") + "','executed')"
        Set-Content -LiteralPath (Join-Path $script:enforcementPackage "setup-windows-device.ps1") -Value $statement -Encoding UTF8
        Write-TestSha256 $script:enforcementPackage
        $zip = New-EnforcementZip $script:enforcementPackage $script:enforcementRoot
        $rejected = $false
        try { & $script:zipVerifier -ZipPath $zip -RequireTrustedSignature -ExpectedPublisherSubject $script:approvedSubject | Out-Null } catch { $rejected = $true }
        $rejected | Should Be $true
        (Test-Path -LiteralPath $script:marker) | Should Be $false
    }

    It "preserves caller pins and validates a signed ZIP without executing packaged code" {
        Mock Get-AuthenticodeSignature { New-EnforcementSignature }
        $statement = "[IO.File]::WriteAllText('" + $script:marker.Replace("'", "''") + "','executed')"
        Set-Content -LiteralPath (Join-Path $script:enforcementPackage "setup-windows-device.ps1") -Value $statement -Encoding UTF8
        Write-TestSha256 $script:enforcementPackage
        $zip = New-EnforcementZip $script:enforcementPackage $script:enforcementRoot
        $output = & $script:zipVerifier -ZipPath $zip -RequireTrustedSignature -ExpectedPublisherSubject $script:approvedSubject -ExpectedSignerThumbprint $script:approvedThumbprint -ExpectedSourceCommit $script:approvedRevision -VerifyOnly
        ($output | Out-String) | Should Match "TETHERPLANE_DEVICE_KIT_SIGNATURES_VERIFIED"
        (Test-Path -LiteralPath $script:marker) | Should Be $false
    }

    It "extracts only the archive whose independently approved digest was checked" {
        $script:approvedArchiveProfile = Get-Content -LiteralPath (Join-Path $script:enforcementPackage "connection-profile.json") -Raw
        $script:raceArchive = New-EnforcementZip $script:enforcementPackage $script:enforcementRoot
        $approvedArchiveHash = (Get-FileHash -LiteralPath $script:raceArchive -Algorithm SHA256).Hash
        Set-Content -LiteralPath (Join-Path $script:enforcementPackage "connection-profile.json") -Value '{"substituted_after_hash":true}' -Encoding Ascii -NoNewline
        Write-TestSha256 $script:enforcementPackage
        $script:replacementArchive = Join-Path $script:enforcementRoot "replacement.zip"
        [IO.Compression.ZipFile]::CreateFromDirectory($script:enforcementPackage, $script:replacementArchive)
        # Pester 3 and 4 run mocks called by another script in that script's
        # scope. Keep the injected boundary state in one cleaned-up fixture.
        $global:TetherplaneZipRaceFixture = @{
            hash_command = Get-Command Get-FileHash -CommandType Cmdlet
            archive_path = $script:raceArchive
            replacement_path = $script:replacementArchive
            mutation_attempted = $false
            observed_profile = ""
        }
        Mock Get-FileHash {
            $fixture = $global:TetherplaneZipRaceFixture
            if ($null -ne $InputStream) {
                $digest = & $fixture.hash_command -InputStream $InputStream -Algorithm $Algorithm
            } else {
                $digest = & $fixture.hash_command -LiteralPath $LiteralPath -Algorithm $Algorithm
            }
            if (-not $fixture.mutation_attempted -and ($null -ne $InputStream -or $LiteralPath -eq $fixture.archive_path)) {
                $fixture.mutation_attempted = $true
                # Windows must deny replacement while its read handle is held.
                # On Unix, replacement changes the path's inode; retaining the
                # exact stream must still extract the approved original bytes.
                try { [IO.File]::Replace($fixture.replacement_path, $fixture.archive_path, [NullString]::Value) }
                catch [IO.IOException] { }
            }
            return $digest
        }
        Mock Get-AuthenticodeSignature {
            param($LiteralPath)
            if ([IO.Path]::GetFileName($LiteralPath) -eq "setup-windows-device.ps1") {
                $global:TetherplaneZipRaceFixture.observed_profile = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $LiteralPath) "connection-profile.json") -Raw
            }
            New-EnforcementSignature
        }
        $output = & $script:zipVerifier -ZipPath $script:raceArchive -ExpectedZipSha256 $approvedArchiveHash -RequireTrustedSignature -ExpectedPublisherSubject $script:approvedSubject -ExpectedSignerThumbprint $script:approvedThumbprint -ExpectedSourceCommit $script:approvedRevision -VerifyOnly
        $global:TetherplaneZipRaceFixture.mutation_attempted | Should Be $true
        $global:TetherplaneZipRaceFixture.observed_profile | Should Be $script:approvedArchiveProfile
        ($output | Out-String) | Should Match ("sha256=" + $approvedArchiveHash.ToLowerInvariant())
        (Test-Path -LiteralPath $script:marker) | Should Be $false
    }
}

Describe "SignTool release verification" {
    BeforeEach {
        $script:enforcementRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-signtool-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $script:enforcementRoot | Out-Null
        $script:artifact = Join-Path $script:enforcementRoot "agent with spaces.exe"
        Set-Content -LiteralPath $script:artifact -Value "fake-agent"
        $script:tool = Join-Path $script:enforcementRoot "verifier.ps1"
        Mock Get-AuthenticodeSignature { New-EnforcementSignature }
    }
    AfterEach { Remove-Item -LiteralPath $script:enforcementRoot -Recurse -Force -ErrorAction SilentlyContinue }

    It "passes the Authenticode, all-signatures and timestamp flags as literal arguments" {
        Set-Content -LiteralPath $script:tool -Value 'if ($args.Count -ne 5 -or $args[0] -cne "verify" -or $args[1] -cne "/pa" -or $args[2] -cne "/all" -or $args[3] -cne "/tw" -or -not (Test-Path -LiteralPath $args[4])) { exit 7 }; exit 0' -Encoding UTF8
        $result = Assert-TrustedDeviceSignature -Path $script:artifact -ExpectedPublisherSubject $script:approvedSubject -ExpectedSignerThumbprint $script:approvedThumbprint -SignToolPath $script:tool
        $result.signer_thumbprint | Should Be $script:approvedThumbprint
    }

    It "rejects a SignTool warning even if the structured signature reports Valid" {
        Set-Content -LiteralPath $script:tool -Value 'exit 2' -Encoding Ascii
        { Assert-TrustedDeviceSignature -Path $script:artifact -ExpectedPublisherSubject $script:approvedSubject -SignToolPath $script:tool } | Should Throw "SignTool verification failed"
    }
}
