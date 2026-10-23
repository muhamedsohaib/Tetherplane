import { execFile, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { performance } from "node:perf_hooks";

import { CdpBackendError } from "./cdp-backend.ts";

type EndpointState = "missing" | "unreadable" | "invalid" | "valid";
type Stage = "selected" | "profile" | "spawn" | "exit" | "close" | "endpoint" | "failure" | "cleanup" | "ready";
type StderrCategory = "profile_permission" | "profile_lock" | "sandbox" | "crash" | "devtools_listening" | "invalid_switch" | "missing_library" | "gpu";

// Only fixed labels, bounded counters and numeric versions cross this boundary.
// Raw stderr, executable/profile paths, command lines and endpoint URLs never do.
export type ChromiumStartupDiagnostic = {
  stage: Stage;
  elapsed_ms: number;
  spawned: boolean;
  exited: boolean;
  closed: boolean;
  exit_code: number | null;
  signal: "terminated" | "killed" | "other" | null;
  endpoint: EndpointState;
  stderr_bytes: number;
  stderr_capped: boolean;
  stderr_categories: StderrCategory[];
  source?: "environment" | "argument" | "discovery";
  family?: "chrome" | "edge" | "chromium" | "other";
  version?: string | null;
  profile_writable?: boolean;
  profile_removed?: boolean;
  launcher_stopped?: boolean | null;
  browser_process_stopped?: boolean | null;
  error_category?: "permission" | "not_found" | "not_directory" | "resource" | "other";
};

export function startupErrorCategory(error: unknown): NonNullable<ChromiumStartupDiagnostic["error_category"]> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (code === "ENOENT") return "not_found";
  if (code === "ENOTDIR" || code === "EEXIST") return "not_directory";
  if (code === "EMFILE" || code === "ENFILE" || code === "ENOMEM" || code === "ENOSPC") return "resource";
  return "other";
}

export class ChromiumStartupTelemetry {
  readonly #started = performance.now();
  readonly #sink: ((event: ChromiumStartupDiagnostic) => void) | undefined;
  #spawned = false;
  #exited = false;
  #closed = false;
  #exitCode: number | null = null;
  #signal: ChromiumStartupDiagnostic["signal"] = null;
  #endpoint: EndpointState = "missing";
  #endpointError: ChromiumStartupDiagnostic["error_category"];
  readonly #observedEndpoints = new Set<EndpointState>(["missing"]);
  #bytes = 0;
  #capped = false;
  #carry = "";
  readonly #categories = new Set<StderrCategory>();

  constructor(sink?: (event: ChromiumStartupDiagnostic) => void) { this.#sink = sink; }

  emit(stage: Stage, fields: Partial<Pick<ChromiumStartupDiagnostic, "source" | "family" | "version" | "profile_writable" | "profile_removed" | "launcher_stopped" | "browser_process_stopped" | "error_category">> = {}): void {
    try {
      this.#sink?.({ stage, elapsed_ms: Math.round(performance.now() - this.#started),
        spawned: this.#spawned, exited: this.#exited, closed: this.#closed,
        exit_code: this.#exitCode, signal: this.#signal, endpoint: this.#endpoint,
        stderr_bytes: this.#bytes, stderr_capped: this.#capped,
        stderr_categories: [...this.#categories], ...(this.#endpointError ? { error_category: this.#endpointError } : {}), ...fields });
    } catch { /* Diagnostics cannot change the launch result or cleanup. */ }
  }

  attach(child: ChildProcess): void {
    child.once("spawn", () => { this.#spawned = true; this.emit("spawn"); });
    child.once("exit", (code, signal) => {
      this.#exited = true; this.#exitCode = code;
      this.#signal = signal === null ? null : signal === "SIGTERM" ? "terminated" : signal === "SIGKILL" ? "killed" : "other";
      this.emit("exit");
    });
    child.once("close", () => { this.#closed = true; this.emit("close"); });
    child.on("error", () => {}); // The launcher's spawn waiter reports a sanitized error.
    child.stderr?.on("data", (chunk: Buffer) => this.stderr(chunk));
  }

  stderr(chunk: Buffer): void {
    const remaining = 16_384 - this.#bytes;
    this.#capped ||= chunk.length > remaining;
    if (remaining <= 0) return; // Keep draining the pipe after the scan budget.
    const scanned = chunk.subarray(0, remaining);
    this.#bytes += scanned.length;
    const text = this.#carry + scanned.toString("utf8").toLowerCase();
    const patterns: [StderrCategory, RegExp][] = [
      ["profile_permission", /access denied|permission denied|access is denied/],
      ["profile_lock", /processsingleton|singletonlock|profile.*in use/],
      ["sandbox", /sandbox/], ["crash", /fatal:|crashpad|exception/],
      ["devtools_listening", /devtools listening/],
      ["invalid_switch", /bad option|unknown (?:option|flag)|unrecognized (?:option|flag)/],
      ["missing_library", /error while loading shared libraries|dll.*not found/],
      ["gpu", /gpu process|gpu-process|gpu_init/],
    ];
    for (const [category, pattern] of patterns) if (pattern.test(text)) this.#categories.add(category);
    this.#carry = text.slice(-256);
  }

  endpoint(state: EndpointState, category?: ChromiumStartupDiagnostic["error_category"]): void {
    this.#endpoint = state;
    this.#endpointError = category;
    if (this.#observedEndpoints.has(state)) return;
    this.#observedEndpoints.add(state);
    this.emit("endpoint");
  }
}

export function observedProcessStopped(pid: number | null): boolean | null {
  if (pid === null) return null;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? true : null; }
}

// Read Windows PE metadata instead of starting a second Chrome (--version on
// Windows can launch a browser). Bound the helper and discard all raw output.
export async function chromiumFileVersion(executable: string): Promise<string | null> {
  return new Promise(resolve => {
    const windows = process.platform === "win32";
    execFile(windows ? "powershell.exe" : executable, windows ? [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-Item -LiteralPath $env:TETHERPLANE_VERSION_FILE).VersionInfo.FileVersion",
    ] : ["--version"], {
      windowsHide: true, timeout: 1_500, maxBuffer: 1_024,
      ...(windows ? { env: { ...process.env, TETHERPLANE_VERSION_FILE: executable } } : {}),
    }, (error, stdout) => {
      if (error) { resolve(null); return; }
      const match = stdout.trim().match(/^(?:(?:Google Chrome|Chromium|Microsoft Edge) )?(\d{1,4}\.\d{1,4}\.\d{1,6}\.\d{1,6})$/);
      resolve(match?.[1] ?? null);
    });
  });
}

export async function waitForDevToolsActivePort(options: {
  child: ChildProcess; portFile: string; timeoutMs: number;
  telemetry: ChromiumStartupTelemetry;
}): Promise<string> {
  const deadline = performance.now() + options.timeoutMs;
  while (performance.now() < deadline) {
    // Windows Edge can hand off to its browser process and exit zero before
    // publishing the endpoint. Observe that exit; readiness still requires the
    // dedicated profile's endpoint and a successful CDP connection in the caller.
    if ((options.child.exitCode !== null && options.child.exitCode !== 0) || options.child.signalCode !== null) {
      throw new CdpBackendError("provider_failure", "isolated Chromium exited before publishing a live DevTools endpoint");
    }
    try {
      const chunks: Buffer[] = [];
      const stream = createReadStream(options.portFile, {
        start: 0, end: 1_024,
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))),
      });
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      if ((options.child.exitCode !== null && options.child.exitCode !== 0) || options.child.signalCode !== null) {
        throw new CdpBackendError("provider_failure", "isolated Chromium exited before publishing a live DevTools endpoint");
      }
      if (performance.now() >= deadline) {
        throw new CdpBackendError("timeout", "timed out waiting for isolated Chromium DevTools endpoint");
      }
      const bytes = Buffer.concat(chunks);
      const raw = bytes.length > 1_024 ? "" : bytes.toString("utf8");
      const [portLine, pathLine] = raw.split(/\r?\n/).map(line => line.trim());
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && port <= 65_535 && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(pathLine ?? "")) {
        options.telemetry.endpoint("valid");
        return `ws://127.0.0.1:${port}${pathLine}`;
      }
      options.telemetry.endpoint("invalid");
    } catch (error) {
      if (error instanceof CdpBackendError) throw error;
      if ((error as Error).name === "AbortError" || performance.now() >= deadline) {
        throw new CdpBackendError("timeout", "timed out waiting for isolated Chromium DevTools endpoint");
      }
      options.telemetry.endpoint((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable", startupErrorCategory(error));
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new CdpBackendError("timeout", "timed out waiting for isolated Chromium DevTools endpoint");
}
