import { execFile as callbackExecFile } from "node:child_process";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(callbackExecFile);
const CHILD_OPTIONS = Object.freeze({ windowsHide: true, timeout: 8_000, maxBuffer: 32_768 });

// Fixed .NET security-descriptor operation: no untrusted script, no shell,
// no secrets in arguments/environment, no execution-policy changes. Inline
// PowerShell is used only because Node's POSIX mode argument does not create
// a restrictive Windows DACL. Windows can still deny this under WDAC/CLM,
// in which case we fail closed without storing a device credential.
const PROTECT_NEW_WINDOWS_STATE = [
  "$ErrorActionPreference = 'Stop'",
  "$target = $env:TETHERPLANE_NEW_PRIVATE_STATE",
  "if ([string]::IsNullOrWhiteSpace($target)) { throw 'Missing new state path' }",
  "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
  "if ($identity.IsSystem -or $null -eq $identity.User) { throw 'Ordinary Windows user identity required' }",
  "$acl = New-Object System.Security.AccessControl.DirectorySecurity",
  "$acl.SetAccessRuleProtection($true, $false)",
  "$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
  "$propagate = [System.Security.AccessControl.PropagationFlags]::None",
  "$rights = [System.Security.AccessControl.FileSystemRights]::FullControl",
  "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
  "$ownerRule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity.User, $rights, $inherit, $propagate, $allow)",
  "$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')",
  "$systemRule = [System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, $rights, $inherit, $propagate, $allow)",
  "$acl.AddAccessRule($ownerRule)",
  "$acl.AddAccessRule($systemRule)",
  "[System.IO.Directory]::SetAccessControl($target, $acl)",
  "$actual = [System.IO.Directory]::GetAccessControl($target)",
  "if (-not $actual.AreAccessRulesProtected) { throw 'State ACL is still inherited' }",
  "$allowed = @($identity.User.Value, 'S-1-5-18')",
  "$seen = @()",
  "foreach ($entry in $actual.Access) {",
  "  $sid = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
  "  if ($allowed -notcontains $sid) { throw 'Unexpected ACL principal' }",
  "  if ($entry.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw 'Unexpected ACL deny entry' }",
  "  $seen += $sid",
  "}",
  "if ($seen -notcontains $identity.User.Value -or $seen -notcontains 'S-1-5-18') { throw 'Required ACL entries absent' }",
].join("\n");

/**
 * Create a new Windows owner/SYSTEM-private directory before any device
 * secret is saved. Existing folders are not adopted, deleted or re-ACL'd.
 *
 * The native agent continues reading its existing credential-file format.
 * This is not encryption and cannot protect from same-user code or admins.
 */
export async function initializeCredentialDirectory(stateRoot) {
  if (!isAbsolute(stateRoot)) throw new Error("User-local state directory is required.");
  if (process.platform !== "win32") {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    return;
  }
  if (!/^[A-Za-z]:[\\/](?![\\/])/.test(stateRoot))
    throw new Error("Windows state must use a local absolute drive path.");

  let created = false;
  try {
    // Never reuse pre-existing state with unverified DACL or alter its ACL.
    await mkdir(stateRoot);
    created = true;
    const entry = await lstat(stateRoot);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("New state path is not a regular directory.");

    const winRoot = process.env.SystemRoot || process.env.WINDIR;
    if (!winRoot || !/^[A-Za-z]:[\\/]/.test(winRoot))
      throw new Error("Windows system root unavailable.");
    const powershell = join(winRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

    // A new directory may have explicit grants as well as inherited grants.
    // Construct an exact DACL rather than merely removing inherited grants.
    await execFile(
      powershell, ["-NoProfile", "-NonInteractive", "-Command", PROTECT_NEW_WINDOWS_STATE],
      { ...CHILD_OPTIONS, env: { ...process.env, TETHERPLANE_NEW_PRIVATE_STATE: stateRoot } }
    );
  } catch {
    // Only remove an empty directory created in this invocation. Never touch
    // preexisting installation state or any directory populated by another.
    if (created) await rmdir(stateRoot).catch(() => {});
    throw new Error(
      "Windows private device state could not be created. No credential was saved; " +
      "inspect local folder permissions before retrying."
    );
  }
}
