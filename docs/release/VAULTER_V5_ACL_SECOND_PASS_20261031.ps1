#requires -Version 5.1
<#
VAULTER V5 Control Center ACL second pass.
Read-only, no secret values, no task arguments, no process mutation.
The original 2026-10-31 preflight used a broad bitmask that treated Read
as Write. This check uses write-specific FileSystemRights bits.
#>
[CmdletBinding()]
param([switch]$SelfTest)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-WriteMask {
    $names = @(
      'WriteData', 'AppendData', 'WriteExtendedAttributes', 'WriteAttributes',
      'DeleteSubdirectoriesAndFiles', 'Delete', 'ChangePermissions', 'TakeOwnership'
    )
    $mask = [long]0
    foreach ($name in $names) {
        $part = [long][Enum]::Parse([System.Security.AccessControl.FileSystemRights], $name)
        $mask = $mask -bor $part
    }
    return $mask
}
$WriteMask = New-WriteMask

function HasWriteBits([System.Security.AccessControl.FileSystemRights]$rights) {
    return (([long]$rights -band $WriteMask) -ne 0)
}

if ($SelfTest) {
    foreach ($read in @('Read','ReadAndExecute','Synchronize','ReadPermissions')) {
        if (HasWriteBits ([Enum]::Parse([System.Security.AccessControl.FileSystemRights], $read))) {
            throw ('FALSE_POSITIVE_READ_PERMISSION='+$read)
        }
    }
    foreach ($write in @('Write','Modify','FullControl','WriteData','ChangePermissions','TakeOwnership')) {
        if (!(HasWriteBits ([Enum]::Parse([System.Security.AccessControl.FileSystemRights], $write)))) {
            throw ('FALSE_NEGATIVE_WRITE_PERMISSION='+$write)
        }
    }
    Write-Output 'ACL_MASK_SELFTEST=PASS'
    Write-Output ('ACL_WRITE_MASK='+$WriteMask)
    return
}

if ($env:COMPUTERNAME -ine 'VAULTER') {
    throw 'HOST_MISMATCH: run this inspection locally on VAULTER.'
}

$root = 'C:\ProgramData\Tetherplane'
$releaseRoot = Join-Path $root 'ControlCenterReleases'
$release = Join-Path $releaseRoot '20261025-effective-access-09ea09b'
$portal = Join-Path $release 'oauth.mjs'
$expected = 'afab023ea2de6d64d717314082c0d3c1f919ef1d84d426cf1bd9212b612f0a59'

if (!(Test-Path -LiteralPath $portal -PathType Leaf)) {
    throw 'Expected V5 oauth.mjs is missing. No ACL interpretation possible.'
}
$actual = (Get-FileHash -LiteralPath $portal -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -cne $expected) {
    throw 'V5 script hash has changed since the read-only preflight. Stop and re-verify provenance.'
}

$wellKnownBroad = @{
    'S-1-1-0' = 'EVERYONE'
    'S-1-5-11' = 'AUTHENTICATED_USERS'
    'S-1-5-32-545' = 'BUILTIN_USERS'
    'S-1-5-32-546' = 'BUILTIN_GUESTS'
}

function Report-Acl([string]$label, [string]$itemPath) {
    Write-Output ('=== '+$label+' ===')
    if (!(Test-Path -LiteralPath $itemPath)) {
        Write-Output 'PATH_STATUS=MISSING'
        return
    }
    $item = Get-Item -LiteralPath $itemPath -Force
    $acl = Get-Acl -LiteralPath $itemPath
    $kind = if ($item.PSIsContainer) { 'DIRECTORY' } else { 'FILE' }
    Write-Output ('TYPE='+$kind)
    Write-Output ('PROTECTED_FROM_INHERITANCE='+$acl.AreAccessRulesProtected)

    $allowWrite = 0
    $denyWrite = 0
    $broadRead = 0
    $unknownCount = 0
    foreach ($ace in $acl.Access) {
        $sid = try {
            $ace.IdentityReference.Translate(
                [System.Security.Principal.SecurityIdentifier]
            ).Value
        } catch { $null }
        if (!$sid) { $unknownCount++; continue }
        if (!$wellKnownBroad.ContainsKey($sid)) { continue }
        $group = $wellKnownBroad[$sid]
        $write = HasWriteBits $ace.FileSystemRights
        $type = [string]$ace.AccessControlType
        if ($write) {
            if ($type -eq 'Allow') { $allowWrite++ }
            else { $denyWrite++ }
        } else { $broadRead++ }

        Write-Output (
          'BROAD_ACE_GROUP='+$group+
          ' TYPE='+$type+
          ' RIGHTS='+$ace.FileSystemRights+
          ' WRITE_BITS='+$write+
          ' INHERITED='+$ace.IsInherited+
          ' INHERITANCE_FLAGS='+$ace.InheritanceFlags+
          ' PROPAGATION_FLAGS='+$ace.PropagationFlags
        )
    }
    Write-Output ('BROAD_WRITE_ALLOW_ACE_COUNT='+$allowWrite)
    Write-Output ('BROAD_WRITE_DENY_ACE_COUNT='+$denyWrite)
    Write-Output ('BROAD_NONWRITE_ACE_COUNT='+$broadRead)
    Write-Output ('IDENTITY_TRANSLATION_FAILURES='+$unknownCount)
    $classification = if ($allowWrite -gt 0) {
        'BROAD_WRITE_ALLOW_ACE_REQUIRES_EFFECTIVE_RIGHTS_REVIEW'
    } elseif ($unknownCount -gt 0) {
        'INDETERMINATE_UNRESOLVED_PRINCIPALS'
    } else {
        'NO_BROAD_WRITE_ALLOW_ACE_FOUND'
    }
    Write-Output ('ACL_CLASSIFICATION='+$classification)
}

Write-Output '=== VAULTER V5 READ-ONLY ACL RECHECK ==='
Write-Output ('OBSERVED_UTC='+(Get-Date).ToUniversalTime().ToString('o'))
Write-Output ('SCRIPT_SHA256_MATCHES_ACCEPTED_V5='+($actual -ceq $expected))
Write-Output ('MASK_SELFTEST_HINT=run this script with -SelfTest on any Windows host')
Report-Acl 'CONTROL_CENTER_ROOT' $root
Report-Acl 'RELEASES_ROOT' $releaseRoot
Report-Acl 'ACCEPTED_V5_RELEASE_DIR' $release
Report-Acl 'V5_OAUTH_ENTRYPOINT' $portal
Report-Acl 'V5_PUBLIC_DIR' (Join-Path $release 'public')
Report-Acl 'V5_PUBLIC_HTML' (Join-Path $release 'public\index.html')
Report-Acl 'V5_PUBLIC_JS' (Join-Path $release 'public\tp-integration.js')

Write-Output '=== PROTECTED TASK METADATA (ARGUMENTS NOT DISPLAYED) ==='
foreach ($name in @(
  'Tetherplane Control Center OAuth 20261024',
  'Tetherplane Relay',
  'Tetherplane-TetherAuth-Startup'
)) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $name -TaskPath $task.TaskPath -ErrorAction Stop
    $xml = Export-ScheduledTask -TaskName $name -TaskPath $task.TaskPath
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($xml)
        $fingerprint = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
    } finally { $sha.Dispose() }
    Write-Output ('TASK='+$name+' STATE='+$task.State+
                  ' ACTION_COUNT='+@($task.Actions).Count+
                  ' LOGON_TYPE='+$task.Principal.LogonType+
                  ' RUN_LEVEL='+$task.Principal.RunLevel+
                  ' XML_SHA256='+$fingerprint+
                  ' ACTION_ARGUMENTS=REDACTED')
}
Write-Output 'ACL_SECOND_PASS_COMPLETE: READ-ONLY. NO PERMISSIONS CHANGED.'
