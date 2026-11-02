// Source-review candidate only: explicit owner browser enrollment for the Store
// wizard. Nothing runs, listens, pairs or elevates on import or installation.
import { randomBytes } from "node:crypto";
import { execFile as callbackExecFile } from "node:child_process";
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertPrivateCredentialState } from "./state-security.mjs";

const execFile = promisify(callbackExecFile);
const REVOCATION_MARKER = "browser-enrollment.revoked";
const NAMES = Object.freeze([
  "browser-bridge.token",
  "browser-extension-launch.token",
  "browser-extension.id"
]);
export const OWNER_BROWSER_RPC_ADDRESS = "127.0.0.1:17657";

// Exactly the local owner extension ID, never a website origin or remote grant.
export function validateOwnerExtensionId(value) {
  if (typeof value !== "string" || !/^[a-p]{32}$/.test(value.trim())) {
    throw new Error("The installed extension ID must have exactly 32 letters a-p.");
  }
  return value.trim();
}

async function regularFile(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0) {
    throw new Error("Browser enrollment file needs owner review.");
  }
  return entry;
}

export async function assertPackagedBrowserAssets(packageRoot) {
  // Read-only, require all browser assets from the same packaged app. An
  // untrusted arbitrary browser path may never be submitted by the caller.
  for (const name of [
    "bin/tetherplane-browserw.exe",
    "browser/host.mjs",
    "browser/extension/manifest.json",
    "browser/extension/dist/background.js",
    "browser/extension/dist/pair.js"
  ]) {
    try {
      await regularFile(join(packageRoot, ...name.split("/")));
    } catch {
      throw new Error("The packaged browser host and extension are incomplete.");
    }
  }
  const manifest = JSON.parse(await readFile(
    join(packageRoot, "browser", "extension", "manifest.json"), "utf8"
  ));
  if (manifest?.background?.service_worker !== "dist/background.js") {
    throw new Error("The packaged browser extension does not match the reviewed contract.");
  }
}

const VERIFY_BROWSER_DACL = [
  "$ErrorActionPreference='Stop'",
  "$paths=$env:TP_BROWSER_PRIVATE_PATHS|ConvertFrom-Json",
  "$identity=[Security.Principal.WindowsIdentity]::GetCurrent()",
  "if($identity.IsSystem -or $null -eq $identity.User){throw 'Owner user required'}",
  "$allowed=@($identity.User.Value,'S-1-5-18')",
  "foreach($path in $paths){",
  "  $attrs=[IO.File]::GetAttributes($path)",
  "  if(($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or",
  "     ($attrs -band [IO.FileAttributes]::Directory) -ne 0){throw 'Bad browser state object'}",
  "  $acl=[IO.File]::GetAccessControl($path)",
  "  $seen=@()",
  "  foreach($rule in $acl.Access){",
  "    $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value",
  "    if($allowed -notcontains $sid -or $rule.AccessControlType -ne 'Allow'){throw 'Untrusted browser ACL'}",
  "    $seen+=$sid",
  "  }",
  "  if($seen -notcontains $identity.User.Value -or $seen -notcontains 'S-1-5-18'){",
  "    throw 'Browser ACL missing owner or SYSTEM'",
  "  }",
  "}",
  "'TP_OWNER_BROWSER_ACL_OK'"
].join("\n");

async function checkBrowserFileAccess(paths) {
  if (process.platform !== "win32") return;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot || !/^[a-z]:[\\/]/i.test(systemRoot)) {
    throw new Error("Windows system directory unavailable.");
  }
  try {
    const { stdout } = await execFile(
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", VERIFY_BROWSER_DACL],
      {
        windowsHide: true, timeout: 8_000, maxBuffer: 32_768,
        env: { ...process.env, TP_BROWSER_PRIVATE_PATHS: JSON.stringify(paths) }
      }
    );
    if (!stdout.includes("TP_OWNER_BROWSER_ACL_OK")) throw new Error("ACL check incomplete");
  } catch {
    throw new Error("Protected browser enrollment permissions need owner review.");
  }
}

export async function isOwnerBrowserRevoked(stateRoot) {
  const marker = join(stateRoot, REVOCATION_MARKER);
  try {
    const entry = await lstat(marker);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Invalid revocation marker.");
    await checkBrowserFileAccess([marker]);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("Browser revocation state needs owner review.");
  }
}

// Create the durable denial FIRST. An already-running host must check
// this marker before every authenticated RPC, not merely on startup.
export async function revokeOwnerBrowser(stateRoot) {
  await assertPrivateCredentialState(stateRoot);
  if (await isOwnerBrowserRevoked(stateRoot)) {
    return { revoked: true, alreadyRevoked: true, credentialFilesRemoved: false };
  }
  // An unenrolled owner must not be permanently locked out by accidentally
  // pressing Revoke. Partially present state is still marked revoked.
  let hasBrowserState = false;
  for (const name of NAMES) {
    try {
      await lstat(join(stateRoot, name));
      hasBrowserState = true;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error("Browser state needs owner review.");
    }
  }
  if (!hasBrowserState) {
    return { revoked: false, alreadyRevoked: false, credentialFilesRemoved: false };
  }
  const marker = join(stateRoot, REVOCATION_MARKER);
  await writeFile(marker, "revoked\n", { flag: "wx", mode: 0o600 });
  // Never roll back the denial marker after it has been created.
  await checkBrowserFileAccess([marker]);
  const existing = [];
  for (const name of NAMES) {
    const file = join(stateRoot, name);
    try {
      await regularFile(file);
      existing.push(file);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error("Browser revoked; credential cleanup needs owner review.");
      }
    }
  }
  if (existing.length) await checkBrowserFileAccess(existing);
  // These are exactly the owner-approved browser credentials, never the
  // separately paired device credential. A foreign file is never removed.
  for (const file of existing) {
    try { await unlink(file); }
    catch { throw new Error("Browser revoked; credential cleanup needs owner review."); }
  }
  return {
    revoked: true,
    alreadyRevoked: false,
    credentialFilesRemoved: existing.length === NAMES.length,
  };
}

export async function readOwnerBrowserEnrollment(stateRoot) {
  if (await isOwnerBrowserRevoked(stateRoot)) {
    throw new Error("Browser enrollment revoked; manual owner recovery required.");
  }
  const paths = NAMES.map(name => join(stateRoot, name));
  let present = 0;
  for (const path of paths) {
    try {
      const info = await regularFile(path);
      if (info.size > 256) throw new Error("Oversized browser state");
      present++;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error("Browser enrollment needs owner review; existing files preserved.");
      }
    }
  }
  if (present === 0) return null;
  if (present !== paths.length) {
    throw new Error("Partial browser enrollment needs owner review; existing files preserved.");
  }
  await assertPrivateCredentialState(stateRoot);
  await checkBrowserFileAccess(paths);
  const [agentToken, extensionToken, extensionId] = await Promise.all(
    paths.map(path => readFile(path, "utf8"))
  );
  if (agentToken.trim().length < 32 || extensionToken.trim().length < 32) {
    throw new Error("Browser enrollment token needs owner review.");
  }
  validateOwnerExtensionId(extensionId);
  return { enrolled: true };
}

export function ownerBrowserAgentArgs(stateRoot) {
  return [
    "--browser-bridge", OWNER_BROWSER_RPC_ADDRESS,
    "--browser-bridge-token-file", join(stateRoot, NAMES[0])
  ];
}

export async function enrollOwnerBrowser(stateRoot, packageRoot, extensionId) {
  if (await isOwnerBrowserRevoked(stateRoot)) {
    throw new Error("Previously revoked browser enrollment requires manual owner recovery.");
  }
  const id = validateOwnerExtensionId(extensionId);
  await assertPrivateCredentialState(stateRoot);
  await assertPackagedBrowserAssets(packageRoot);
  // Existing state is immutable here. Never replace a pinned browser,
  // silently rotate credentials, or adopt partial foreign enrollment.
  const paths = NAMES.map(name => join(stateRoot, name));
  for (const path of paths) {
    try {
      await lstat(path);
      throw new Error("Existing browser enrollment needs owner review.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const values = [
    randomBytes(32).toString("base64"),
    randomBytes(32).toString("base64"),
    id
  ];
  const written = [];
  try {
    for (let i = 0; i < paths.length; i++) {
      // Files inherit the already protected owner/SYSTEM-only state directory.
      // Windows DACLs are independently rechecked below before success.
      await writeFile(paths[i], values[i] + "\n", { flag: "wx", mode: 0o600 });
      written.push(paths[i]);
    }
    await checkBrowserFileAccess(paths);
    await readOwnerBrowserEnrollment(stateRoot);
  } catch {
    // Only undo files this exact attempt exclusively created; do not delete
    // existing pairings, foreign files, or the approved device identity.
    for (const path of written.reverse()) await unlink(path).catch(() => {});
    throw new Error("Owner browser enrollment failed; device identity preserved.");
  }
  return { enrolled: true, requiresExtensionPairing: true };
}
