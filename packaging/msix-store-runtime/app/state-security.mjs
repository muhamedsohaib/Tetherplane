import { execFile as callbackExecFile } from "node:child_process";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(callbackExecFile);
const CHILD_OPTIONS = Object.freeze({ windowsHide: true, timeout: 8_000, maxBuffer: 32_768 });

/**
 * Reserve a new directory and restrict its Windows DACL before placing any
 * device credential inside. The native tetherd agent continues to read the
 * exact same credential-file path as before; no relay/auth protocol changes.
 *
 * Existing Windows state is never chmod'ed, re-ACL'd, reset or overwritten.
 * A previously created directory with missing identity must be inspected for
 * recovery rather than being silently adopted. This deliberately does not
 * claim DPAPI encryption, or protection against same-user code/admins.
 */
export async function initializeCredentialDirectory(stateRoot) {
  if (!isAbsolute(stateRoot)) throw new Error("User-local state directory is required.");
  if (process.platform !== "win32") {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    return;
  }

  // The Windows Store runtime is per-user. Refuse UNC and drive-relative paths.
  // A hidden network share must never be accepted as a credential vault.
  if (!/^[A-Za-z]:[\\/](?![\\/])/.test(stateRoot))
    throw new Error("Windows device state must use a local absolute drive path.");

  let created = false;
  try {
    // No recursive mkdir on Windows: never adopt a pre-existing directory
    // with unknown DACL, nor change an existing owner's filesystem rights.
    await mkdir(stateRoot);
    created = true;
    const entry = await lstat(stateRoot);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("The new state path is not a regular directory.");

    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    if (!systemRoot || !/^[A-Za-z]:[\\/]/.test(systemRoot))
      throw new Error("Windows system directory cannot be authenticated.");

    const whoami = join(systemRoot, "System32", "whoami.exe");
    const icacls = join(systemRoot, "System32", "icacls.exe");
    const { stdout } = await execFile(whoami, ["/user", "/fo", "csv", "/nh"], CHILD_OPTIONS);
    const matches = stdout.match(/S-1-\d+(?:-\d+){2,}/g) || [];
    if (matches.length !== 1 || matches[0] === "S-1-5-18")
      throw new Error("A unique, ordinary Windows user SID is required.");

    // First remove inherited grants from this new folder, then grant only
    // its owning user and LocalSystem. OI/CI propagate to new state files.
    // All arguments are fixed/SID-validated, no shell, no execution-policy
    // change, no elevation, and no secrets in subprocess arguments.
    await execFile(icacls, [stateRoot, "/inheritance:r"], CHILD_OPTIONS);
    await execFile(icacls, [
      stateRoot, "/grant:r",
      "*" + matches[0] + ":(OI)(CI)F",
      "*S-1-5-18:(OI)(CI)F"
    ], CHILD_OPTIONS);
    await execFile(icacls, [stateRoot, "/verify"], CHILD_OPTIONS);
  } catch {
    // Remove only our own empty directory. Never delete a previous identity,
    // other users' files, or a directory that another process populated.
    if (created) await rmdir(stateRoot).catch(() => {});
    throw new Error(
      "Windows private device state could not be created. No credential was saved; " +
      "inspect local folder permissions before retrying."
    );
  }
}
