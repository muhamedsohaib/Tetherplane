$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or
    $env:GITHUB_REPOSITORY -cne 'muhamedsohaib/Tetherplane' -or
    $env:GITHUB_REF -cne 'refs/heads/work/github-release-readiness-20261030') {
    throw 'candidate build requires explicitly dispatched disposable GitHub runner'
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$source = (& git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $source -cne $env:GITHUB_SHA -or
    (& git -C $repo status --porcelain)) { throw 'candidate source is not exact and clean' }
$root = Join-Path $env:RUNNER_TEMP 'github-candidate'
if (Test-Path -LiteralPath $root) { throw 'candidate build root must be new' }
New-Item -ItemType Directory -Path $root | Out-Null
# Set up the existing hosted C++ toolchain in this process only. Never install
# tooling, modify machine PATH or print the environment (it may hold tokens).
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if ($LASTEXITCODE -ne 0 -or -not $vs) { throw 'existing MSVC toolchain required' }
$devCmd = Join-Path $vs 'Common7\Tools\VsDevCmd.bat'
$toolEnvironment = & cmd.exe /d /s /c ('""' + $devCmd + '" -arch=x64 -host_arch=x64 >nul && set"')
if ($LASTEXITCODE -ne 0) { throw 'MSVC environment setup failed' }
foreach ($line in $toolEnvironment) {
    if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}
$linker = (Get-Command link.exe -ErrorAction Stop).Source
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
# Same checkout and Cargo paths on the two fresh hosted machines; remap emitted
# source paths, normalize PE timestamp and disable incremental compilation.
$env:CARGO_INCREMENTAL = '0'
$env:CARGO_ENCODED_RUSTFLAGS = @('--remap-path-prefix', ($repo + '=/tetherplane'),
    '--remap-path-prefix', ($cargoHome + '=/cargo'), '-C', 'link-arg=/Brepro') -join [char]31
Push-Location $repo
try {
    & ./scripts/build-windows-agent-binaries.ps1
    if ($LASTEXITCODE -ne 0) { throw 'native candidate build failed' }
    $stage = Join-Path $root 'package'
    & ./scripts/package-windows.ps1 -OutputPath $stage -SkipBuild
    if ($LASTEXITCODE -ne 0) { throw 'candidate packaging failed' }
    $inputs = [ordered]@{
        source_commit = $source
        cargo_lock_sha256 = (Get-FileHash Cargo.lock -Algorithm SHA256).Hash.ToLowerInvariant()
        pnpm_lock_sha256 = (Get-FileHash pnpm-lock.yaml -Algorithm SHA256).Hash.ToLowerInvariant()
        rustc = ((& rustc -Vv) -join "`n")
        cargo = ((& cargo -V) -join '')
        node = ((& node --version) -join '')
        pnpm = ((& pnpm.cmd --version) -join '')
        image = [string]$env:ImageVersion
        msvc = [string]$env:VCToolsVersion
        windows_sdk = [string]$env:WindowsSDKVersion
        linker_sha256 = (Get-FileHash -LiteralPath $linker -Algorithm SHA256).Hash.ToLowerInvariant()
        rustflags = 'remap repo=/tetherplane cargo=/cargo; link-arg=/Brepro; incremental=0'
    }
    foreach ($key in $inputs.Keys) { if (-not $inputs[$key]) { throw "missing build input: $key" } }
    $inputPath = Join-Path $root 'build-inputs.json'
    [IO.File]::WriteAllText($inputPath, ($inputs | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    python scripts/release/github_candidate.py record $stage $source (Join-Path $root 'evidence') $inputPath
    if ($LASTEXITCODE -ne 0) { throw 'deterministic candidate recording failed' }
    if (& git status --porcelain) { throw 'candidate build modified tracked source' }
} finally { Pop-Location }
