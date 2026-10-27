# Tetherplane / Leno: local read-only connection and SAC preflight.
# Paste this entire block into Leno's existing Windows PowerShell session.
# It does not start/restart/stop tasks or services, install packages, change
# ExecutionPolicy/Smart App Control, or touch credentials.
$ErrorActionPreference = 'Stop'
$report = [ordered]@{
    schema = 'tetherplane-leno-readonly-preflight-v1'
    collected_utc = [DateTime]::UtcNow.ToString('o')
    windows_build = 'UNAVAILABLE'
    tailscale_service = 'UNAVAILABLE'
    tetherplane_tasks = @()
    task_query = 'UNAVAILABLE'
    agent_processes = @()
    process_query = 'UNAVAILABLE'
    installed_tetherplane_msix = @()
    package_query = 'UNAVAILABLE'
    sac_policy_raw = 'UNAVAILABLE'
    tetherd_code_integrity_3077 = @()
    code_integrity_query = 'UNAVAILABLE'
    note = 'Diagnostic only: no changes; absence of 3077 does not prove SAC acceptance'
}
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $report.windows_build = [string]$os.BuildNumber
} catch {}
try {
    $service = Get-Service -Name 'Tailscale' -ErrorAction Stop
    $report.tailscale_service = [string]$service.Status
} catch {
    $report.tailscale_service = 'NOT_FOUND_OR_NOT_READABLE'
}
try {
    $tasks = @(Get-ScheduledTask -TaskName '*Tetherplane*' -ErrorAction Stop)
    $report.tetherplane_tasks = @($tasks | ForEach-Object {
        [pscustomobject]@{ name = [string]$_.TaskName; state = [string]$_.State }
    })
    $report.task_query = 'OK'
} catch {
    $report.task_query = 'NO_MATCH_OR_ACCESS_DENIED'
}
try {
    $agents = @(Get-CimInstance Win32_Process -Filter "Name = 'tetherd.exe'" -ErrorAction Stop)
    $result = @()
    foreach ($agent in $agents) {
        $signature = 'UNAVAILABLE'
        $sha256 = 'UNAVAILABLE'
        if (-not [string]::IsNullOrWhiteSpace([string]$agent.ExecutablePath)) {
            try {
                $signature = [string](Get-AuthenticodeSignature -LiteralPath $agent.ExecutablePath -ErrorAction Stop).Status
            } catch {}
            try {
                $sha256 = [string](Get-FileHash -LiteralPath $agent.ExecutablePath -Algorithm SHA256 -ErrorAction Stop).Hash
            } catch {}
        }
        $result += [pscustomobject]@{
            pid = [int]$agent.ProcessId
            signature = $signature
            executable_sha256 = $sha256
        }
    }
    $report.agent_processes = @($result)
    $report.process_query = 'OK'
} catch {
    $report.process_query = 'ACCESS_DENIED_OR_UNAVAILABLE'
}
try {
    $packages = @(Get-AppxPackage -Name '*Tetherplane*' -ErrorAction Stop)
    $report.installed_tetherplane_msix = @($packages | ForEach-Object {
        [pscustomobject]@{
            name = [string]$_.Name
            version = [string]$_.Version
            signature_kind = [string]$_.SignatureKind
        }
    })
    $report.package_query = 'OK'
} catch {
    $report.package_query = 'ACCESS_DENIED_OR_UNAVAILABLE'
}
try {
    $policy = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name 'VerifiedAndReputablePolicyState' -ErrorAction Stop
    $report.sac_policy_raw = [string]$policy.VerifiedAndReputablePolicyState
} catch {
    # Do not infer SAC Off from an absent registry value.
    $report.sac_policy_raw = 'UNAVAILABLE_CHECK_WINDOWS_SECURITY_UI'
}
try {
    $events = @(Get-WinEvent -FilterHashtable @{
        LogName = 'Microsoft-Windows-CodeIntegrity/Operational'
        Id = 3077
        StartTime = (Get-Date).AddDays(-7)
    } -MaxEvents 100 -ErrorAction Stop)
    $matches = @($events | Where-Object {
        [string]$_.Message -match 'tetherd[.]exe'
    } | Select-Object -First 5)
    $report.tetherd_code_integrity_3077 = @($matches | ForEach-Object {
        [pscustomobject]@{
            event_id = [int]$_.Id
            observed_utc = $_.TimeCreated.ToUniversalTime().ToString('o')
        }
    })
    $report.code_integrity_query = 'OK_BOUNDED_LAST_100_EVENTS_7_DAYS'
} catch {
    $report.code_integrity_query = 'NO_MATCHING_EVENTS_OR_ACCESS_DENIED'
}
[pscustomobject]$report | ConvertTo-Json -Depth 6 -Compress
