param(
    [Parameter(Mandatory = $true)][string]$AgentBinary,
    [Parameter(Mandatory = $true)][string]$NodeExecutable,
    [Parameter(Mandatory = $true)][string]$OnboardingDirectory,
    [Parameter(Mandatory = $true)][string]$CompactDeployDirectory,
    [Parameter(Mandatory = $true)][string]$ReportPath,
    [string]$ApprovedAssetsDirectory,
    [string]$ApprovedAssetsManifest,
    [string]$OutputPath,
    [switch]$CiValidationOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Two deliberately separate modes:
# - CI: ephemeral UNSIGNED preview; synthetic icon fixtures; NO upload/install.
# - Operator: unsigned source-pinned candidate, only with reviewed artwork hashes.
# No signing keys, trust-store modifications, OAuth, or device mutations.
$identity = 'ARCUSLabs.Tetherplane'
$publisher = 'CN=6CCCFC81-2F0A-49BE-9027-A03BCF427F43'
$displayPublisher = 'ARCUS Labs'
$version = '0.1.0.0'
$report = [ordered]@{
    schema = 'tetherplane.store-private-candidate.v1'
    mode = if ($CiValidationOnly) { 'CI_SYNTHETIC_PREVIEW_NOT_SUBMITTABLE' } else { 'OWNER_REVIEW_UNSIGNED_CANDIDATE' }
    identity = $identity
    publisher = $publisher
    version = $version
    source_commit = 'NOT_VERIFIED'
    agent_sha256 = 'NOT_VERIFIED'
    agent_authenticode = 'NOT_CHECKED'
    node_sha256 = 'NOT_VERIFIED'
    manifest_sha256 = 'NOT_VERIFIED'
    store_runtime_sha256 = 'NOT_VERIFIED'
    store_setup_sha256 = 'NOT_VERIFIED'
    store_state_directory = 'TetherplaneStore'
    approved_artwork = $false
    package_sha256 = 'NOT_BUILT'
    unpack_integrity = 'NOT_RUN'
    native_SAC_On_acceptance = 'NOT_RUN'
    trusted_Store_signature = 'NOT_RUN'
    owner_approved_Store_submission = $false
    last_phase = 'START'
    error = $null
    disposition = 'NO_GO'
}
$failure = $null
$scratch = $null

function Get-Sha256Hex([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Assert-StoreManifest([string]$Path) {
    [xml]$manifest = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    if ($manifest.Package.Identity.Name -cne $identity -or
        $manifest.Package.Identity.Publisher -cne $publisher -or
        $manifest.Package.Identity.Version -cne $version -or
        $manifest.Package.Identity.ProcessorArchitecture -cne 'x64' -or
        $manifest.Package.Properties.PublisherDisplayName -cne $displayPublisher -or
        $manifest.Package.Properties.DisplayName -cne 'Tetherplane') {
        throw 'STORE_PROFILE_IDENTITY_MISMATCH'
    }
    if (@($manifest.Package.Applications.Application).Count -ne 2 -or
        $manifest.Package.Applications.Application[0].Id -cne 'Runtime' -or
        $manifest.Package.Applications.Application[1].Id -cne 'Agent' -or
        $manifest.Package.Applications.Application[0].Executable -cne 'runtime\node.exe' -or
        $manifest.Package.Applications.Application[1].Executable -cne 'bin\tetherd.exe' -or
        $manifest.Package.Applications.Application[1].VisualElements.AppListEntry -cne 'none') {
        throw 'STORE_PROFILE_UNEXPECTED_LAUNCHERS'
    }
    if ($manifest.Package.Applications.Application[0].VisualElements.Square150x150Logo -cne 'Assets\Logo150.png' -or
        $manifest.Package.Applications.Application[0].VisualElements.Square44x44Logo -cne 'Assets\Logo44.png') {
        throw 'STORE_PROFILE_ASSET_NAMES_INVALID'
    }
    $xmlText = $manifest.OuterXml
    if ($xmlText -match '(?i)startupTask|packagedServices|localSystemServices|Tetherplane.StoreRuntime.DevOnly|Development Probe') {
        throw 'STORE_PROFILE_DEVELOPMENT_IDENTITY_OR_STARTUP_CAPABILITY'
    }
    # Use XML namespace-aware fields rather than PowerShell's adapted .Name
    # or .ChildNodes properties (which do not behave consistently in PS 5.1).
    $capabilities = @($manifest.SelectNodes("/*[local-name()='Package']/*[local-name()='Capabilities']/*"))
    if ($capabilities.Count -ne 1) {
        throw 'STORE_PROFILE_CAPABILITY_COUNT_MISMATCH'
    }
    if ($capabilities[0].LocalName -cne 'Capability' -or
        $capabilities[0].NamespaceURI -cne 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities' -or
        $capabilities[0].GetAttribute('Name') -cne 'runFullTrust') {
        throw 'STORE_PROFILE_UNEXPECTED_PRIVILEGE'
    }
}

try {
    $repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
    $manifestFile = Join-Path $repo 'packaging\msix-store-candidate\AppxManifest.xml'
    Assert-StoreManifest -Path $manifestFile
    $report.manifest_sha256 = Get-Sha256Hex -Path $manifestFile

    if ($CiValidationOnly) {
        if ($env:GITHUB_ACTIONS -cne 'true' -or
            $env:GITHUB_EVENT_NAME -cne 'pull_request' -or
            $env:RUNNER_OS -cne 'Windows' -or
            $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
            -not ([string]$env:GITHUB_HEAD_REF).StartsWith('feature/msix-store-private-candidate-') -or
            [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
            throw 'CI_SYNTHETIC_PREVIEW_DENIED_OUTSIDE_DISPOSABLE_WINDOWS_PR'
        }
        if (-not [string]::IsNullOrWhiteSpace($OutputPath) -or
            -not [string]::IsNullOrWhiteSpace($ApprovedAssetsDirectory) -or
            -not [string]::IsNullOrWhiteSpace($ApprovedAssetsManifest)) {
            throw 'CI_SYNTHETIC_PREVIEW_DENIED_EXTERNAL_OUTPUT_OR_ARTWORK'
        }
    } elseif ([string]::IsNullOrWhiteSpace($ApprovedAssetsDirectory) -or
              [string]::IsNullOrWhiteSpace($ApprovedAssetsManifest) -or
              [string]::IsNullOrWhiteSpace($OutputPath)) {
        throw 'OWNER_CANDIDATE_NO_GO: approved artwork, pinned hashes and explicit output are required'
    }

    $agentPath = (Resolve-Path -LiteralPath $AgentBinary -ErrorAction Stop).Path
    $nodePath = (Resolve-Path -LiteralPath $NodeExecutable -ErrorAction Stop).Path
    $appSource = (Resolve-Path -LiteralPath $OnboardingDirectory -ErrorAction Stop).Path
    $compactSource = (Resolve-Path -LiteralPath $CompactDeployDirectory -ErrorAction Stop).Path
    if ((Split-Path -Leaf $agentPath) -cne 'tetherd.exe' -or
        (Get-Item -LiteralPath $agentPath).Length -lt 100000 -or
        (Split-Path -Leaf $nodePath) -cne 'node.exe' -or
        -not (Test-Path -LiteralPath (Join-Path $appSource 'runtime-app.mjs') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $compactSource 'dist\stdio-server.js') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $compactSource 'node_modules\@modelcontextprotocol\sdk\package.json') -PathType Leaf)) {
        throw 'STORE_CANDIDATE_REQUIRED_RUNTIME_MISSING'
    }
    $nodeLicense = Join-Path (Split-Path -Parent $nodePath) 'LICENSE'
    if (-not (Test-Path -LiteralPath $nodeLicense -PathType Leaf) -or
        [string](Get-AuthenticodeSignature -LiteralPath $nodePath -ErrorAction Stop).Status -cne 'Valid') {
        throw 'STORE_CANDIDATE_NODE_LICENSE_OR_SIGNATURE_INVALID'
    }
    $report.agent_sha256 = Get-Sha256Hex -Path $agentPath
    $report.agent_authenticode = [string](Get-AuthenticodeSignature -LiteralPath $agentPath).Status
    $report.node_sha256 = Get-Sha256Hex -Path $nodePath

    # Source is built from the exact checked-out commit. A dirty working tree
    # is not eligible for a review candidate. CI's PR merge SHA is recorded as
    # such, not mislabeled as the source branch head.
    $sha = (& git -C $repo rev-parse HEAD)
    if ($LASTEXITCODE -ne 0 -or [string]$sha -notmatch '^[0-9a-f]{40}$') {
        throw 'STORE_CANDIDATE_SOURCE_COMMIT_UNKNOWN'
    }
    $status = @(& git -C $repo status --porcelain --untracked-files=no)
    if ($LASTEXITCODE -ne 0 -or @($status | Where-Object { $_ }).Count -ne 0) {
        throw 'STORE_CANDIDATE_DIRTY_TRACKED_SOURCE'
    }
    $report.source_commit = [string]$sha

    $sdkRoot = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Windows Kits\10\bin'
    $kits = @(Get-ChildItem -LiteralPath $sdkRoot -Filter makeappx.exe -Recurse -ErrorAction Stop |
        Where-Object { $_.DirectoryName -match '[\\/]x64$' } |
        Sort-Object FullName -Descending)
    if ($kits.Count -eq 0) { throw 'STORE_CANDIDATE_WINDOWS_SDK_REQUIRED' }
    $makeAppx = $kits[0].FullName

    $scratchParent = if ($CiValidationOnly) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
    $scratch = Join-Path $scratchParent ('tetherplane-store-private-' + [guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $scratch) { throw 'STORE_CANDIDATE_SCRATCH_COLLISION' }
    $payload = Join-Path $scratch 'payload'
    $unpack = Join-Path $scratch 'unpacked'
    foreach ($item in @($scratch, $payload, (Join-Path $payload 'Assets'),
      (Join-Path $payload 'bin'), (Join-Path $payload 'runtime'),
      (Join-Path $payload 'app'), (Join-Path $payload 'adapters'))) {
        [void][IO.Directory]::CreateDirectory($item)
    }
    $report.last_phase = 'PAYLOAD_CREATED'
    Copy-Item -LiteralPath $manifestFile -Destination (Join-Path $payload 'AppxManifest.xml')
    Copy-Item -LiteralPath $agentPath -Destination (Join-Path $payload 'bin\tetherd.exe')
    Copy-Item -LiteralPath $nodePath -Destination (Join-Path $payload 'runtime\node.exe')
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $payload 'runtime\LICENSE')
    Copy-Item -Path (Join-Path $appSource '*') -Destination (Join-Path $payload 'app') -Recurse -Force
    Copy-Item -LiteralPath $compactSource -Destination (Join-Path $payload 'adapters\compact-mcp') -Recurse -Force

    # A deterministic, separately tested Node overlay transforms only this
    # fresh scratch copy; dev source and existing device state are untouched.
    $stageScript = Join-Path $repo 'scripts\msix-store\stage-store-runtime.mjs'
    & $nodePath $stageScript '--stage' (Join-Path $payload 'app')
    if ($LASTEXITCODE -ne 0) { throw 'STORE_CANDIDATE_STAGE_UI_FAILED' }
    $report.store_runtime_sha256 = Get-Sha256Hex -Path (Join-Path $payload 'app\runtime-app.mjs')
    $report.store_setup_sha256 = Get-Sha256Hex -Path (Join-Path $payload 'app\setup.html')

    $requiredArtwork = [ordered]@{ 'Logo44.png' = 44; 'Logo50.png' = 50; 'Logo150.png' = 150 }
    $artHashes = [ordered]@{}
    if ($CiValidationOnly) {
        Add-Type -AssemblyName System.Drawing
        foreach ($key in $requiredArtwork.Keys) {
            $size = [int]$requiredArtwork[$key]
            $bmp = [System.Drawing.Bitmap]::new([int]$size, [int]$size)
            $graphics = [Drawing.Graphics]::FromImage($bmp)
            try {
                $graphics.Clear([Drawing.Color]::FromArgb(150, 35, 35))
                $font = [System.Drawing.Font]::new('Arial', [single][Math]::Max(8, $size / 4))
                $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
                try { $graphics.DrawString('CI', $font, $brush, [single]2, [single]2) }
                finally { $font.Dispose(); $brush.Dispose() }
                $bmp.Save((Join-Path $payload ('Assets\' + $key)), [Drawing.Imaging.ImageFormat]::Png)
            } finally {
                $graphics.Dispose()
                $bmp.Dispose()
            }
        }
    } else {
        $assetFolder = (Resolve-Path -LiteralPath $ApprovedAssetsDirectory -ErrorAction Stop).Path
        $pinFile = (Resolve-Path -LiteralPath $ApprovedAssetsManifest -ErrorAction Stop).Path
        $pin = Get-Content -LiteralPath $pinFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if ($pin.schema -cne 'tetherplane.store-approved-assets.v1' -or
            $pin.package_identity -cne $identity -or
            [string]::IsNullOrWhiteSpace([string]$pin.owner_approval_reference)) {
            throw 'STORE_CANDIDATE_ARTWORK_APPROVAL_MISSING'
        }
        foreach ($key in $requiredArtwork.Keys) {
            $path = Join-Path $assetFolder $key
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'STORE_CANDIDATE_REQUIRED_ARTWORK_MISSING' }
            $expected = [string]$pin.files.$key
            $actual = Get-Sha256Hex -Path $path
            if ($expected -notmatch '^[0-9a-fA-F]{64}$' -or $expected -ine $actual) {
                throw 'STORE_CANDIDATE_ARTWORK_HASH_MISMATCH'
            }
            Copy-Item -LiteralPath $path -Destination (Join-Path $payload ('Assets\' + $key))
        }
        $report.approved_artwork = $true
    }
    Add-Type -AssemblyName System.Drawing
    foreach ($key in $requiredArtwork.Keys) {
        $file = Join-Path $payload ('Assets\' + $key)
        $bitmap = [Drawing.Image]::FromFile($file)
        try {
            if ($bitmap.Width -ne [int]$requiredArtwork[$key] -or
                $bitmap.Height -ne [int]$requiredArtwork[$key] -or
                (Get-Item -LiteralPath $file).Length -gt 5242880) {
                throw 'STORE_CANDIDATE_ARTWORK_DIMENSION_OR_SIZE_INVALID'
            }
        } finally { $bitmap.Dispose() }
        $artHashes[$key] = Get-Sha256Hex -Path $file
    }

    $provenance = [ordered]@{
        schema = 'tetherplane.store-candidate-provenance.v1'
        source_commit = $report.source_commit
        package_identity = $identity
        version = $version
        native_agent_sha256 = $report.agent_sha256
        node_sha256 = $report.node_sha256
        manifest_sha256 = $report.manifest_sha256
        store_runtime_sha256 = $report.store_runtime_sha256
        store_setup_sha256 = $report.store_setup_sha256
        store_state_directory = $report.store_state_directory
        logos_sha256 = $artHashes
        CI_synthetic_preview_only = [bool]$CiValidationOnly
        Store_certificate = 'NOT_APPLIED'
        owner_submission_approval = 'NOT_GRANTED'
    }
    [IO.File]::WriteAllText(
        (Join-Path $payload 'tetherplane-provenance.json'),
        ($provenance | ConvertTo-Json -Depth 5),
        [Text.UTF8Encoding]::new($false)
    )
    $report.last_phase = 'PACKAGING'
    $candidate = if ($CiValidationOnly) {
        Join-Path $scratch 'Tetherplane.CI-PREVIEW.NOT-FOR-SUBMISSION.msix'
    } else {
        $full = [IO.Path]::GetFullPath($OutputPath)
        if (Test-Path -LiteralPath $full -ErrorAction SilentlyContinue) {
            throw 'STORE_CANDIDATE_REFUSES_REPLACE_EXISTING_OUTPUT'
        }
        if (-not (Test-Path -LiteralPath (Split-Path -Parent $full) -PathType Container)) {
            throw 'STORE_CANDIDATE_OUTPUT_DIRECTORY_NOT_FOUND'
        }
        if (-not $full.EndsWith('.msix', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'STORE_CANDIDATE_OUTPUT_MUST_BE_MSIX'
        }
        $full
    }
    & $makeAppx pack /d $payload /p $candidate
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw 'STORE_CANDIDATE_MAKEAPPX_PACK_FAILED'
    }
    $report.package_sha256 = Get-Sha256Hex -Path $candidate
    $report.last_phase = 'UNPACKING'
    & $makeAppx unpack /p $candidate /d $unpack
    if ($LASTEXITCODE -ne 0) { throw 'STORE_CANDIDATE_MAKEAPPX_UNPACK_FAILED' }
    Assert-StoreManifest -Path (Join-Path $unpack 'AppxManifest.xml')
    $unpackedUi = [IO.File]::ReadAllText((Join-Path $unpack 'app\setup.html'))
    $unpackedJs = [IO.File]::ReadAllText((Join-Path $unpack 'app\runtime-app.mjs'))
    if ($unpackedUi -match '(?i)development preview|store-preview|not Microsoft Store-certified' -or
        $unpackedJs -match 'TetherplaneStoreDevOnly' -or
        $unpackedJs -notmatch '"TetherplaneStore"') {
        throw 'STORE_CANDIDATE_UNPACKED_DEVELOPMENT_TEXT_OR_STATE'
    }
    # The packaged app must survive its own nonconnecting self-test.
    # This mode reads local packaged files only: no OAuth, pairing or agent start.
    $selfTestNode = Join-Path $unpack 'runtime\node.exe'
    $selfTestScript = Join-Path $unpack 'app\runtime-app.mjs'
    Push-Location $unpack
    try {
        $selfTestText = & $selfTestNode $selfTestScript --self-test
        if ($LASTEXITCODE -ne 0) { throw 'STORE_CANDIDATE_RUNTIME_SELFTEST_EXIT_NONZERO' }
        $selfTestData = ($selfTestText | Out-String).Trim() | ConvertFrom-Json -ErrorAction Stop
        if ($selfTestData.success -ne $true) { throw 'STORE_CANDIDATE_RUNTIME_SELFTEST_FAILED' }
    } finally { Pop-Location }
    foreach ($entry in @(
        @{ Name = 'bin\tetherd.exe'; Hash = $report.agent_sha256 },
        @{ Name = 'runtime\node.exe'; Hash = $report.node_sha256 },
        @{ Name = 'AppxManifest.xml'; Hash = $report.manifest_sha256 },
        @{ Name = 'app\runtime-app.mjs'; Hash = $report.store_runtime_sha256 },
        @{ Name = 'app\setup.html'; Hash = $report.store_setup_sha256 },
        @{ Name = 'adapters\compact-mcp\dist\stdio-server.js'; Hash = (Get-Sha256Hex -Path (Join-Path $compactSource 'dist\stdio-server.js')) }
    )) {
        if ((Get-Sha256Hex -Path (Join-Path $unpack $entry.Name)) -cne $entry.Hash) {
            throw 'STORE_CANDIDATE_UNPACKED_RUNTIME_HASH_MISMATCH'
        }
    }
    foreach ($key in $requiredArtwork.Keys) {
        if ((Get-Sha256Hex -Path (Join-Path $unpack ('Assets\' + $key))) -cne $artHashes[$key]) {
            throw 'STORE_CANDIDATE_UNPACKED_ASSET_HASH_MISMATCH'
        }
    }
    $unpackedProvenance = Get-Content -LiteralPath (Join-Path $unpack 'tetherplane-provenance.json') -Raw | ConvertFrom-Json
    if ($unpackedProvenance.source_commit -cne $report.source_commit -or
        $unpackedProvenance.native_agent_sha256 -cne $report.agent_sha256 -or
        $unpackedProvenance.package_identity -cne $identity -or
        $unpackedProvenance.store_runtime_sha256 -cne $report.store_runtime_sha256 -or
        $unpackedProvenance.store_setup_sha256 -cne $report.store_setup_sha256) {
        throw 'STORE_CANDIDATE_PROVENANCE_FAILED'
    }
    $report.unpack_integrity = 'PASS'
    $report.last_phase = 'COMPLETE'
    $report.disposition = if ($CiValidationOnly) { 'CI_PACKAGE_STRUCTURE_PASS_NOT_SUBMITTABLE' } else { 'UNSIGNED_CANDIDATE_NEEDS_OWNER_AND_STORE_ACCEPTANCE' }
} catch {
    $failure = [string]$_.Exception.Message
    $report.error = $failure
    $report.disposition = 'NO_GO'
} finally {
    try {
        if ($null -ne $scratch -and (Test-Path -LiteralPath $scratch)) {
            Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction Stop
        }
    } catch {
        $report.disposition = 'NO_GO_CLEANUP_FAILED'
        $failure = 'STORE_CANDIDATE_TEMP_CLEANUP_FAILED'
    }
    $reportPathFull = [IO.Path]::GetFullPath($ReportPath)
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $reportPathFull) -PathType Container)) {
        throw 'STORE_CANDIDATE_REPORT_DIRECTORY_NOT_FOUND'
    }
    [IO.File]::WriteAllText($reportPathFull, ($report | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
}
if ($null -ne $failure) { throw $failure }
Write-Output ('STORE_CANDIDATE_RESULT=' + $report.disposition)
