$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$auditScript = Join-Path $repo 'scripts\audit-windows-startup.ps1'
$installer = Join-Path $repo 'scripts\install-windows.ps1'
if (!(Test-Path -LiteralPath $auditScript -PathType Leaf)) { throw 'missing audit script' }
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('tp-startup-audit-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -Path $fixture -ItemType Directory -Force | Out-Null
    $resultJson = & $auditScript -InstallPrefix $fixture | Out-String
    $result = $resultJson | ConvertFrom-Json
    if ($result.mode -ne 'audit_only' -or $result.schema -ne 1) { throw 'audit schema mismatch' }
    if ($result.signatureStatus -ne 'missing') { throw 'unsigned fixture was approved' }
    if ($result.relayFlagPresent -or $result.credentialFileFlagPresent) { throw 'invented transport configuration' }
    if ($resultJson -match '(?i)bearer\s+\S+|password\s*[:=]') { throw 'possible credential leak in audit' }
    $source = Get-Content -LiteralPath $installer -Raw
    if ($source -notmatch 'New-ScheduledTaskSettingsSet' -or
        $source -notmatch 'MultipleInstances\s+IgnoreNew' -or
        $source -notmatch 'Register-ScheduledTask[^\r\n]*-Settings\s+\$taskSettings') {
        throw 'Windows installer lacks an enforced single-instance task setting'
    }
    if ($source -notmatch 'WindowStyle Hidden') { throw 'background window style missing' }
    Write-Output 'WINDOWS_STARTUP_AUDIT_AND_SINGLE_INSTANCE=PASS'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
