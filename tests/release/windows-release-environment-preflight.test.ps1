# Deterministic CI tests for the read-only GitHub environment preflight.
# All API responses come from a disposable local gh.cmd shim.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$preflight = Join-Path $repo 'scripts\verify-release-environment.ps1'
if (-not (Test-Path -LiteralPath $preflight -PathType Leaf)) {
    throw 'Release environment preflight script missing'
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('tetherplane-env-gate-test-' + [guid]::NewGuid().ToString('N'))
$originalPath = $env:PATH
New-Item -ItemType Directory -Path $testRoot -ErrorAction Stop | Out-Null

try {
    $mockExe = Join-Path $testRoot 'gh.cmd'
    $mockJson = Join-Path $testRoot 'api-response.json'
    $mockLog = Join-Path $testRoot 'api-invocations.txt'
    $mockLines = @(
        '@echo off',
        'echo %*>>"%GH_MOCK_LOG%"',
        'if not "%1"=="api" exit /b 10',
        'type "%GH_MOCK_JSON%"',
        'exit /b %GH_MOCK_EXIT%'
    )
    Set-Content -LiteralPath $mockExe -Value $mockLines -Encoding Ascii

    $env:PATH = "$testRoot;$originalPath"
    $env:GH_MOCK_JSON = $mockJson
    $env:GH_MOCK_LOG = $mockLog

    $cases = @(
        @{
            Name = 'reviewers-and-self-review-prohibited'
            Rules = @(@{
                type = 'required_reviewers'
                prevent_self_review = $true
                reviewers = @(@{ type = 'User'; reviewer = @{ login = 'independent-reviewer' } })
            })
            MockExit = 0
            ExpectAllowed = $true
        },
        @{
            Name = 'missing-required-reviewers'
            Rules = @(@{ type = 'wait_timer'; wait_timer = 3 })
            MockExit = 0
            ExpectAllowed = $false
        },
        @{
            Name = 'self-review-permitted'
            Rules = @(@{
                type = 'required_reviewers'
                prevent_self_review = $false
                reviewers = @(@{ type = 'User'; reviewer = @{ login = 'self-reviewer' } })
            })
            MockExit = 0
            ExpectAllowed = $false
        },
        @{
            Name = 'empty-reviewer-list'
            Rules = @(@{
                type = 'required_reviewers'
                prevent_self_review = $true
                reviewers = @()
            })
            MockExit = 0
            ExpectAllowed = $false
        },
        @{
            Name = 'inaccessible-api'
            Rules = @()
            MockExit = 2
            ExpectAllowed = $false
        }
    )

    foreach ($case in $cases) {
        $payload = [ordered]@{
            name = 'tetherplane-release-approval'
            protection_rules = @($case.Rules)
        } | ConvertTo-Json -Depth 10
        [IO.File]::WriteAllText($mockJson, $payload, (New-Object System.Text.UTF8Encoding($false)))
        $env:GH_MOCK_EXIT = [string]$case.MockExit
        if (Test-Path -LiteralPath $mockLog) {
            Remove-Item -LiteralPath $mockLog -Force
        }

        $lines = & powershell.exe -NoProfile -NonInteractive -File $preflight
        $exitCode = $LASTEXITCODE
        $receipt = ($lines | Out-String) | ConvertFrom-Json
        if ($case.ExpectAllowed) {
            if ($exitCode -ne 0 -or -not $receipt.environment_protection_pass -or
                $receipt.status -ne 'PASS_ENVIRONMENT_REVIEWER_PREFLIGHT_ONLY') {
                throw ("Expected PASS for " + $case.Name)
            }
        }
        else {
            if ($exitCode -eq 0 -or $receipt.environment_protection_pass -or
                $receipt.status -ne 'NO_GO') {
                throw ("Expected NO_GO for " + $case.Name)
            }
        }
        if ($receipt.production_changed -ne $false -or $receipt.tag_protection_independently_verified -ne $false) {
            throw ("Test overstated release authorization for " + $case.Name)
        }

        $calls = @(Get-Content -LiteralPath $mockLog -ErrorAction Stop)
        if ($calls.Count -ne 1 -or
            $calls[0] -notmatch '^api repos/muhamedsohaib/Tetherplane/environments/tetherplane-release-approval --header ' -or
            $calls[0] -match '(?i)(?:\s-X\s|\bPOST\b|\bPUT\b|\bDELETE\b)') {
            throw ("Unexpected GitHub API operation for " + $case.Name)
        }
    }

    Write-Output 'RELEASE_ENVIRONMENT_FAIL_CLOSED_TESTS_PASS'
}
finally {
    $env:PATH = $originalPath
    Remove-Item Env:\GH_MOCK_JSON -ErrorAction SilentlyContinue
    Remove-Item Env:\GH_MOCK_LOG -ErrorAction SilentlyContinue
    Remove-Item Env:\GH_MOCK_EXIT -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
