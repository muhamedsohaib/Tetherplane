$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
. (Join-Path $PSScriptRoot "helpers.ps1")
. (Join-Path $PSScriptRoot "signing-fixtures.ps1")
. (Join-Path $repo "scripts\setup-windows-device.ps1")

function New-SigningTestRoot {
    $root = Join-Path ([IO.Path]::GetTempPath()) ("tp-signature-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    return $root
}

function New-FakeAgentBinary($root) {
    $path = Join-Path $root "tetherd.exe"
    Set-Content -LiteralPath $path -Value "not-real-windows-executable" -Encoding Ascii -NoNewline
    return $path
}

Describe "publicly trusted Authenticode gate" {
    BeforeEach {
        $script:root = New-SigningTestRoot
        $script:exe = New-FakeAgentBinary $script:root
    }
    AfterEach {
        if ($script:root) {
            Remove-Item -LiteralPath $script:root -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "exposes an explicit verifier and records a validated publisher" {
        (Get-Command Assert-TrustedDeviceSignature -ErrorAction Stop).Name | Should Be "Assert-TrustedDeviceSignature"
        Mock Get-AuthenticodeSignature { New-ValidSigningFixture }
        $verified = Assert-TrustedDeviceSignature -Path $script:exe -ExpectedPublisherSubject "CN=Tetherplane Test Publisher"
        $verified.signer_subject | Should Be "CN=Tetherplane Test Publisher"
        $verified.signer_thumbprint | Should Be "0123456789ABCDEF0123456789ABCDEF01234567"
    }

    It "rejects an unsigned agent despite a SHA-256 hash" {
        Mock Get-AuthenticodeSignature {
            [pscustomobject]@{ Status = "NotSigned"; SignatureType = "None"; SignerCertificate = $null; TimeStamperCertificate = $null }
        }
        { Assert-TrustedDeviceSignature -Path $script:exe -ExpectedPublisherSubject "CN=Tetherplane Test Publisher" } | Should Throw "Authenticode signature is not trusted"
    }

    It "rejects a mismatched publisher" {
        Mock Get-AuthenticodeSignature {
            [pscustomobject]@{
                Status = "Valid"; SignatureType = "Authenticode"
                SignerCertificate = [pscustomobject]@{ Subject = "CN=Unknown Publisher"; Thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567" }
                TimeStamperCertificate = [pscustomobject]@{ Subject = "CN=Time Stamping CA" }
            }
        }
        { Assert-TrustedDeviceSignature -Path $script:exe -ExpectedPublisherSubject "CN=Tetherplane Test Publisher" } | Should Throw "publisher does not match"
    }

    It "rejects a missing timestamp or a catalog-only signature" {
        Mock Get-AuthenticodeSignature {
            [pscustomobject]@{
                Status = "Valid"; SignatureType = "Authenticode"
                SignerCertificate = [pscustomobject]@{ Subject = "CN=Tetherplane Test Publisher"; Thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567" }
                TimeStamperCertificate = $null
            }
        }
        { Assert-TrustedDeviceSignature -Path $script:exe -ExpectedPublisherSubject "CN=Tetherplane Test Publisher" } | Should Throw "missing a verified timestamp"
        Mock Get-AuthenticodeSignature {
            [pscustomobject]@{
                Status = "Valid"; SignatureType = "Catalog"
                SignerCertificate = [pscustomobject]@{ Subject = "CN=Tetherplane Test Publisher"; Thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567" }
                TimeStamperCertificate = [pscustomobject]@{ Subject = "CN=Time Stamping CA" }
            }
        }
        { Assert-TrustedDeviceSignature -Path $script:exe -ExpectedPublisherSubject "CN=Tetherplane Test Publisher" } | Should Throw "embedded Authenticode signature"
    }

    It "refuses a signed-distribution build with an unsigned source and never creates an output directory" -Skip:($env:OS -ne "Windows_NT") {
        $fixture = New-SignedPackagingFixture -Root $script:root -SourceRepository $repo
        $arguments = $fixture.Arguments
        Mock Get-AuthenticodeSignature { [pscustomobject]@{ Status = "NotSigned" } }
        { & $fixture.Builder @arguments | Out-Null } | Should Throw "Authenticode signature is not trusted"
        (Test-Path -LiteralPath $arguments.OutputPath) | Should Be $false
    }

    It "builds signed-only kit metadata when the verifier passes" -Skip:($env:OS -ne "Windows_NT") {
        $fixture = New-SignedPackagingFixture -Root $script:root -SourceRepository $repo
        $arguments = $fixture.Arguments
        $kit = $arguments.OutputPath
        Mock Get-AuthenticodeSignature { New-ValidSigningFixture }
        & $fixture.Builder @arguments | Out-Null
        $manifest = Get-Content -LiteralPath (Join-Path $kit "manifest.json") -Raw | ConvertFrom-Json
        $manifest.signature.scheme | Should Be "authenticode-public-trust-v2"
        $manifest.signature.publisher_subject | Should Be "CN=Tetherplane Test Publisher"
        (Confirm-DevicePackage -PackagePath $kit -ExpectedPublisherSubject "CN=Tetherplane Test Publisher" -ExpectedSignerThumbprint $arguments.ExpectedSignerThumbprint -ExpectedSourceCommit $arguments.ExpectedSourceCommit).ok | Should Be $true
    }

    It "rejects a forged signed manifest even when all SHA-256 entries match" {
        # Explicitly reset the signature mock; Pester 3 mocks can survive dot-sourcing.
        Mock Get-AuthenticodeSignature {
            [pscustomobject]@{ Status = "NotSigned"; SignatureType = "None"; SignerCertificate = $null; TimeStamperCertificate = $null }
        }
        $kit = New-TestPackage $script:root
        $manifestPath = Join-Path $kit "manifest.json"
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $manifest.source_commit = "1111111111111111111111111111111111111111"
        $manifest | Add-Member -NotePropertyName source_tree_dirty -NotePropertyValue $false
        $manifest | Add-Member -NotePropertyName signature -NotePropertyValue ([pscustomobject]@{
            scheme = "authenticode-public-trust-v2"
            publisher_subject = "CN=Tetherplane Test Publisher"
            signer_thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567"
            signed_files = @("bin/tetherd.exe", "launch/tetherplane-agent.ps1", "setup-windows-device.ps1", "pair-windows-device.ps1", "doctor-tetherplane.ps1")
        })
        $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath
        Write-TestSha256 $kit
        { Confirm-DevicePackage -PackagePath $kit -ExpectedPublisherSubject "CN=Tetherplane Test Publisher" -ExpectedSignerThumbprint "0123456789ABCDEF0123456789ABCDEF01234567" } | Should Throw "Authenticode signature is not trusted"
    }

    It "requires an independently supplied publisher when a kit claims to be signed" {
        Mock Get-AuthenticodeSignature {
            [pscustomobject]@{
                Status = "Valid"; SignatureType = "Authenticode"
                SignerCertificate = [pscustomobject]@{ Subject = "CN=Different CA Publisher"; Thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567" }
                TimeStamperCertificate = [pscustomobject]@{ Subject = "CN=Time Stamping CA" }
            }
        }
        $kit = New-TestPackage $script:root
        $manifestPath = Join-Path $kit "manifest.json"
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $manifest | Add-Member -NotePropertyName signature -NotePropertyValue ([pscustomobject]@{
            scheme = "authenticode-public-trust-v2"
            publisher_subject = "CN=Different CA Publisher"
            signer_thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567"
        })
        $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath
        Write-TestSha256 $kit
        { Confirm-DevicePackage -PackagePath $kit } | Should Throw "independently confirmed -ExpectedPublisherSubject"
        { Confirm-DevicePackage -PackagePath $kit -ExpectedPublisherSubject "CN=Tetherplane Test Publisher" -ExpectedSignerThumbprint "0123456789ABCDEF0123456789ABCDEF01234567" } | Should Throw "publisher differs"
    }

    It "does not promote an unsigned private development kit to a signed release" {
        $kit = Join-Path $script:root "kit"
        & (Join-Path $repo "scripts\package-windows-device-kit.ps1") -OutputPath $kit -SkipBuild -TetherdPath $script:exe | Out-Null
        $manifest = Get-Content -LiteralPath (Join-Path $kit "manifest.json") -Raw | ConvertFrom-Json
        ($null -eq $manifest.PSObject.Properties["signature"]) | Should Be $true
    }
}
