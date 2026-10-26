param(
    [Parameter(Mandatory = $true)]
    [string]$AgentBinary,
    [Parameter(Mandatory = $true)]
    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# DEVELOPMENT ONLY: no execution on an owner workstation, no release signing,
# no foreground activation, no remote pairing or scheduled-task registration.
$report = [ordered]@{
    schema = 'tetherplane.msix.feasibility.v1'
    source_commit = $env:GITHUB_SHA
    head_ref = $env:GITHUB_HEAD_REF
    runner_environment = $env:RUNNER_ENVIRONMENT
    package_identity = 'Tetherplane.MsixFeasibility.DevOnly'
    publisher = 'CN=Tetherplane MSIX Development Probe'
    artifact_scope = 'ephemeral only; package and certificate are never uploaded'
    no_startup_extension = $true
    no_device_pairing = $true
    agent_activated = $false
    package_pack = 'NOT_RUN'
    package_unpack_integrity = 'NOT_RUN'
    dev_package_signature = 'NOT_RUN'
    add_appx = 'NOT_RUN'
    remove_appx = 'NOT_RUN'
    certificate_cleanup = 'NOT_RUN'
    agent_binary_sha256 = $null
    package_sha256 = $null
    trust_store_scope = 'LocalMachine/TrustedPeople (ephemeral runner only)'
    last_phase = 'NOT_STARTED'
    updated_utc = $null
    error = $null
    disposition = 'NO-GO'
}

$ownedCertificate = $null
$installedFullName = $null
$failed = $null

# Persist each checkpoint BEFORE invoking the next operation that could hang.
# The watchdog can terminate this ephemeral process without losing the last phase.
function Save-MsixPhase {
    param([Parameter(Mandatory = $true)][string]$Name)
    $script:report.last_phase = $Name
    $script:report.updated_utc = [DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText(
        [IO.Path]::GetFullPath($ReportPath),
        ($script:report | ConvertTo-Json -Depth 5),
        [System.Text.UTF8Encoding]::new($false)
    )
    Write-Output ("MSIX_PHASE=" + $Name)
}

try {
    if ($env:GITHUB_ACTIONS -cne 'true' -or
        $env:GITHUB_EVENT_NAME -cne 'pull_request' -or
        $env:RUNNER_OS -cne 'Windows' -or
        $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
        [string]::IsNullOrWhiteSpace($env:GITHUB_HEAD_REF) -or
        -not $env:GITHUB_HEAD_REF.StartsWith('feature/msix-feasibility-')) {
        throw 'Only a pull request on a disposable GitHub-hosted Windows runner may run this probe.'
    }
    if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or
        -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
        throw 'A trusted ephemeral runner temporary directory is required.'
    }

    Save-MsixPhase 'guard_passed'
    $source = (Resolve-Path -LiteralPath $AgentBinary).Path
    $sourceInfo = Get-Item -LiteralPath $source
    if ($sourceInfo.Length -lt 100000 -or $sourceInfo.Extension -ine '.exe' -or
        $sourceInfo.Name -cne 'tetherd.exe') {
        throw 'Only a compiled Windows tetherd.exe can be packaged by this probe.'
    }
    $report.agent_binary_sha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()

    $repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
    $manifestFile = Join-Path $repo 'packaging\msix-feasibility\AppxManifest.xml'
    $manifest = [xml](Get-Content -LiteralPath $manifestFile -Raw)
    if ($manifest.Package.Identity.Name -cne $report.package_identity -or
        $manifest.Package.Identity.Publisher -cne $report.publisher -or
        $manifest.OuterXml -match '(?i)startupTask|packagedServices|localSystemServices') {
        throw 'Unreviewed identity, publisher, startup extension or service capability.'
    }

    $sdkRoot = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Windows Kits\10\bin'
    $candidates = @(Get-ChildItem -LiteralPath $sdkRoot -Filter makeappx.exe -Recurse -ErrorAction Stop |
        Where-Object { $_.DirectoryName -match '[\/\\]x64$' } | Sort-Object FullName -Descending)
    if ($candidates.Count -eq 0) { throw 'Windows SDK x64 MakeAppx.exe is unavailable.' }
    $makeAppx = $candidates[0].FullName
    $signTool = Join-Path $candidates[0].DirectoryName 'signtool.exe'
    if (-not (Test-Path -LiteralPath $signTool -PathType Leaf)) {
        throw 'Matching Windows SDK x64 SignTool.exe is unavailable.'
    }

    Save-MsixPhase 'sdk_tools_verified'
    $scratch = Join-Path $env:RUNNER_TEMP ('tetherplane-msix-feasibility-' + $env:GITHUB_RUN_ID + '-' + $env:GITHUB_RUN_ATTEMPT)
    if (Test-Path -LiteralPath $scratch) { throw 'Refusing to reuse an existing scratch directory.' }
    $payload = Join-Path $scratch 'payload'
    $assets = Join-Path $payload 'Assets'
    $bin = Join-Path $payload 'bin'
    foreach ($path in @($scratch, $payload, $assets, $bin)) {
        New-Item -ItemType Directory -Path $path -ErrorAction Stop | Out-Null
    }

    Copy-Item -LiteralPath $manifestFile -Destination (Join-Path $payload 'AppxManifest.xml')
    Copy-Item -LiteralPath $source -Destination (Join-Path $bin 'tetherd.exe')

    # Plain synthetic test icons, not Tetherplane commercial brand artwork.
    Add-Type -AssemblyName System.Drawing
    foreach ($size in @(44, 50, 150)) {
        $bitmap = [System.Drawing.Bitmap]::new([int]$size, [int]$size)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::FromArgb(32, 37, 42))
            $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(220, 220, 220), [single][Math]::Max(1, $size / 15))
            try {
                $padding = [int][Math]::Round($size / 5)
                $graphics.DrawRectangle($pen, $padding, $padding, ($size - 2 * $padding), ($size - 2 * $padding))
            } finally { $pen.Dispose() }
            $bitmap.Save((Join-Path $assets ("Logo$size.png")), [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }

    $packageFile = Join-Path $scratch 'Tetherplane.MsixProbe.DevOnly.msix'
    Save-MsixPhase 'makeappx_pack_started'
    & $makeAppx pack /d $payload /p $packageFile
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx pack failed: $LASTEXITCODE" }
    $report.package_pack = 'PASS'
    $report.package_sha256 = (Get-FileHash -LiteralPath $packageFile -Algorithm SHA256).Hash.ToLowerInvariant()

    $unpacked = Join-Path $scratch 'unpacked'
    Save-MsixPhase 'makeappx_unpack_started'
    & $makeAppx unpack /p $packageFile /d $unpacked
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx unpack failed: $LASTEXITCODE" }
    $extractedHash = (Get-FileHash -LiteralPath (Join-Path $unpacked 'bin\tetherd.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($extractedHash -cne $report.agent_binary_sha256) {
        throw 'Extracted MSIX binary does not match the reviewed compiled executable.'
    }
    $report.package_unpack_integrity = 'PASS'

    # Temporary self-signed certificate, only in the disposable runner user store.
    # Its private key is never exported, uploaded, or used to publish a release.
    $certParams = @{
        Type = 'CodeSigningCert'
        Subject = $report.publisher
        CertStoreLocation = 'Cert:\CurrentUser\My'
        KeyAlgorithm = 'RSA'
        KeyLength = 2048
        HashAlgorithm = 'SHA256'
        NotAfter = (Get-Date).AddDays(1)
    }
    Save-MsixPhase 'self_signed_cert_creation_started'
    $ownedCertificate = New-SelfSignedCertificate @certParams
    Save-MsixPhase 'self_signed_cert_created'
    $publicCertificateFile = Join-Path $scratch 'dev-only-public.cer'
    [void](Export-Certificate -Cert $ownedCertificate -FilePath $publicCertificateFile)
    # Microsoft's MSIX development guidance uses LocalMachine/TrustedPeople.
    # Never add a transient development certificate to the broad Root trust store.
    # This code runs ONLY on an ephemeral, GitHub-hosted Windows runner.
    Save-MsixPhase 'localmachine_trustedpeople_import_started'
    [void](Import-Certificate -FilePath $publicCertificateFile -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople')
    Save-MsixPhase 'localmachine_trustedpeople_import_done'

    Save-MsixPhase 'signtool_sign_started'
    & $signTool sign /fd SHA256 /sha1 $ownedCertificate.Thumbprint /s My $packageFile
    if ($LASTEXITCODE -ne 0) { throw "SignTool ephemeral sign failed: $LASTEXITCODE" }
    Save-MsixPhase 'signtool_verify_started'
    & $signTool verify /pa /v $packageFile
    if ($LASTEXITCODE -ne 0) { throw "SignTool ephemeral verify failed: $LASTEXITCODE" }
    $report.dev_package_signature = 'PASS'
    Save-MsixPhase 'signtool_verify_passed'

    $prior = @(Get-AppxPackage -Name $report.package_identity -ErrorAction Stop)
    if ($prior.Count -gt 0) { throw 'Package identity already installed; refusing overwrite.' }
    # No activation, networking, OAuth, startup extension or scheduled task.
    Save-MsixPhase 'add_appx_started'
    Add-AppxPackage -Path $packageFile -ErrorAction Stop
    $installed = @(Get-AppxPackage -Name $report.package_identity -ErrorAction Stop)
    if ($installed.Count -ne 1) { throw 'MSIX did not register exactly one package identity.' }
    $installedFullName = $installed[0].PackageFullName
    $report.add_appx = 'PASS'
    Save-MsixPhase 'add_appx_passed'

    Save-MsixPhase 'remove_appx_started'
    Remove-AppxPackage -Package $installedFullName -ErrorAction Stop
    $installedFullName = $null
    $remaining = @(Get-AppxPackage -Name $report.package_identity -ErrorAction Stop)
    if ($remaining.Count -ne 0) { throw 'MSIX identity remains installed after removal.' }
    $report.remove_appx = 'PASS'
    $report.disposition = 'PACKAGE_INSTALL_REMOVE_PASS; STORE/OAUTH/STARTUP NOT TESTED'
    Save-MsixPhase 'install_remove_complete'
} catch {
    $failed = $_.Exception.Message
    $report.error = $failed
    Save-MsixPhase 'failed'
} finally {
    if ($null -ne $installedFullName) {
        try {
            Remove-AppxPackage -Package $installedFullName -ErrorAction Stop
            $report.remove_appx = 'PASS_AFTER_FAILURE'
        } catch {
            $report.remove_appx = 'CLEANUP_FAILED'
            $report.error = "$($report.error); MSIX cleanup failed: $($_.Exception.Message)"
        }
    }
    if ($null -ne $ownedCertificate) {
        $thumbprint = $ownedCertificate.Thumbprint
        $cleanupErrors = @()
        foreach ($store in @('Cert:\LocalMachine\TrustedPeople', 'Cert:\CurrentUser\My')) {
            try {
                $item = Join-Path $store $thumbprint
                if (Test-Path -LiteralPath $item) { Remove-Item -LiteralPath $item -Force -ErrorAction Stop }
            } catch { $cleanupErrors += $_.Exception.Message }
        }
        $report.certificate_cleanup = if ($cleanupErrors.Count -eq 0) { 'PASS' } else { 'FAILED' }
        if ($cleanupErrors.Count -gt 0) { $report.error = "$($report.error); certificate cleanup failure" }
    } else {
        $report.certificate_cleanup = 'NOT_CREATED'
    }
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($ReportPath), ($report | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
}

if ($null -ne $failed -or $report.certificate_cleanup -eq 'FAILED' -or $report.remove_appx -eq 'CLEANUP_FAILED') {
    Write-Error ("MSIX_FEASIBILITY_NO_GO: " + $report.error)
    exit 1
}
Write-Output 'MSIX_FEASIBILITY_PACKAGE_INSTALL_REMOVE_PASS; STORE/OAUTH/STARTUP NOT TESTED'
