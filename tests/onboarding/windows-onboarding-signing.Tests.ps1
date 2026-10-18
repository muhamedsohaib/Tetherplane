$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
. (Join-Path $PSScriptRoot "helpers.ps1")
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
        Mock Get-AuthenticodeSignature {
            [pscustomobject]@{
                Status = "Valid"
                SignatureType = "Authenticode"
                SignerCertificate = [pscustomobject]@{
                    Subject = "CN=Tetherplane Test Publisher"
                    Thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567"
                }
                TimeStamperCertificate = [pscustomobject]@{ Subject = "CN=Time Stamping CA" }
            }
        }
        $verified = Assert-TrustedDeviceSignature -Path $script:exe -ExpectedPublisherSubject "CN=Tetherplane Test Publisher"
        $verified.signer_subject | Should Be "CN=Tetherplane Test Publisher"
        $verified.signer_thumbprint | Should Be "0123456789ABCDEF0123456789ABCDEF01234567"
    }

    It "rejects an unsigned agent despite a SHA-256 hash" {
        Mock Get-AuthenticodeSignature {
            [pscustomobject]@{ Status = "NotSigned"; SignatureType = "None"; SignerCertificate = $null; TimeStamperCertificate = $null }
        }
        { Assert-TrustedDeviceSignature -Path $script:exe -ExpectedPublisherSubject "CN=Tetherplane Test Publisher" } | Should Throw
    }

    It "rejects a mismatched publisher" {
        Mock Get-AuthenticodeSignature {
            [pscustomobject]@{
                Status = "Valid"; SignatureType = "Authenticode"
                SignerCertificate = [pscustomobject]@{ Subject = "CN=Unknown Publisher"; Thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567" }
                TimeStamperCertificate = [pscustomobject]@{ Subject = "CN=Time Stamping CA" }
            }
        }
        { Assert-TrustedDeviceSignature -Path $script:exe -ExpectedPublisherSubject "CN=Tetherplane Test Publisher" } | Should Throw
    }

    It "rejects a missing timestamp or a catalog-only signature" {
        Mock Get-AuthenticodeSignature {
            [pscustomobject]@{
                Status = "Valid"; SignatureType = "Authenticode"
                SignerCertificate = [pscustomobject]@{ Subject = "CN=Tetherplane Test Publisher"; Thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567" }
                TimeStamperCertificate = $null
            }
        }
        { Assert-TrustedDeviceSignature -Path $script:exe -ExpectedPublisherSubject "CN=Tetherplane Test Publisher" } | Should Throw
        Mock Get-AuthenticodeSignature {
            [pscustomobject]@{
                Status = "Valid"; SignatureType = "Catalog"
                SignerCertificate = [pscustomobject]@{ Subject = "CN=Tetherplane Test Publisher"; Thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567" }
                TimeStamperCertificate = [pscustomobject]@{ Subject = "CN=Time Stamping CA" }
            }
        }
        { Assert-TrustedDeviceSignature -Path $script:exe -ExpectedPublisherSubject "CN=Tetherplane Test Publisher" } | Should Throw
    }

    It "refuses a signed-distribution build with an unsigned source and never creates an output directory" {
        $kit = Join-Path $script:root "kit"
        $builder = Join-Path $repo "scripts\package-windows-device-kit.ps1"
        { & $builder -OutputPath $kit -SkipBuild -TetherdPath $script:exe -RequireTrustedSignature -ExpectedPublisherSubject "CN=Tetherplane Test Publisher" | Out-Null } | Should Throw
        (Test-Path -LiteralPath $kit) | Should Be $false
    }

    It "builds signed-only kit metadata when the verifier passes" {
        $kit = Join-Path $script:root "kit"
        $builder = Join-Path $repo "scripts\package-windows-device-kit.ps1"
        Mock Get-AuthenticodeSignature {
            [pscustomobject]@{
                Status = "Valid"; SignatureType = "Authenticode"
                SignerCertificate = [pscustomobject]@{ Subject = "CN=Tetherplane Test Publisher"; Thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567" }
                TimeStamperCertificate = [pscustomobject]@{ Subject = "CN=Time Stamping CA" }
            }
        }
        & $builder -OutputPath $kit -SkipBuild -TetherdPath $script:exe -RequireTrustedSignature -ExpectedPublisherSubject "CN=Tetherplane Test Publisher" | Out-Null
        $manifest = Get-Content -LiteralPath (Join-Path $kit "manifest.json") -Raw | ConvertFrom-Json
        $manifest.signature.scheme | Should Be "authenticode-public-trust-v1"
        $manifest.signature.publisher_subject | Should Be "CN=Tetherplane Test Publisher"
        (Confirm-DevicePackage -PackagePath $kit).ok | Should Be $true
    }

    It "rejects a forged signed manifest even when all SHA-256 entries match" {
        # Explicitly reset the signature mock; Pester 3 mocks can survive dot-sourcing.
        Mock Get-AuthenticodeSignature {
            [pscustomobject]@{ Status = "NotSigned"; SignatureType = "None"; SignerCertificate = $null; TimeStamperCertificate = $null }
        }
        $kit = New-TestPackage $script:root
        $manifestPath = Join-Path $kit "manifest.json"
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $manifest | Add-Member -NotePropertyName signature -NotePropertyValue ([pscustomobject]@{
            scheme = "authenticode-public-trust-v1"
            publisher_subject = "CN=Tetherplane Test Publisher"
            signer_thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567"
        })
        $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath
        Write-TestSha256 $kit
        { Confirm-DevicePackage -PackagePath $kit } | Should Throw
    }

    It "does not promote an unsigned private development kit to a signed release" {
        $kit = Join-Path $script:root "kit"
        & (Join-Path $repo "scripts\package-windows-device-kit.ps1") -OutputPath $kit -SkipBuild -TetherdPath $script:exe | Out-Null
        $manifest = Get-Content -LiteralPath (Join-Path $kit "manifest.json") -Raw | ConvertFrom-Json
        ($null -eq $manifest.PSObject.Properties["signature"]) | Should Be $true
    }
}
