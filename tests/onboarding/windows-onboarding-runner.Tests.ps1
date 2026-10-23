$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

function Invoke-Runner($testsPath, [switch]$AllowInconclusive) {
    $runner = Join-Path $repo "scripts\run-onboarding-tests.ps1"
    $outFile = Join-Path $testsPath "..\runner-out.txt"
    $errFile = Join-Path $testsPath "..\runner-err.txt"
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -TestsPath "{1}"' -f $runner, $testsPath
    if ($AllowInconclusive) { $arguments += " -AllowInconclusive" }
    # Exercise the same PowerShell edition as this suite, including Core.
    $engine = (Get-Process -Id $PID).Path
    $process = Start-Process -FilePath $engine -ArgumentList $arguments -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru
    $null = $process.Handle
    if (-not $process.WaitForExit(180000)) {
        try { $process.Kill() } catch { }
        throw "runner did not finish within 180 seconds"
    }
    $exitCode = $process.ExitCode
    $process.Dispose()
    $text = ""
    if (Test-Path -LiteralPath $outFile) { $text += (Get-Content -LiteralPath $outFile -Raw) }
    if (Test-Path -LiteralPath $errFile) { $text += (Get-Content -LiteralPath $errFile -Raw) }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $text }
}

function New-FixtureSuite($root, $name, $body) {
    $dir = Join-Path $root $name
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Set-Content -LiteralPath (Join-Path $dir "fixture.Tests.ps1") -Value $body -Encoding Ascii
    return $dir
}

Describe "onboarding test runner exit status" {
    BeforeEach {
        $script:tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-runner-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $script:tempRoot | Out-Null
    }
    AfterEach {
        if ($script:tempRoot) { Remove-Item -LiteralPath $script:tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "exits zero only when every test passed" {
        $suite = New-FixtureSuite $script:tempRoot "pass" 'Describe "fixture" { It "passes" { 1 | Should Be 1 } }'
        $result = Invoke-Runner $suite
        $result.Output | Should Match "ONBOARDING_TESTS_PASS"
        $result.ExitCode | Should Be 0
    }

    It "exits nonzero from the failed count" {
        $suite = New-FixtureSuite $script:tempRoot "fail" 'Describe "fixture" { It "passes" { 1 | Should Be 1 }; It "fails" { 1 | Should Be 2 } }'
        $result = Invoke-Runner $suite
        $result.Output | Should Match "ONBOARDING_TESTS_FAIL: 1 test\(s\) failed"
        $result.ExitCode | Should Be 1
    }

    It "treats an inconclusive-only run as a failure unless explicitly allowed" {
        $suite = New-FixtureSuite $script:tempRoot "inconclusive" 'Describe "fixture" { It "is inconclusive" { Set-TestInconclusive "not runnable here" } }'
        $strict = Invoke-Runner $suite
        $strict.Output | Should Match "ONBOARDING_TESTS_FAIL"
        $strict.ExitCode | Should Be 1
        $allowed = Invoke-Runner $suite -AllowInconclusive
        $allowed.ExitCode | Should Be 0
    }

    It "fails when no test ran at all" {
        $empty = Join-Path $script:tempRoot "empty"
        New-Item -ItemType Directory -Force -Path $empty | Out-Null
        $result = Invoke-Runner $empty
        $result.Output | Should Match "no tests ran"
        $result.ExitCode | Should Be 1
    }
}
