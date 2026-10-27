param(
    [Parameter(Mandatory = $true)][string]$PackageFamilyName,
    [Parameter(Mandatory = $true)][string]$ExecutablePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Restricted to a disposable Windows PR runner, never an owner workstation.
if ($env:GITHUB_ACTIONS -cne 'true' -or
    $env:GITHUB_EVENT_NAME -cne 'pull_request' -or
    $env:RUNNER_OS -cne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    [string]::IsNullOrEmpty($env:GITHUB_HEAD_REF) -or
    -not $env:GITHUB_HEAD_REF.StartsWith('feature/msix-store-runtime-')) {
    throw 'MSIX_ACTIVATION_DENIED: disposable GitHub-hosted Windows PR required'
}
if ($PackageFamilyName -notmatch '^Tetherplane\.StoreRuntime\.DevOnly_[a-zA-Z0-9]+$' -or
    -not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    throw 'MSIX_ACTIVATION_DENIED: exact development identity and installed executable required'
}

# Windows native packaged-app activation, AO_NOERRORUI (2) in CI.
$source = @'
using System;
using System.Runtime.InteropServices;

namespace TetherplaneMsixActivation {
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IApplicationActivationManager {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options, out uint processId);
    }

    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    public class ApplicationActivationManager {}

    public static class Probe {
        public static int Launch(string aumid) {
            var manager = (IApplicationActivationManager)new ApplicationActivationManager();
            uint processId;
            int result = manager.ActivateApplication(aumid, null, 2, out processId);
            Marshal.ThrowExceptionForHR(result);
            if (processId == 0) throw new InvalidOperationException("Activation returned no PID");
            return checked((int)processId);
        }
    }
}
'@

$activatedProcessId = $null
$expectedPath = [IO.Path]::GetFullPath($ExecutablePath)
$verified = $false
try {
    Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
    $aumid = $PackageFamilyName + '!Runtime'
    $activatedProcessId = [TetherplaneMsixActivation.Probe]::Launch($aumid)

    for ($attempt = 0; $attempt -lt 8; $attempt++) {
        $p = Get-Process -Id $activatedProcessId -ErrorAction SilentlyContinue
        if ($null -eq $p) {
            Start-Sleep -Milliseconds 500
            continue
        }
        $observedPath = [string]$p.Path
        if (-not [string]::Equals($expectedPath, $observedPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Activated PID does not match installed package executable'
        }
        $verified = $true
        break
    }
    if (-not $verified) {
        throw 'Packaged app did not remain running long enough to verify its installed executable'
    }
    Write-Output 'MSIX_G2_PACKAGED_APP_ACTIVATION_PASS'
}
finally {
    if ($verified -and $null -ne $activatedProcessId) {
        # Never terminate a PID unless it matched the exact installed test image.
        Stop-Process -Id $activatedProcessId -Force -ErrorAction SilentlyContinue
    }
}
