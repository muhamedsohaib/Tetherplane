import {
  spawn,
  type ChildProcess,
} from "node:child_process";

export type ProcessCleanupHooks = {
  isProcessAlive?(pid: number): boolean;
  waitForPidExit?(
    pid: number,
    timeoutMs: number,
  ): Promise<void>;
  forceTerminateProcessTree?(
    pid: number,
  ): Promise<void>;
};

export async function stopOwnedChromiumProcesses(
  child: ChildProcess,
  browserPid: number | null,
  hooks: ProcessCleanupHooks = {},
): Promise<void> {
  const isAlive =
    hooks.isProcessAlive ?? isProcessAlive;
  const waitForExit =
    hooks.waitForPidExit ?? waitForPidExit;
  const forceTree =
    hooks.forceTerminateProcessTree ??
    forceTerminateProcessTree;

  const pids = new Set<number>();
  if (
    browserPid !== null &&
    Number.isSafeInteger(browserPid) &&
    browserPid > 0
  ) {
    pids.add(browserPid);
  }
  if (
    typeof child.pid === "number" &&
    Number.isSafeInteger(child.pid) &&
    child.pid > 0
  ) {
    pids.add(child.pid);
  }

  for (const pid of pids) {
    await waitForExit(pid, 250);
    if (!isAlive(pid)) {
      continue;
    }

    try {
      if (
        child.pid === pid &&
        child.exitCode === null
      ) {
        child.kill();
      } else {
        process.kill(pid);
      }
    } catch {
      // Process may exit between liveness check and termination.
    }

    await waitForExit(pid, 1_000);
    if (!isAlive(pid)) {
      continue;
    }

    await forceTree(pid);
    await waitForExit(pid, 2_000);
  }

  const childPid = child.pid;
  if (
    child.exitCode === null &&
    typeof childPid === "number" &&
    isAlive(childPid)
  ) {
    // Never let a failed cleanup pin the Node test/server process forever.
    // The process-tree force path above remains the primary cleanup.
    child.unref();
  }
}

async function forceTerminateProcessTree(
  pid: number,
): Promise<void> {
  if (process.platform === "win32") {
    await runBoundedProcess(
      "taskkill.exe",
      [
        "/PID",
        String(pid),
        "/T",
        "/F",
      ],
      5_000,
    );
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already exited or cannot be signaled.
  }
}

async function runBoundedProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  const child = spawn(
    executable,
    args,
    {
      stdio: "ignore",
      windowsHide: true,
    },
  );

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("exit", finish);
      child.off("error", finish);
      resolve();
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best effort only.
      }
      child.unref();
      finish();
    }, timeoutMs);

    child.once("exit", finish);
    child.once("error", finish);
  });
}

async function waitForPidExit(
  pid: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(25);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, delayMs),
  );
}
