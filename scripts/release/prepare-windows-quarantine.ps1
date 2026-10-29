param([Parameter(Mandatory = $true)][string]$WorkRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$root = [IO.Path]::GetFullPath($WorkRoot)
if (Test-Path -LiteralPath $root) { throw 'quarantine root must be new' }
if ($env:GITHUB_REF -cne 'refs/heads/test/windows-provenance-quarantine-20261030') { throw 'unexpected branch' }
$source = (& git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $source -cne $env:GITHUB_SHA -or $source -cnotmatch '^[0-9a-f]{40}$') { throw 'invalid source identity' }
$stage = Join-Path $root 'staged-package'
$evidence = Join-Path $root 'evidence'
$extract = Join-Path $root 'roundtrip-extract'
New-Item -ItemType Directory -Path $root,$evidence | Out-Null
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\package-windows.ps1') -OutputPath $stage -SkipBuild
if ($LASTEXITCODE -ne 0) { throw 'package failed' }
$verifier = Join-Path $repo 'scripts\release\windows-candidate-digests.mjs'
$record = @(& node $verifier record $stage $source)
if ($LASTEXITCODE -ne 0 -or $record.Count -eq 0) { throw 'inventory record failed' }
$inventoryPath = Join-Path $evidence 'candidate-inventory.json'
[IO.File]::WriteAllText($inventoryPath, (($record -join [char]10) + [char]10), [Text.UTF8Encoding]::new($false))
$inventoryHash = (Get-FileHash -LiteralPath $inventoryPath -Algorithm SHA256).Hash.ToLowerInvariant()
$verified = @(& node $verifier verify $stage $source $inventoryPath $inventoryHash)
if ($LASTEXITCODE -ne 0 -or $verified.Count -eq 0) { throw 'inventory verification failed' }
$verdict = ($verified -join [char]10) | ConvertFrom-Json
if ($verdict.byte_identity -cne 'MATCH' -or $verdict.release -cne 'NO_GO' -or $verdict.build_provenance -cne 'UNVERIFIED' -or $verdict.authenticode -cne 'UNVERIFIED' -or $verdict.windows_acceptance -cne 'NOT_RUN') { throw 'unsafe verification verdict' }
$name = "tetherplane-windows-x64-unsigned-$source.zip"
$archive = Join-Path $evidence $name
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -CompressionLevel Optimal
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw 'archive missing' }
Expand-Archive -LiteralPath $archive -DestinationPath $extract
$roundtrip = @(& node $verifier verify $extract $source $inventoryPath $inventoryHash)
if ($LASTEXITCODE -ne 0 -or $roundtrip.Count -eq 0) { throw 'round-trip verification failed' }
$v = ($roundtrip -join [char]10) | ConvertFrom-Json
if ($v.byte_identity -cne 'MATCH' -or $v.release -cne 'NO_GO') { throw 'round-trip verdict failed' }
$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$metadata = [ordered]@{
 schema = 'tetherplane.windows-unsigned-quarantine.v1'
 source_commit = $source
 source_ref = $env:GITHUB_REF
 workflow = '.github/workflows/windows-candidate-provenance.yml'
 run_id = [string]$env:GITHUB_RUN_ID
 run_attempt = [string]$env:GITHUB_RUN_ATTEMPT
 archive = $name
 archive_sha256 = $archiveHash
 inventory = 'candidate-inventory.json'
 inventory_sha256 = $inventoryHash
 release = 'NO_GO'
 windows_code_signature = 'NOT_SIGNED'
 windows_acceptance = 'NOT_RUN'
 build_attestation = 'PENDING_INDEPENDENT_VERIFICATION'
 rustc = ((& rustc --version) -join '').Trim()
 node = ((& node --version) -join '').Trim()
 pnpm = ((& pnpm.cmd --version) -join '').Trim()
}
[IO.File]::WriteAllText((Join-Path $evidence 'build-evidence.json'), (($metadata | ConvertTo-Json -Depth 5) + "`n"), [Text.UTF8Encoding]::new($false))
if (-not $env:GITHUB_OUTPUT) { throw 'missing GitHub Actions output path' }
Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "evidence_dir=$evidence" -Encoding utf8
Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "archive_path=$archive" -Encoding utf8
Write-Output 'WINDOWS_QUARANTINE_ARCHIVE_INVENTORY_ROUNDTRIP_OK'
Write-Output 'UNSIGNED_QUARANTINE_NO_PUBLIC_RELEASE'
