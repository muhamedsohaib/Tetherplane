$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
. (Join-Path $PSScriptRoot "helpers.ps1")

# These snapshots use an independent literal list: an implementation that
# forgets a managed file must not make the expectations forget it too.
$UpgradeSnapshotPaths = @(
    "bin/tetherd.exe", "launch/tetherplane-agent.ps1", "manifest.json",
    "setup-windows-device.ps1", "pair-windows-device.ps1",
    "doctor-tetherplane.ps1", "connection-profile.json", "config/install.json"
)

function Get-UpgradeSnapshot($Prefix) {
    $snapshot = @{}
    foreach ($relative in $UpgradeSnapshotPaths) {
        $path = Join-Path $Prefix $relative
        $snapshot[$relative] = if (Test-Path -LiteralPath $path -PathType Leaf) {
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        } else { "missing" }
    }
    return $snapshot
}

function Assert-UpgradeSnapshot($Prefix, $Snapshot, [string[]]$Except = @()) {
    $current = Get-UpgradeSnapshot $Prefix
    foreach ($relative in $UpgradeSnapshotPaths) {
        if ($Except -notcontains $relative) { $current[$relative] | Should Be $Snapshot[$relative] }
    }
}

function Set-UpgradeCandidate($Package) {
    foreach ($relative in @("bin/tetherd.exe", "launch/tetherplane-agent.ps1", "doctor-tetherplane.ps1")) {
        Set-Content -LiteralPath (Join-Path $Package $relative) -Value ("version-two-" + $relative) -Encoding Ascii -NoNewline
    }
    $manifestPath = Join-Path $Package "manifest.json"
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest.version = "0.2.0"
    $manifest.source_commit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Write-TestSha256 $Package
}

Describe "managed upgrade preservation and recovery" {
    # Pester 3 retains function-mock wrappers until Describe exits. Reloading
    # the implementation in BeforeEach would overwrite those wrappers and
    # silently prevent the later race injections from running.
    . (Join-Path $repo "scripts/setup-windows-device.ps1")
    $script:upgradeRealManagedHash = (Get-Command Get-ManagedDeviceFileHash -CommandType Function).ScriptBlock
    BeforeEach {
        $script:upgradeRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-upgrade-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $script:upgradeRoot | Out-Null
        $script:upgradePackage = New-TestPackage $script:upgradeRoot
        $script:upgradeInstall = Join-Path $script:upgradeRoot "install"
        $script:upgradeFailedOnce = $false
        Mock Copy-Item { [IO.File]::Copy([string]$LiteralPath, [string]$Destination, [bool]$Force) }
    }
    AfterEach {
        if ($script:upgradeRoot) { Remove-Item -LiteralPath $script:upgradeRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "records every installed managed digest and an explicit developer signing policy" {
        Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null
        $receipt = Get-Content -LiteralPath (Join-Path $script:upgradeInstall "config/install.json") -Raw | ConvertFrom-Json
        ($null -ne $receipt.PSObject.Properties["receipt_version"]) | Should Be $true
        $receipt.receipt_version | Should Be 2
        @($receipt.managed_files.PSObject.Properties).Count | Should Be 7
        foreach ($relative in ($UpgradeSnapshotPaths | Where-Object { $_ -ne "config/install.json" })) {
            $receipt.managed_files.$relative | Should Be ((Get-FileHash -LiteralPath (Join-Path $script:upgradeInstall $relative) -Algorithm SHA256).Hash.ToLowerInvariant())
        }
        $receipt.signature_policy.require_trusted_signature | Should Be $false
    }

    It "refuses a locally edited managed launcher before touching any other installed file" {
        Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null
        Set-Content -LiteralPath (Join-Path $script:upgradeInstall "launch/tetherplane-agent.ps1") -Value "user-edited-launcher" -Encoding Ascii -NoNewline
        $before = Get-UpgradeSnapshot $script:upgradeInstall
        Set-UpgradeCandidate $script:upgradePackage
        { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall } | Should Throw "modified"
        Assert-UpgradeSnapshot $script:upgradeInstall $before
    }

    It "repairs a missing managed file without changing device state or unknown files" {
        Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null
        $agentHash = (Get-FileHash -LiteralPath (Join-Path $script:upgradeInstall "bin/tetherd.exe")).Hash
        Remove-Item -LiteralPath (Join-Path $script:upgradeInstall "bin/tetherd.exe")
        Set-Content -LiteralPath (Join-Path $script:upgradeInstall "unknown.txt") -Value "keep-user-file" -Encoding Ascii -NoNewline
        Set-Content -LiteralPath (Join-Path $script:upgradeInstall "config/agent-args.json") -Value '["keep-existing-arguments"]' -Encoding Ascii -NoNewline
        $result = Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall
        $result.repaired | Should Be $true
        (Get-FileHash -LiteralPath (Join-Path $script:upgradeInstall "bin/tetherd.exe")).Hash | Should Be $agentHash
        (Get-Content -LiteralPath (Join-Path $script:upgradeInstall "unknown.txt") -Raw) | Should Be "keep-user-file"
        (Get-Content -LiteralPath (Join-Path $script:upgradeInstall "config/agent-args.json") -Raw) | Should Be '["keep-existing-arguments"]'
    }

    It "refuses legacy receipts that cannot prove ownership of installed scripts" {
        Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null
        $receiptPath = Join-Path $script:upgradeInstall "config/install.json"
        @{
            managed_by = "setup-windows-device.ps1"; install_prefix = $script:upgradeInstall
            source_commit = "legacy"; tetherd_sha256 = (Get-FileHash -LiteralPath (Join-Path $script:upgradeInstall "bin/tetherd.exe")).Hash.ToLowerInvariant()
        } | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding UTF8
        $before = Get-UpgradeSnapshot $script:upgradeInstall
        Set-UpgradeCandidate $script:upgradePackage
        { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall } | Should Throw "legacy"
        Assert-UpgradeSnapshot $script:upgradeInstall $before
    }

    It "keeps a retained backup while a successful upgrade preserves credentials and configuration" {
        Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null
        $before = Get-UpgradeSnapshot $script:upgradeInstall
        $preserve = @("config/agent-args.json", "config/principal.json", "device.credential", "unknown.txt")
        foreach ($relative in $preserve) {
            Set-Content -LiteralPath (Join-Path $script:upgradeInstall $relative) -Value ("preserve-" + $relative) -Encoding Ascii -NoNewline
        }
        Set-UpgradeCandidate $script:upgradePackage
        $result = Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall
        $result.repaired | Should Be $true
        (Get-Content -LiteralPath (Join-Path $script:upgradeInstall "bin/tetherd.exe") -Raw) | Should Be "version-two-bin/tetherd.exe"
        foreach ($relative in $preserve) {
            (Get-Content -LiteralPath (Join-Path $script:upgradeInstall $relative) -Raw) | Should Be ("preserve-" + $relative)
        }
        $result.Contains("backup_path") | Should Be $true
        Test-Path -LiteralPath $result.backup_path -PathType Container | Should Be $true
        Assert-UpgradeSnapshot $result.backup_path $before
        $journal = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $result.backup_path) "journal.json") -Raw | ConvertFrom-Json
        $journal.status | Should Be "committed"
    }

    It "rolls back earlier file replacements when a later candidate copy fails" {
        Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null
        $before = Get-UpgradeSnapshot $script:upgradeInstall
        Set-UpgradeCandidate $script:upgradePackage
        Mock Copy-Item {
            if ($LiteralPath -match '[/\\]launch[/\\]tetherplane-agent\.ps1$' -and
                $Destination.StartsWith($script:upgradeInstall + [IO.Path]::DirectorySeparatorChar)) { throw "injected-later-copy-failure" }
            [IO.File]::Copy([string]$LiteralPath, [string]$Destination, [bool]$Force)
        }
        { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall } | Should Throw "injected-later-copy-failure"
        Assert-UpgradeSnapshot $script:upgradeInstall $before
    }

    It "rolls back every replacement when the final receipt cannot be written" {
        Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null
        $before = Get-UpgradeSnapshot $script:upgradeInstall
        Set-UpgradeCandidate $script:upgradePackage
        Mock Copy-Item {
            if ((Split-Path -Leaf $LiteralPath) -eq "candidate-install.json" -and
                $Destination.StartsWith($script:upgradeInstall + [IO.Path]::DirectorySeparatorChar)) { throw "injected-receipt-copy-failure" }
            [IO.File]::Copy([string]$LiteralPath, [string]$Destination, [bool]$Force)
        }
        { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall } | Should Throw "injected-receipt-copy-failure"
        Assert-UpgradeSnapshot $script:upgradeInstall $before
    }

    It "refuses an unsigned downgrade using only the installed signing requirement" {
        Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null
        # Model an independently approved policy persisted by a prior signed
        # installation; the incoming package supplies no trust requirements.
        $receiptPath = Join-Path $script:upgradeInstall "config/install.json"
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        $receipt | Add-Member -Force -NotePropertyName signature_policy -NotePropertyValue ([pscustomobject]@{
            require_trusted_signature = $true
            expected_publisher_subject = "CN=Tetherplane Test Publisher"
            expected_signer_thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567"
        })
        $receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
        $before = Get-UpgradeSnapshot $script:upgradeInstall
        Set-UpgradeCandidate $script:upgradePackage
        { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall } | Should Throw "sign"
        Assert-UpgradeSnapshot $script:upgradeInstall $before
    }

    It "leaves a concurrent user change intact when rollback encounters it" {
        Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null
        $before = Get-UpgradeSnapshot $script:upgradeInstall
        Set-UpgradeCandidate $script:upgradePackage
        Mock Copy-Item {
            if ($LiteralPath -match '[/\\]launch[/\\]tetherplane-agent\.ps1$' -and
                $Destination.StartsWith($script:upgradeInstall + [IO.Path]::DirectorySeparatorChar)) {
                Set-Content -LiteralPath (Join-Path $script:upgradeInstall "bin/tetherd.exe") -Value "concurrent-user-write" -Encoding Ascii -NoNewline
                throw "injected-concurrent-copy-failure"
            }
            [IO.File]::Copy([string]$LiteralPath, [string]$Destination, [bool]$Force)
        }
        { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall } | Should Throw "unexpected writes were preserved"
        (Get-Content -LiteralPath (Join-Path $script:upgradeInstall "bin/tetherd.exe") -Raw) | Should Be "concurrent-user-write"
        Assert-UpgradeSnapshot $script:upgradeInstall $before -Except @("bin/tetherd.exe")
        { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall } | Should Throw "recovery"
    }

    It "retains a human write arriving after the final replacement hash and requires recovery" {
        Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null
        $before = Get-UpgradeSnapshot $script:upgradeInstall
        Set-UpgradeCandidate $script:upgradePackage
        $script:upgradeLateWriteInjected = $false
        Mock Get-ManagedDeviceFileHash {
            $hash = & $script:upgradeRealManagedHash -LiteralPath $LiteralPath
            if (-not $script:upgradeLateWriteInjected -and $LiteralPath -eq (Join-Path $script:upgradeInstall "bin/tetherd.exe") -and
                @(Get-ChildItem -LiteralPath (Split-Path -Parent $LiteralPath) -Filter "tetherd.exe.tp-*.tmp" -File).Count -gt 0) {
                # The real hash has already been read. Model a separate writer
                # in the gap immediately before the atomic replacement.
                [IO.File]::WriteAllText($LiteralPath, "human-write-after-final-replacement-hash")
                $script:upgradeLateWriteInjected = $true
            }
            return $hash
        }
        $errorText = ""
        try { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null }
        catch { $errorText = $_.Exception.Message }
        $script:upgradeLateWriteInjected | Should Be $true
        $retained = @(Get-ChildItem -LiteralPath ($script:upgradeInstall + ".tetherplane-upgrades") -Recurse -File |
            Where-Object { [IO.File]::ReadAllText($_.FullName) -ceq "human-write-after-final-replacement-hash" })
        $retained.Count | Should Be 1
        $errorText | Should Match "Recovery is required"
        $errorText | Should Match ([regex]::Escape($retained[0].FullName))
        Assert-UpgradeSnapshot $script:upgradeInstall $before
        $journals = @(Get-ChildItem -LiteralPath ($script:upgradeInstall + ".tetherplane-upgrades") -Recurse -Filter "journal.json" -File |
            ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json })
        @($journals | Where-Object { $_.status -eq "needs_recovery" }).Count | Should Be 1
        { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall } | Should Throw "recovery"
    }

    It "retains a human write arriving after the final rollback deletion hash" {
        $script:upgradeRollbackStarted = $false
        $script:upgradeRollbackDestinationReads = 0
        $script:upgradeLateWriteInjected = $false
        Mock Copy-Item {
            if ($LiteralPath -match '[/\\]launch[/\\]tetherplane-agent\.ps1$' -and
                $Destination.StartsWith($script:upgradeInstall + [IO.Path]::DirectorySeparatorChar)) {
                $script:upgradeRollbackStarted = $true
                throw "injected-copy-failure-before-rollback-race"
            }
            [IO.File]::Copy([string]$LiteralPath, [string]$Destination, [bool]$Force)
        }
        Mock Get-ManagedDeviceFileHash {
            $hash = & $script:upgradeRealManagedHash -LiteralPath $LiteralPath
            if ($script:upgradeRollbackStarted -and $LiteralPath -eq (Join-Path $script:upgradeInstall "bin/tetherd.exe")) {
                $script:upgradeRollbackDestinationReads++
                if ($script:upgradeRollbackDestinationReads -eq 2) {
                    [IO.File]::WriteAllText($LiteralPath, "human-write-after-final-rollback-hash")
                    $script:upgradeLateWriteInjected = $true
                }
            }
            return $hash
        }
        $errorText = ""
        try { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null }
        catch { $errorText = $_.Exception.Message }
        $script:upgradeLateWriteInjected | Should Be $true
        $retained = @(Get-ChildItem -LiteralPath ($script:upgradeInstall + ".tetherplane-upgrades") -Recurse -File |
            Where-Object { [IO.File]::ReadAllText($_.FullName) -ceq "human-write-after-final-rollback-hash" })
        $retained.Count | Should Be 1
        $errorText | Should Match "Recovery is required"
        $journalPath = @(Get-ChildItem -LiteralPath ($script:upgradeInstall + ".tetherplane-upgrades") -Recurse -Filter "journal.json" -File)[0].FullName
        (Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json).status | Should Be "needs_recovery"
        { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall } | Should Throw "recovery"
    }

    It "retains a journal edit arriving after the final commit hash and blocks the next repair" {
        Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null
        $before = Get-UpgradeSnapshot $script:upgradeInstall
        Set-UpgradeCandidate $script:upgradePackage
        $script:upgradeLateWriteInjected = $false
        $script:upgradeRacedJournalPath = ""
        Mock Get-ManagedDeviceFileHash {
            $hash = & $script:upgradeRealManagedHash -LiteralPath $LiteralPath
            if (-not $script:upgradeLateWriteInjected -and (Split-Path -Leaf $LiteralPath) -eq "journal.json") {
                $commitCopies = @(Get-ChildItem -LiteralPath (Split-Path -Parent $LiteralPath) -Filter "journal.json.*.tmp" -File |
                    Where-Object { (Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json).status -eq "committed" })
                if ($commitCopies.Count -gt 0) {
                    $humanJournal = Get-Content -LiteralPath $LiteralPath -Raw | ConvertFrom-Json
                    $humanJournal | Add-Member -NotePropertyName human_note -NotePropertyValue "preserve-this-recovery-note"
                    $humanJournal | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $LiteralPath -Encoding UTF8
                    $script:upgradeLateWriteInjected = $true
                    $script:upgradeRacedJournalPath = $LiteralPath
                }
            }
            return $hash
        }
        $errorText = ""
        try { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null }
        catch { $errorText = $_.Exception.Message }
        $script:upgradeLateWriteInjected | Should Be $true
        $retained = @(Get-ChildItem -LiteralPath (Split-Path -Parent $script:upgradeRacedJournalPath) -Recurse -File |
            Where-Object { [IO.File]::ReadAllText($_.FullName).Contains("preserve-this-recovery-note") })
        $retained.Count | Should Be 1
        $errorText | Should Match "Recovery is required"
        (Get-Content -LiteralPath $script:upgradeRacedJournalPath -Raw | ConvertFrom-Json).status | Should Be "needs_recovery"
        Assert-UpgradeSnapshot $script:upgradeInstall $before
        { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall } | Should Throw "recovery"
        # An interruption immediately after replacing the commit journal can
        # leave that status on disk before the conflict handler runs. Retained
        # displacement evidence must still block a new repair in that state.
        $interruptedJournal = Get-Content -LiteralPath $script:upgradeRacedJournalPath -Raw | ConvertFrom-Json
        $interruptedJournal.status = "committed"
        $interruptedJournal | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $script:upgradeRacedJournalPath -Encoding UTF8
        { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall } | Should Throw "recovery"
    }

    It "cleans only its fresh managed writes after failure so a clean retry can succeed" {
        Mock Copy-Item {
            if (-not $script:upgradeFailedOnce -and $LiteralPath -match '[/\\]launch[/\\]tetherplane-agent\.ps1$' -and
                $Destination.StartsWith($script:upgradeInstall + [IO.Path]::DirectorySeparatorChar)) {
                $script:upgradeFailedOnce = $true
                throw "injected-first-install-failure"
            }
            [IO.File]::Copy([string]$LiteralPath, [string]$Destination, [bool]$Force)
        }
        { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall } | Should Throw "injected-first-install-failure"
        foreach ($relative in $UpgradeSnapshotPaths) { Test-Path -LiteralPath (Join-Path $script:upgradeInstall $relative) | Should Be $false }
        (Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall).ok | Should Be $true
    }

    It "refuses a transaction left in progress and gives the retained recovery location" {
        Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null
        Set-UpgradeCandidate $script:upgradePackage
        $result = Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall
        $result.Contains("backup_path") | Should Be $true
        $journalPath = Join-Path (Split-Path -Parent $result.backup_path) "journal.json"
        $journal = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
        $journal.status = "applying"
        $journal | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $journalPath -Encoding UTF8
        $before = Get-UpgradeSnapshot $script:upgradeInstall
        $errorText = ""
        try { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null }
        catch { $errorText = $_.Exception.Message }
        $errorText | Should Match "recovery"
        $errorText | Should Match ([regex]::Escape((Split-Path -Parent $journalPath)))
        Assert-UpgradeSnapshot $script:upgradeInstall $before
        { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix ($script:upgradeInstall + [IO.Path]::DirectorySeparatorChar) } | Should Throw "recovery"
        Assert-UpgradeSnapshot $script:upgradeInstall $before
    }

    It "detects a user edit made while the incoming package is being verified" {
        Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall | Out-Null
        $before = Get-UpgradeSnapshot $script:upgradeInstall
        Set-UpgradeCandidate $script:upgradePackage
        $script:upgradeHashCommand = Get-Command Get-FileHash -CommandType Cmdlet, Function
        $script:upgradeEditPending = $true
        Mock Get-FileHash {
            if ($script:upgradeEditPending -and [string]$LiteralPath -eq (Join-Path $script:upgradePackage "bin/tetherd.exe")) {
                $script:upgradeEditPending = $false
                Set-Content -LiteralPath (Join-Path $script:upgradeInstall "launch/tetherplane-agent.ps1") -Value "edit-during-candidate-verification" -Encoding Ascii -NoNewline
            }
            if (-not $Algorithm) { $Algorithm = "SHA256" }
            & $script:upgradeHashCommand -LiteralPath $LiteralPath -Algorithm $Algorithm
        }
        { Install-ManagedDeviceFiles -PackagePath $script:upgradePackage -InstallPrefix $script:upgradeInstall } | Should Throw "modified"
        (Get-Content -LiteralPath (Join-Path $script:upgradeInstall "launch/tetherplane-agent.ps1") -Raw) | Should Be "edit-during-candidate-verification"
        Assert-UpgradeSnapshot $script:upgradeInstall $before -Except @("launch/tetherplane-agent.ps1")
    }
}
