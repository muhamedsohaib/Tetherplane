# Developer-beta local notification identity only. No OAuth, scopes, services, or Windows policy changes.
# Supported per-user operations: Register, Status, Unregister.
[CmdletBinding()]
param(
    [ValidateSet('Register', 'Status', 'Unregister')][string]$Operation = 'Status',
    [string]$Executable = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$appId = 'ARCUSLabs.Tetherplane.DevBeta'
$description = 'Tetherplane developer beta toast diagnostic'
$link = Join-Path ([Environment]::GetFolderPath('Programs')) 'Tetherplane Developer Beta.lnk'

# The classic desktop toast API requires a Start-menu shortcut with an explicit AUMID.
# No registry edits, UAC elevation, packaged identity, StartupTask or auto-run.
$interop = @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, Pack=4)]
public struct TPPropertyKey { public Guid format; public uint id; }
[StructLayout(LayoutKind.Explicit, Size=24)]
public struct TPPropVariant {
    [FieldOffset(0)] public ushort type;
    [FieldOffset(8)] public IntPtr value;
}
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface TPPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out TPPropertyKey key);
    [PreserveSig] int GetValue(ref TPPropertyKey key, out TPPropVariant value);
    [PreserveSig] int SetValue(ref TPPropertyKey key, ref TPPropVariant value);
    [PreserveSig] int Commit();
}
public static class TPShortcutAppId {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=true)]
    private static extern int SHGetPropertyStoreFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string name,
        IntPtr bindCtx, uint flags, ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out TPPropertyStore store);
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref TPPropVariant value);
    private static TPPropertyKey Key() {
        return new TPPropertyKey { format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), id = 5 };
    }
    private static TPPropertyStore Open(string path, bool write) {
        Guid iid = typeof(TPPropertyStore).GUID;
        TPPropertyStore store;
        int hr=SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, write ? 2u : 0u, ref iid, out store);
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        return store;
    }
    public static void Set(string path, string appId) {
        TPPropertyStore store=Open(path,true);
        TPPropVariant pv=new TPPropVariant();
        try {
            TPPropertyKey key=Key();
            pv.type=31; // VT_LPWSTR
            pv.value=Marshal.StringToCoTaskMemUni(appId);
            int hr=store.SetValue(ref key,ref pv);
            if(hr<0) Marshal.ThrowExceptionForHR(hr);
            hr=store.Commit();
            if(hr<0) Marshal.ThrowExceptionForHR(hr);
        } finally {
            if(pv.value!=IntPtr.Zero) Marshal.FreeCoTaskMem(pv.value);
            Marshal.ReleaseComObject(store);
        }
    }
    public static string Get(string path) {
        TPPropertyStore store=Open(path,false);
        TPPropVariant pv=new TPPropVariant();
        try {
            TPPropertyKey key=Key();
            int hr=store.GetValue(ref key,out pv);
            if(hr<0) Marshal.ThrowExceptionForHR(hr);
            return pv.type==31 && pv.value!=IntPtr.Zero ? Marshal.PtrToStringUni(pv.value) : "";
        } finally {
            PropVariantClear(ref pv);
            Marshal.ReleaseComObject(store);
        }
    }
}
'@
if (-not ('TPShortcutAppId' -as [type])) {
    Add-Type -TypeDefinition $interop -ErrorAction Stop
}
function Get-ShortcutDetails {
    if (-not (Test-Path -LiteralPath $link -PathType Leaf)) { return $null }
    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($link)
    return [pscustomobject]@{
        AppId = [TPShortcutAppId]::Get($link)
        Target = [string]$shortcut.TargetPath
        Description = [string]$shortcut.Description
        Path = $link
    }
}
function Assert-OwnedShortcut {
    param($Details)
    if ($null -eq $Details -or $Details.AppId -cne $appId -or
        $Details.Description -cne $description -or
        (Split-Path -Leaf $Details.Target) -cne 'tetherplane-toast-smoke.exe') {
        throw 'BETA_SHORTCUT_OWNERSHIP_UNVERIFIED: refusing to overwrite or delete an existing shortcut.'
    }
}
switch ($Operation) {
    'Status' {
        $existing = Get-ShortcutDetails
        if ($null -eq $existing) {
            Write-Output 'BETA_TOAST_SHORTCUT_MISSING'
        } elseif ($existing.AppId -cne $appId) {
            Write-Output 'BETA_TOAST_SHORTCUT_WRONG_APP_ID'
        } else {
            Write-Output 'BETA_TOAST_SHORTCUT_PRESENT'
            $existing | ConvertTo-Json -Compress
        }
    }
    'Register' {
        if (-not [IO.Path]::IsPathRooted($Executable) -or
            (Split-Path -Leaf $Executable) -cne 'tetherplane-toast-smoke.exe' -or
            -not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
            throw 'BETA_TOAST_EXECUTABLE_REQUIRED: provide an existing absolute tetherplane-toast-smoke.exe path.'
        }
        $exe = (Resolve-Path -LiteralPath $Executable).Path
        $existing = Get-ShortcutDetails
        if ($null -ne $existing) {
            Assert-OwnedShortcut $existing
            if (-not [string]::Equals($existing.Target,$exe,[StringComparison]::OrdinalIgnoreCase)) {
                throw 'BETA_TOAST_DIFFERENT_TARGET: refusal to overwrite a previously registered beta shortcut.'
            }
            Write-Output 'BETA_TOAST_SHORTCUT_ALREADY_REGISTERED'
            break
        }
        $wsh = New-Object -ComObject WScript.Shell
        $shortcut = $wsh.CreateShortcut($link)
        $shortcut.TargetPath = $exe
        $shortcut.Arguments = '--smoke --developer-beta'
        $shortcut.Description = $description
        $shortcut.WorkingDirectory = (Split-Path -Parent $exe)
        $shortcut.Save()
        try {
            [TPShortcutAppId]::Set($link, $appId)
            if ([TPShortcutAppId]::Get($link) -cne $appId) {
                throw 'BETA_TOAST_SHORTCUT_APP_ID_VERIFICATION_FAILED'
            }
        } catch {
            Remove-Item -LiteralPath $link -ErrorAction SilentlyContinue
            throw
        }
        Write-Output 'BETA_TOAST_SHORTCUT_REGISTERED'
    }
    'Unregister' {
        $existing = Get-ShortcutDetails
        if ($null -eq $existing) { Write-Output 'BETA_TOAST_SHORTCUT_ALREADY_ABSENT'; break }
        Assert-OwnedShortcut $existing
        Remove-Item -LiteralPath $link -ErrorAction Stop
        Write-Output 'BETA_TOAST_SHORTCUT_REMOVED'
    }
}
