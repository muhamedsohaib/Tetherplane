import { execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { closeChromiumFromProfile, readChromiumBrowserEndpoint } from "./chromium-debug-port.ts";
import { windowsChromiumImageName } from "./chromium-image-name.ts";

export type ObservedTestChromium = {
  child: ChildProcess;
  diagnostics(): string;
};

/** Observe only a child we created. Capture a bounded, redacted startup excerpt. */
export function observeTestChromium(child: ChildProcess): ObservedTestChromium {
  let stderr = "";
  let launchError = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString("utf8")).slice(-1024);
  });
  child.on("error", (error) => {
    launchError = error.message.slice(0, 256);
  });
  return {
    child,
    diagnostics() {
      const exit = child.exitCode !== null
        ? "exit code " + child.exitCode
        : child.signalCode !== null
          ? "signal " + child.signalCode
          : "still running";
      // No browser URLs, authorization codes, or arbitrary raw output in CI logs.
      const excerpt = stderr
        .replace(/https?:\/\/[^\s]+/g, "[redacted-url]")
        .replace(/(?:bearer\s+|token[=:]\s*)[^\s]+/gi, "[redacted-secret]")
        .replace(/[\r\n]+/g, " ")
        .slice(-700);
      return [exit, launchError && "spawn error: " + launchError, excerpt && "browser stderr: " + excerpt]
        .filter(Boolean)
        .join("; ");
    },
  };
}

/** Never connect to a browser endpoint not identified by our private profile. */
export async function waitForTestChromiumDebugger(
  profileDir: string,
  browser: ObservedTestChromium,
  timeoutMs = 20_000,
): Promise<{ port: number }> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "profile endpoint not created";
  while (Date.now() < deadline) {
    try {
      const { port, browserPath } = await readChromiumBrowserEndpoint(profileDir);
      const response = await fetch("http://127.0.0.1:" + port + "/json/version", {
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) throw new Error("DevTools discovery returned HTTP " + response.status);
      const version = await response.json() as { webSocketDebuggerUrl?: string };
      const endpoint = new URL(version.webSocketDebuggerUrl ?? "");
      if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" ||
          Number(endpoint.port) !== port || endpoint.pathname !== browserPath) {
        throw new Error("DevTools browser endpoint does not match test-owned profile");
      }
      return { port };
    } catch (error) {
      lastReason = error instanceof Error ? error.message.slice(0, 120) : "unknown endpoint error";
    }
    if (browser.child.exitCode !== null && browser.child.exitCode !== 0 ||
        browser.child.signalCode !== null) {
      // The close event flushes any buffered startup diagnostics from stderr.
      await Promise.race([new Promise<void>((resolve) => browser.child.once("close", () => resolve())), delay(150)]);
      throw new Error("private Chromium DevTools endpoint unavailable: " + browser.diagnostics() + "; " + lastReason);
    }
    await delay(Math.min(200, Math.max(1, deadline - Date.now())));
  }
  throw new Error("private Chromium DevTools endpoint unavailable after " + timeoutMs +
    "ms: " + browser.diagnostics() + "; " + lastReason);
}

async function awaitDirectChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", completed);
      reject(new Error("owned Chromium launcher did not exit"));
    }, timeoutMs);
    function completed() { clearTimeout(timer); resolve(); }
    child.once("exit", completed);
  });
}

function countProfileBrowsers(profileDir: string, browserImage: string): number {
  if (process.platform === "win32") {
    const imageName = windowsChromiumImageName(browserImage);
    const literal = profileDir.replaceAll("'", "''");
    const count = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "@(Get-CimInstance Win32_Process -Filter \"Name='" + imageName +
        "'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" + literal + "') }).Count",
    ], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
    if (!/^\d+$/.test(count)) throw new Error("invalid test-owned browser process audit result");
    return Number(count);
  }
  if (process.platform === "linux") {
    const output = execFileSync("ps", ["-eo", "comm=,args="], {
      encoding: "utf8", timeout: 5000,
    });
    const ownedFlag = "--user-data-dir=" + profileDir;
    return output.split(/\r?\n/).filter((line) => {
      const match = /^(\S+)\s+(.+)$/.exec(line.trim());
      return !!match && /^(?:chrome|chromium|msedge|headless_shell|chrome-headless.*)$/i.test(match[1]!) &&
        match[2]!.includes(ownedFlag);
    }).length;
  }
  throw new Error("test-owned browser process audit is unavailable on this OS");
}

/** Teardown remains fail-closed, but a browser that never started has no CDP socket to close. */
export async function stopTestChromium(
  profileDir: string,
  browser: ObservedTestChromium,
  browserImage: string,
  timeoutMs = 10_000,
  auditProfileProcesses: (ownedProfile: string, image: string) => number = countProfileBrowsers,
): Promise<void> {
  const hasEndpoint = existsSync(join(profileDir, "DevToolsActivePort"));
  if (hasEndpoint) {
    await closeChromiumFromProfile(profileDir, timeoutMs);
  } else if (browser.child.exitCode === null && browser.child.signalCode === null && browser.child.pid !== undefined) {
    // The handle refers to the direct child we spawned, never a discovered/recycled PID.
    if (!browser.child.kill()) throw new Error("unable to terminate test-owned Chromium launcher");
    await awaitDirectChildExit(browser.child, timeoutMs);
  }
  const deadline = Date.now() + timeoutMs;
  let remaining = 0;
  do {
    remaining = auditProfileProcesses(profileDir, browserImage);
    if (remaining === 0) return;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error("test-owned Chromium profile still has " + remaining + " running browser processes");
}
