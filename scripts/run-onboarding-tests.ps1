# Runs every onboarding Pester suite and exits nonzero from FailedCount.
#
# Windows PowerShell uses its pinned Pester 3.4 suite. PowerShell Core uses
# Pester 4.10.1, which supports the same assertion syntax without removed WMI
# cmdlets. This entrypoint
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

$pesterVersion = if ($PSVersionTable.PSEdition -eq "Desktop") { "3.4.0" } else { "4.10.1" }
$available = @(Get-Module -ListAvailable -Name Pester | Where-Object { $_.Version -eq [Version]$pesterVersion })
if ($available.Count -eq 0) {
    Write-Output "Pester $pesterVersion is not installed; installing it for the current user."
    Install-Module -Name Pester -RequiredVersion $pesterVersion -Scope CurrentUser -Force -SkipPublisherCheck
}
Import-Module Pester -RequiredVersion $pesterVersion -Force
Write-Output ("ONBOARDING_TEST_RUNTIME powershell={0} pester={1}" -f $PSVersionTable.PSVersion, $pesterVersion)

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
