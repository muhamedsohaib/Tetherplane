param([string]$HarnessPath = (Join-Path $PSScriptRoot '../../scripts/measure-windows-cdp-startup.ps1'))
$ErrorActionPreference = 'Stop'
$evidenceRoot = Join-Path ([IO.Path]::GetTempPath()) ('cdp-measurement-contract-' + [guid]::NewGuid().ToString('N'))

# Replace only the disposable subprocess boundary. Never start/kill a browser.
function Start-Process {
    param($FilePath, $WindowStyle, [switch]$PassThru, $WorkingDirectory, $ArgumentList, $RedirectStandardOutput, $RedirectStandardError)
    $probeContractCase = Split-Path -Leaf (Split-Path -Parent $RedirectStandardOutput)
    $text = "# pass 1`n# B6_STAGE=cleanup-complete`n"
    if ($probeContractCase -ne 'missing') {
        $stopped = if ($probeContractCase -eq 'unknown') { $null } else { $probeContractCase -eq 'verified' }
        $event = @{ stage='cleanup'; profile_removed=$true; launcher_stopped=$stopped; browser_process_stopped=$stopped } | ConvertTo-Json -Compress
        $text += "# CDP_STARTUP=$event`n"
    }
    Set-Content -LiteralPath $RedirectStandardOutput -Value $text
    Set-Content -LiteralPath $RedirectStandardError -Value ''
    $child = [pscustomobject]@{ Id=-123; ExitCode=0 }
    $child | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($milliseconds) return $true }
    return $child
}
function taskkill.exe { throw 'Receipt contract must not terminate a real process' }

foreach ($probeContractScenario in @('verified', 'alive', 'unknown', 'missing')) {
    $dir = Join-Path $evidenceRoot $probeContractScenario
    $failed = $false
    try { & $HarnessPath -EvidenceDirectory $dir | Out-Null }
    catch {
        if ($_.Exception.Message -notmatch 'CDP_DOWNLOAD_RELIABILITY_FAILED=5_OF_5') { throw }
        $failed = $true
    }
    if ($failed -ne ($probeContractScenario -ne 'verified')) { throw "Unverified cleanup was accepted: $probeContractScenario" }
    $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.jsonl')
    if ($files.Count -ne 5) { throw 'Measurement contract lost a trial receipt' }
    foreach ($file in $files) {
        $summary = Get-Content -LiteralPath $file.FullName -Tail 1 | ConvertFrom-Json
        if ($summary.passed -ne ($probeContractScenario -eq 'verified')) { throw 'Receipt disagrees with the measurement outcome' }
    }
}
Write-Output 'CDP_MEASUREMENT_CONTRACT=4_OF_4'
