// Microsoft Store StartupTask entry: disabled by default until the owner opts
// in via Windows Startup settings. The exact saved identity must already have
// passed owner approval. This code neither pairs nor repairs credentials.
import { spawn } from "node:child_process";
import { appendFile, lstat, mkdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readSavedConfig, agentArgs } from "./runtime-app.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_FAILURES = 5;

export function requireNativeStartupParent(value, currentParent) {
  const parent = Number(value);
  if (!Number.isSafeInteger(parent) || parent <= 0 || parent !== currentParent) {
    throw new Error("Store startup requires its exact native parent.");
  }
  return parent;
}

async function recordSafeEvent(root, event) {
  // Whitelisted fixed labels only, no credential, relay address, local paths,
  // exception text or process arguments. Owner-private state was ACL-checked.
  if (!/^[A-Z_]{3,60}$/.test(event)) return;
  const path = join(root, "startup-events.log");
  try {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) return;
      if (info.size > MAX_EVENT_BYTES) {
        const previous = join(root, "startup-events.old");
        try {
          await lstat(previous);
          return; // Never overwrite or delete an existing owner file.
        } catch (error) {
          if (error.code !== "ENOENT") return;
        }
        await rename(path, previous);
      }
    } catch (error) {
      if (error.code !== "ENOENT") return;
    }
    await appendFile(path, new Date().toISOString() + " " + event + "\n", { mode: 0o600 });
  } catch {
    // Logging must not weaken or repair an authorization boundary.
  }
}

async function agentStateDirectory(stateRoot) {
  const path = join(stateRoot, "agent-state");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Agent state path needs owner review.");
  }
  return path;
}

async function runSupervisedAgent(config, stateRoot, executable, nativeParent) {
  const state = await agentStateDirectory(stateRoot);
  const args = [
    ...agentArgs(config, join(stateRoot, "device-credential.txt"), state),
    "--owner-instance-lock"
  ];
  let agent = null;
  let stopping = false;
  const stop = () => {
    stopping = true;
    if (agent?.pid && agent.exitCode === null) agent.kill();
  };
  const checkParent = setInterval(() => {
    try { process.kill(nativeParent, 0); }
    catch { stop(); }
  }, 500);
  checkParent.unref();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    for (let attempt = 0; attempt < MAX_FAILURES && !stopping; attempt++) {
      // No stale cached grant: verify state ACL, owner-approved config and
      // allowed root before every process launch, including crash recovery.
      const latest = await readSavedConfig(stateRoot);
      if (!latest || latest.deviceId !== config.deviceId ||
          latest.relayUrl !== config.relayUrl ||
          latest.allowRoot !== config.allowRoot) {
        throw new Error("Approved device identity changed; manual review required.");
      }
      const code = await new Promise(resolveExit => {
        let finished = false;
        const finish = value => {
          if (finished) return;
          finished = true;
          resolveExit(value);
        };
        try {
          agent = spawn(executable, args, {
            cwd: stateRoot, windowsHide: true, stdio: "ignore"
          });
          agent.once("exit", value => finish(value ?? 2));
          agent.once("error", () => finish(2));
        } catch {
          finish(2);
        }
      });
      agent = null;
      if (stopping) return;
      if (code === 73) {
        await recordSafeEvent(stateRoot, "AGENT_ALREADY_RUNNING");
        return;
      }
      if (code === 0) {
        await recordSafeEvent(stateRoot, "AGENT_STOPPED");
        return;
      }
      await recordSafeEvent(stateRoot, "AGENT_RETRY");
      if (attempt + 1 < MAX_FAILURES) {
        await delay(Math.min(1000 * 2 ** attempt, 16000));
      }
    }
    if (!stopping) await recordSafeEvent(stateRoot, "AGENT_RETRY_LIMIT");
  } finally {
    clearInterval(checkParent);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (agent?.pid && agent.exitCode === null) agent.kill();
  }
}

export async function startApprovedStoreAgent() {
  if (process.platform !== "win32") {
    throw new Error("Packaged Store startup requires Windows.");
  }
  if (process.argv.length !== 2) {
    throw new Error("Packaged startup takes no command-line arguments.");
  }
  const nativeParent = requireNativeStartupParent(
    process.env.TETHERPLANE_STORE_AUTOSTART_PARENT_PID, process.ppid
  );
  const local = process.env.LOCALAPPDATA;
  if (!local || !isAbsolute(local)) {
    throw new Error("Windows user-local state is unavailable.");
  }
  const stateRoot = join(local, "TetherplaneStore");
  // Missing device.json means no owner approval. Exit with no agent created.
  // readSavedConfig also denies bad DACLs, links, modified identity and
  // missing/invalid credential files without altering the old files.
  const config = await readSavedConfig(stateRoot);
  if (!config) return;
  const executable = join(packageRoot, "bin", "tetherd-agentw.exe");
  const entry = await lstat(executable);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("Approved packaged windowless agent is unavailable.");
  }
  await recordSafeEvent(stateRoot, "OWNER_STARTUP");
  await runSupervisedAgent(config, stateRoot, executable, nativeParent);
}

const main = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  await startApprovedStoreAgent().catch(() => {
    // No secrets, Windows security descriptors, paths or tokens in output.
    process.exitCode = 2;
  });
}
