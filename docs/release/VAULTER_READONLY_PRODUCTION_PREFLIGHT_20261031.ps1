#requires -Version 5.1
<#
Read-only VAULTER production release inventory.
Run locally in an elevated PowerShell window on VAULTER.
No task/service start, stop, write, OAuth change, or credential extraction.
Only sanitized metadata/hashes are printed. NEVER paste task arguments or raw
command lines in a support conversation.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ItemHash([string]$file) {
    if ([string]::IsNullOrWhiteSpace($file) -or !(Test-Path -LiteralPath $file -PathType Leaf)) {
        return 'UNAVAILABLE'
    }
    return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
}

function ArgPath([string]$command, [string]$flag) {
    $pattern = '(?i)(?:^|\s)' + [regex]::Escape($flag) + '(?:\s+|=)(?:"([^"]+)"|(\S+))'
    $m = [regex]::Match($command, $pattern)
    if (!$m.Success) { return $null }
    if ($m.Groups[1].Success) { return $m.Groups[1].Value }
    return $m.Groups[2].Value
}

function ScriptPath([string]$command, [string]$type) {
    $tail = if ($type -eq 'portal') { 'oauth\.mjs' } else { 'cli\.js' }
    $m = [regex]::Match($command, '(?i)([A-Z]:\\[^"\r\n]+?\\' + $tail + ')(?:"|\s|$)')
    if (!$m.Success) { return $null }
    return $m.Groups[1].Value
}

function WorldWritable([string]$file) {
    if ([string]::IsNullOrWhiteSpace($file) -or !(Test-Path -LiteralPath $file)) {
        return 'UNKNOWN'
    }
    try {
        $acl = Get-Acl -LiteralPath $file
        foreach ($entry in $acl.Access) {
            if ($entry.AccessControlType -ne 'Allow') { continue }
            $sid = try { $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { '' }
            if ($sid -notin @('S-1-1-0','S-1-5-11','S-1-5-32-545')) { continue }
            $rights = [System.Security.AccessControl.FileSystemRights]$entry.FileSystemRights
            $writeRights = [System.Security.AccessControl.FileSystemRights]('Write, Modify, FullControl')
            if (($rights -band $writeRights) -ne 0) { return 'WARNING_BROAD_WRITE' }
        }
        return 'NO_BROAD_WRITE_DETECTED'
    } catch { return 'UNKNOWN' }
}

if ($env:COMPUTERNAME -ine 'VAULTER') {
    throw 'HOST_MISMATCH: run locally on VAULTER. No inspection performed.'
}

Write-Output '=== VAULTER READ-ONLY RELEASE PREFLIGHT ==='
Write-Output ('OBSERVED_UTC=' + (Get-Date).ToUniversalTime().ToString('o'))
Write-Output ('HOST=' + $env:COMPUTERNAME)
Write-Output 'CONFIG_VALUES_AND_CREDENTIALS_ARE_NEVER_PRINTED'

$expectedPorts = @(
    @{Port=8788; Role='relay'; Expected='Tetherplane'},
    @{Port=8790; Role='auth'; Expected='auth'},
    @{Port=8791; Role='portal'; Expected='ControlCenter'}
)

$observed = @{}
foreach ($entry in $expectedPorts) {
    $port = [int]$entry.Port
    $bound = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    $pids = @($bound | Select-Object -ExpandProperty OwningProcess -Unique)
    Write-Output ('PORT_'+$port+'_LISTENERS='+$pids.Count)
    if ($pids.Count -ne 1) {
        Write-Output ('PORT_'+$port+'_STATE=UNEXPECTED')
        continue
    }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($pids[0])" -ErrorAction SilentlyContinue
    if (!$proc) {
        Write-Output ('PORT_'+$port+'_STATE=PROCESS_NOT_RESOLVED')
        continue
    }
    $role = [string]$entry.Role
    $scriptFile = ScriptPath ([string]$proc.CommandLine) $(if ($role -eq 'portal') {'portal'} else {'cli'})
    $observed[$role] = $proc
    Write-Output ('PORT_'+$port+'_PROCESS='+$proc.Name)
    Write-Output ('PORT_'+$port+'_PID='+$proc.ProcessId)
    Write-Output ('PORT_'+$port+'_SCRIPT='+$(if ($scriptFile) {$scriptFile} else {'NOT_RESOLVED'}))
    Write-Output ('PORT_'+$port+'_SCRIPT_SHA256='+(ItemHash $scriptFile))
    Write-Output ('PORT_'+$port+'_SCRIPT_ACL='+ (WorldWritable $scriptFile))
    $localOnly = @($bound | Where-Object {$_.LocalAddress -notin @('127.0.0.1','::1')}).Count -eq 0
    Write-Output ('PORT_'+$port+'_LOOPBACK_ONLY='+$localOnly)
}

if ($observed.ContainsKey('relay')) {
    $relay = $observed['relay']
    foreach ($flag in @('--auth-config','--state-file','--owner-authority-config')) {
        $file = ArgPath ([string]$relay.CommandLine) $flag
        $name = $flag.TrimStart('-').Replace('-','_').ToUpperInvariant()
        Write-Output ('RELAY_'+$name+'_DECLARED='+[bool]$file)
        if ($file) {
            Write-Output ('RELAY_'+$name+'_SHA256='+(ItemHash $file))
            Write-Output ('RELAY_'+$name+'_ACL='+(WorldWritable $file))
        }
    }
}

if ($observed.ContainsKey('portal')) {
    $p = ScriptPath ([string]$observed['portal'].CommandLine) 'portal'
    if ($p) {
        $public = Join-Path (Split-Path $p -Parent) 'public'
        $html = ItemHash (Join-Path $public 'index.html')
        $font = ItemHash (Join-Path $public 'tp-font.woff2')
        Write-Output ('PORTAL_PRIVATE_HTML_SHA256='+$html)
        Write-Output ('PORTAL_PRIVATE_HTML_ACCEPTED_MATCH='+($html -eq '4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8'))
        Write-Output ('PORTAL_PRIVATE_FONT_SHA256='+$font)
        Write-Output ('PORTAL_PRIVATE_FONT_ACCEPTED_MATCH='+($font -eq '18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e'))
    }
}

Write-Output '=== TETHERPLANE TASK STATES (ARGUMENTS REDACTED) ==='
$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {$_.TaskName -match '(?i)Tetherplane'})
foreach ($t in $tasks) {
    $details = Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue
    Write-Output ('TASK='+$t.TaskName+' STATE='+$t.State+' LAST_RESULT='+$details.LastTaskResult+
                  ' ACTION_COUNT='+@($t.Actions).Count+' ARGUMENTS_REDACTED=true')
}

Write-Output '=== AGENT METADATA (ARGUMENTS REDACTED) ==='
$agents = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe'")
Write-Output ('AGENT_COUNT='+$agents.Count)
foreach ($a in $agents) {
    $id = ArgPath ([string]$a.CommandLine) '--device-id'
    Write-Output ('AGENT_PID='+$a.ProcessId+' DEVICE_ID='+$(if ($id) {$id} else {'UNKNOWN'})+
                  ' EXECUTABLE_SHA256='+(ItemHash ([string]$a.ExecutablePath))+
                  ' STARTED='+$a.CreationDate+' ARGUMENTS_REDACTED=true')
}

Write-Output '=== LOCAL AUTH HEALTH ==='
try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8790/healthz' -UseBasicParsing -TimeoutSec 5
    Write-Output ('AUTH_HEALTH_HTTP='+$response.StatusCode)
} catch { Write-Output 'AUTH_HEALTH=UNVERIFIED' }

Write-Output '=== TAILSCALE SERVICE ==='
$service = Get-Service -Name Tailscale -ErrorAction SilentlyContinue
Write-Output ('TAILSCALE_SERVICE='+$(if ($service) {$service.Status} else {'UNKNOWN'}))
Write-Output 'PREFLIGHT_COMPLETE: READ-ONLY. NO RELEASE AUTHORIZED.'
