$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
. (Join-Path $PSScriptRoot "signing-fixtures.ps1")
. (Join-Path $repo "scripts/setup-windows-device.ps1")

# Native SIP integration runs in both required Windows CI shells. Linux cannot
# calculate or substitute the Windows signature-excluded digest.
Describe "immutable packaging after all code signatures" {
    BeforeEach {
        $script:packRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-sign-pack-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $script:packRoot | Out-Null
        $script:fixture = New-SignedPackagingFixture -Root $script:packRoot -SourceRepository $repo
        $script:packArgs = $script:fixture.Arguments
        Mock Get-AuthenticodeSignature { New-ValidSigningFixture }
    }
    AfterEach {
        Remove-Item -LiteralPath $script:packRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    It "requires an independently approved certificate before creating an output" -Skip:($env:OS -ne "Windows_NT") {
        $script:packArgs.Remove("ExpectedSignerThumbprint")
        { & $script:fixture.Builder @script:packArgs | Out-Null } | Should Throw "independently approved signer thumbprint"
        (Test-Path -LiteralPath $script:packArgs.OutputPath) | Should Be $false
    }

    It "requires an independently selected source revision" -Skip:($env:OS -ne "Windows_NT") {
        $script:packArgs.Remove("ExpectedSourceCommit")
        { & $script:fixture.Builder @script:packArgs | Out-Null } | Should Throw "independently selected source revision"
    }

    It "rejects a checkout that differs from the selected source revision" -Skip:($env:OS -ne "Windows_NT") {
        $script:packArgs.ExpectedSourceCommit = "1111111111111111111111111111111111111111"
        { & $script:fixture.Builder @script:packArgs | Out-Null } | Should Throw "source revision"
    }

    It "rejects dirty source before any final artifact is created" -Skip:($env:OS -ne "Windows_NT") {
        Set-Content -LiteralPath (Join-Path $script:fixture.Repository "unreviewed.txt") -Value "dirty"
        { & $script:fixture.Builder @script:packArgs | Out-Null } | Should Throw "clean source checkout"
        (Test-Path -LiteralPath $script:packArgs.OutputPath) | Should Be $false
    }

    It "requires the explicit isolated signed payload" -Skip:($env:OS -ne "Windows_NT") {
        $script:packArgs.Remove("SignedPayloadPath")
        { & $script:fixture.Builder @script:packArgs | Out-Null } | Should Throw "SignedPayloadPath"
    }

    It "does not silently treat signed inputs as an unsigned developer build" -Skip:($env:OS -ne "Windows_NT") {
        $script:packArgs.Remove("RequireTrustedSignature")
        { & $script:fixture.Builder @script:packArgs | Out-Null } | Should Throw "RequireTrustedSignature"
    }

    It "rejects unsigned PowerShell code before creating the output" -Skip:($env:OS -ne "Windows_NT") {
        Mock Get-AuthenticodeSignature {
            param($LiteralPath)
            if ([IO.Path]::GetFileName($LiteralPath) -eq "doctor-tetherplane.ps1") {
                return [pscustomobject]@{ Status = "NotSigned" }
            }
            New-ValidSigningFixture
        }
        { & $script:fixture.Builder @script:packArgs | Out-Null } | Should Throw "Authenticode signature is not trusted"
        (Test-Path -LiteralPath $script:packArgs.OutputPath) | Should Be $false
    }

    It "rejects an unexpected executable in the signing payload" -Skip:($env:OS -ne "Windows_NT") {
        Set-Content -LiteralPath (Join-Path $script:fixture.Payload "unexpected.ps1") -Value "unexpected"
        { & $script:fixture.Builder @script:packArgs | Out-Null } | Should Throw "signing payload layout"
    }

    It "rechecks the copied signatures before writing manifests or ZIPs" -Skip:($env:OS -ne "Windows_NT") {
        $script:packArgs.Zip = $true
        Mock Get-AuthenticodeSignature {
            param($LiteralPath)
            if ([IO.Path]::GetFileName($LiteralPath) -eq "doctor-tetherplane.ps1" -and $LiteralPath -notmatch "signed-payload") {
                [IO.File]::WriteAllText($LiteralPath, "modified-after-signing")
                return [pscustomobject]@{ Status = "HashMismatch" }
            }
            New-ValidSigningFixture
        }
        { & $script:fixture.Builder @script:packArgs | Out-Null } | Should Throw "Authenticode signature is not trusted"
        (Test-Path -LiteralPath $script:packArgs.OutputPath) | Should Be $false
        (Test-Path -LiteralPath ($script:packArgs.OutputPath + ".zip")) | Should Be $false
    }

    It "uses final signed bytes and lists all five verified code files" -Skip:($env:OS -ne "Windows_NT") {
        $script:packArgs.Zip = $true
        & $script:fixture.Builder @script:packArgs | Out-Null
        $output = $script:packArgs.OutputPath
        $manifest = Get-Content -LiteralPath (Join-Path $output "manifest.json") -Raw | ConvertFrom-Json
        $manifest.signature.scheme | Should Be "authenticode-public-trust-v2"
        $manifest.signature.signed_files.Count | Should Be 5
        $manifest.source_commit | Should Be $script:packArgs.ExpectedSourceCommit
        $manifest.source_tree_dirty | Should Be $false
        (Test-Path -LiteralPath (Join-Path $output "setup.cmd")) | Should Be $false
        foreach ($relative in $manifest.signature.signed_files) {
            (Get-FileHash -LiteralPath (Join-Path $output $relative)).Hash | Should Be (Get-FileHash -LiteralPath (Join-Path $script:fixture.Payload $relative)).Hash
        }
        $result = Confirm-DevicePackage -PackagePath $output -RequireTrustedSignature -ExpectedPublisherSubject $script:packArgs.ExpectedPublisherSubject -ExpectedSignerThumbprint $script:packArgs.ExpectedSignerThumbprint -ExpectedSourceCommit $script:packArgs.ExpectedSourceCommit
        $result.trusted_signature_verified | Should Be $true
        $checksum = ((Get-Content -LiteralPath ($output + ".zip.sha256") -Raw).Trim() -split "\s+", 2)[0]
        $checksum | Should Be (Get-FileHash -LiteralPath ($output + ".zip")).Hash.ToLowerInvariant()
    }

    It "never rebuilds or overwrites an existing signed artifact directory" -Skip:($env:OS -ne "Windows_NT") {
        & $script:fixture.Builder @script:packArgs | Out-Null
        $hash = (Get-FileHash -LiteralPath (Join-Path $script:packArgs.OutputPath "manifest.json")).Hash
        { & $script:fixture.Builder @script:packArgs | Out-Null } | Should Throw "signed output already exists"
        (Get-FileHash -LiteralPath (Join-Path $script:packArgs.OutputPath "manifest.json")).Hash | Should Be $hash
    }

    It "rejects different code from the same approved signer instead of assigning it the selected source revision" -Skip:($env:OS -ne "Windows_NT") {
        Set-Content -LiteralPath (Join-Path $script:fixture.Payload "doctor-tetherplane.ps1") -Value "older-signed-code-from-the-same-publisher" -Encoding UTF8
        { & $script:fixture.Builder @script:packArgs | Out-Null } | Should Throw "content digest"
        (Test-Path -LiteralPath $script:packArgs.OutputPath) | Should Be $false
    }
}
