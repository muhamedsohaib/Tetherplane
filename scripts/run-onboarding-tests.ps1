# Runs every onboarding Pester suite and exits nonzero from FailedCount.
#
# Pester 3.4 is required (the suites use its Should syntax). This entrypoint
# never trusts Invoke-Pester's pipeline or $LASTEXITCODE: it inspects the
# returned result object, and also fails when no test ran or a required
# acceptance test finished inconclusive/pending.
param(
    [string]$TestsPath = (Join-Path $PSScriptRoot "..\tests\onboarding"),
    [switch]$AllowInconclusive
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($PSVersionTable.PSEdition -eq "Desktop") {
    $env:PSModulePath = "$env:ProgramFiles\WindowsPowerShell\Modules;$env:SystemRoot\system32\WindowsPowerShell\v1.0\Modules"
    foreach ($coreName in @("Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Management", "Microsoft.PowerShell.Security")) {
        $loaded = Get-Module -Name $coreName
        if ($loaded -and $loaded.Version.Major -ne 3) { Remove-Module -Name $coreName -Force -ErrorAction SilentlyContinue }
        Import-Module -Name $coreName -ErrorAction Stop
    }
}

$available = @(Get-Module -ListAvailable -Name Pester | Where-Object { $_.Version -eq [Version]"3.4.0" })
if ($available.Count -eq 0) {
    Write-Output "Pester 3.4.0 is not installed; installing it for the current user."
    Install-Module -Name Pester -RequiredVersion 3.4.0 -Scope CurrentUser -Force -SkipPublisherCheck
}
Import-Module Pester -RequiredVersion 3.4.0 -Force

$resolved = (Resolve-Path -LiteralPath $TestsPath).Path
$result = Invoke-Pester -Path $resolved -PassThru

$failed = [int]$result.FailedCount
$total = [int]$result.TotalCount
$notRun = @($result.TestResult | Where-Object { @("Inconclusive", "Pending", "Skipped") -contains [string]$_.Result }).Count

Write-Output ("ONBOARDING_TESTS total={0} passed={1} failed={2} not_run={3}" -f $total, [int]$result.PassedCount, $failed, $notRun)

if ($total -eq 0) {
    Write-Output "ONBOARDING_TESTS_FAIL: no tests ran"
    exit 1
}
if ($failed -gt 0) {
    Write-Output "ONBOARDING_TESTS_FAIL: $failed test(s) failed"
    exit 1
}
if ($notRun -gt 0 -and -not $AllowInconclusive) {
    Write-Output "ONBOARDING_TESTS_FAIL: $notRun test(s) were inconclusive, pending or skipped"
    exit 1
}
Write-Output "ONBOARDING_TESTS_PASS"
exit 0
