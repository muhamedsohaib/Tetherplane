import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  accessSync,
  constants as fsConstants,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";

import {
  CdpBackendError,
  buildIsolatedChromiumArgs,
  type CdpControl,
  type CdpFrame,
  type CdpFrameObservation,
  type CdpTargetInfo,
} from "./cdp-backend.ts";
import type {
  RawBrowserDiagnosticEvent,
  RawBrowserDownload,
} from "./operations.ts";

type CdpResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: {
    code?: number;
    message?: string;
    data?: string;
  };
  sessionId?: string;
  method?: string;
  params?: Record<string, unknown>;
};

type PendingRequest = {
  resolve(value: Record<string, unknown>): void;
  reject(error: CdpBackendError): void;
};

type CdpEventListener = (event: {
  sessionId?: string;
  method: string;
  params: Record<string, unknown>;
}) => void;

class CdpWire {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #eventListeners = new Set<CdpEventListener>();
  #nextId = 1;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;

    socket.on("message", (data) => {
      this.#handleMessage(String(data));
    });
    socket.once("close", () => {
      this.#disconnect(
        new CdpBackendError(
          "provider_failure",
          "CDP browser connection closed",
        ),
      );
    });
    socket.once("error", (error) => {
      this.#disconnect(
        new CdpBackendError(
          "provider_failure",
          `CDP browser connection failed: ${error.message}`,
        ),
      );
    });
  }

  static async connect(url: string): Promise<CdpWire> {
    const socket = new WebSocket(url);
    await Promise.race([
      once(socket, "open").then(() => undefined),
      once(socket, "error").then(([error]) =>
        Promise.reject(error),
      ),
    ]);
    return new CdpWire(socket);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new CdpBackendError(
          "provider_failure",
          "CDP browser connection is not open",
        ),
      );
    }

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      } catch (error) {
        this.#pending.delete(id);
        reject(
          new CdpBackendError(
            "provider_failure",
            error instanceof Error
              ? error.message
              : "failed to send CDP request",
          ),
        );
      }
    });
  }

  onEvent(listener: CdpEventListener): void {
    this.#eventListeners.add(listener);
  }

  offEvent(listener: CdpEventListener): void {
    this.#eventListeners.delete(listener);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#socket.close();
    this.#rejectPending(
      new CdpBackendError(
        "provider_failure",
        "CDP browser connection closed",
      ),
    );
  }

  #handleMessage(text: string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(text) as CdpResponse;
    } catch {
      return;
    }

    if (typeof message.id !== "number") {
      if (typeof message.method === "string") {
        const event = {
          ...(message.sessionId
            ? { sessionId: message.sessionId }
            : {}),
          method: message.method,
          params: message.params ?? {},
        };
        for (const listener of this.#eventListeners) {
          listener(event);
        }
      }
      return;
    }

    const pending = this.#pending.get(message.id);
    if (!pending) {
      return;
    }
    this.#pending.delete(message.id);

    if (message.error) {
      pending.reject(
        new CdpBackendError(
          "provider_failure",
          [
            message.error.message ?? "CDP command failed",
            message.error.data,
          ]
            .filter(Boolean)
            .join(": "),
        ),
      );
      return;
    }

    pending.resolve(message.result ?? {});
  }

  #disconnect(error: CdpBackendError): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#rejectPending(error);
  }

  #rejectPending(error: CdpBackendError): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export const DEFAULT_CDP_LAUNCH_TIMEOUT_MS = 20_000;

export type LaunchedCdpControl = CdpControl & {
  readonly profile_dir: string;
  readonly executable_path: string;
};

class OwnedChromiumControl implements LaunchedCdpControl {
  readonly profile_dir: string;
  readonly executable_path: string;

  readonly #child: ChildProcess;
  readonly #wire: CdpWire;
  readonly #browserPid: number | null;
  readonly #downloadDir: string;
  readonly #sessions = new Map<string, string>();
  readonly #sessionTargets = new Map<string, string>();
  readonly #diagnosticsEnabled = new Set<string>();
  readonly #diagnosticsByTarget = new Map<
    string,
    RawBrowserDiagnosticEvent[]
  >();
  readonly #downloadsByGuid = new Map<
    string,
    {
      guid: string;
      url: string;
      suggested_filename: string;
      state: RawBrowserDownload["state"];
      bytes_received: number;
      total_bytes: number | null;
    }
  >();
  readonly #eventListener: CdpEventListener;
  #closed = false;

  constructor(options: {
    child: ChildProcess;
    wire: CdpWire;
    profileDir: string;
    downloadDir: string;
    executablePath: string;
    browserPid: number | null;
  }) {
    this.#child = options.child;
    this.#wire = options.wire;
    this.#browserPid = options.browserPid;
    this.#downloadDir = options.downloadDir;
    this.profile_dir = options.profileDir;
    this.executable_path = options.executablePath;
    this.#eventListener = (event) => {
      this.#handleCdpEvent(event);
    };
    this.#wire.onEvent(this.#eventListener);
  }

  async createTarget(
    url: string,
    background: boolean,
  ): Promise<string> {
    const result = await this.#wire.send(
      "Target.createTarget",
      {
        url: "about:blank",
        background,
      },
    );
    const targetId = requiredString(result, "targetId");
    await this.#navigateAndWait(targetId, url);
    return targetId;
  }

  async listTargets(): Promise<CdpTargetInfo[]> {
    const result = await this.#wire.send("Target.getTargets");
    const infos = result.targetInfos;
    if (!Array.isArray(infos)) {
      throw new CdpBackendError(
        "provider_failure",
        "CDP Target.getTargets returned invalid targetInfos",
      );
    }

    return infos
      .filter(isRecord)
      .map((info) => ({
        target_id:
          typeof info.targetId === "string"
            ? info.targetId
            : "",
        type:
          typeof info.type === "string" ? info.type : "",
        url: typeof info.url === "string" ? info.url : "",
      }))
      .filter(
        (info) =>
          info.target_id.length > 0 &&
          info.type.length > 0,
      );
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.#wire.send("Target.closeTarget", {
      targetId,
    });
    const sessionId = this.#sessions.get(targetId);
    if (sessionId) {
      this.#sessionTargets.delete(sessionId);
    }
    this.#sessions.delete(targetId);
    this.#diagnosticsEnabled.delete(targetId);
    this.#diagnosticsByTarget.delete(targetId);
  }

  async navigateTarget(
    targetId: string,
    url: string,
  ): Promise<void> {
    await this.#navigateAndWait(targetId, url);
  }

  async frames(targetId: string): Promise<CdpFrame[]> {
    const sessionId = await this.#sessionForTarget(targetId);
    const result = await this.#wire.send(
      "Page.getFrameTree",
      {},
      sessionId,
    );
    if (!isRecord(result.frameTree)) {
      throw new CdpBackendError(
        "provider_failure",
        "CDP Page.getFrameTree returned no frame tree",
      );
    }

    const frames: CdpFrame[] = [];
    flattenFrameTree(result.frameTree, null, frames);
    return frames;
  }

  async observeFrame(
    targetId: string,
    frameId: string,
  ): Promise<CdpFrameObservation> {
    const sessionId = await this.#sessionForTarget(targetId);
    const contextId = await this.#isolatedWorld(
      sessionId,
      frameId,
    );
    const result = await this.#wire.send(
      "Runtime.evaluate",
      {
        expression: `(${collectCdpFrameObservation.toString()})()`,
        contextId,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
    );
    return parseFrameObservation(
      evaluationValue(result),
    );
  }

  async performFrame(
    targetId: string,
    frameId: string,
    selectorToken: string,
    action: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = await this.#sessionForTarget(targetId);
    const contextId = await this.#isolatedWorld(
      sessionId,
      frameId,
    );
    const expression =
      `(${performCdpFrameAction.toString()})` +
      `(${JSON.stringify(selectorToken)},${JSON.stringify(action)})`;
    const result = await this.#wire.send(
      "Runtime.evaluate",
      {
        expression,
        contextId,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
    );
    const value = evaluationValue(result);
    if (!isRecord(value) || value.ok !== true) {
      throw new CdpBackendError(
        isRecord(value) && typeof value.code === "string"
          ? value.code
          : "provider_failure",
        isRecord(value) && typeof value.message === "string"
          ? value.message
          : "CDP browser action failed",
      );
    }
  }

  async uploadFile(
    targetId: string,
    frameId: string,
    selectorToken: string,
    filePath: string,
  ): Promise<void> {
    if (!selectorToken.startsWith("css:")) {
      throw new CdpBackendError(
        "stale_reference",
        "CDP upload selector is invalid",
      );
    }

    const sessionId = await this.#sessionForTarget(targetId);
    const contextId = await this.#isolatedWorld(
      sessionId,
      frameId,
    );
    await this.#wire.send("DOM.enable", {}, sessionId);

    const selector = selectorToken.slice("css:".length);
    const evaluated = await this.#wire.send(
      "Runtime.evaluate",
      {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        contextId,
        returnByValue: false,
      },
      sessionId,
    );
    if (evaluated.exceptionDetails) {
      throw new CdpBackendError(
        "stale_reference",
        "CDP upload selector evaluation failed",
      );
    }
    const remoteObject = isRecord(evaluated.result)
      ? evaluated.result
      : {};
    const objectId = remoteObject.objectId;
    if (typeof objectId !== "string" || !objectId) {
      throw new CdpBackendError(
        "stale_reference",
        "file input no longer exists",
      );
    }

    await this.#wire.send(
      "DOM.setFileInputFiles",
      {
        objectId,
        files: [filePath],
      },
      sessionId,
    );
    await this.#wire.send(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration:
          "function(){this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}",
        returnByValue: true,
      },
      sessionId,
    );
  }

  async downloads(
    targetId?: string,
  ): Promise<RawBrowserDownload[]> {
    let targetOrigin: string | null = null;
    if (targetId) {
      const target = (await this.listTargets()).find(
        (item) => item.target_id === targetId,
      );
      if (!target) {
        throw new CdpBackendError(
          "invalid_arguments",
          "CDP target does not exist",
        );
      }
      targetOrigin = safeOrigin(target.url);
    }

    return [...this.#downloadsByGuid.values()]
      .filter(
        (download) =>
          !targetOrigin ||
          safeOrigin(download.url) === targetOrigin,
      )
      .map((download) => ({
        backend_id: `cdp-download:${download.guid}`,
        page_id: targetId ? `cdp:${targetId}` : "browser",
        filename: download.suggested_filename,
        local_path: path.join(
          this.#downloadDir,
          download.suggested_filename,
        ),
        state: download.state,
        bytes_received: download.bytes_received,
        total_bytes: download.total_bytes,
      }));
  }

  async diagnostics(
    targetId: string,
    limit: number,
  ): Promise<RawBrowserDiagnosticEvent[]> {
    const sessionId = await this.#sessionForTarget(targetId);
    if (!this.#diagnosticsEnabled.has(targetId)) {
      await this.#wire.send("Log.enable", {}, sessionId);
      await this.#wire.send("Network.enable", {}, sessionId);
      this.#diagnosticsEnabled.add(targetId);
      this.#diagnosticsByTarget.set(
        targetId,
        this.#diagnosticsByTarget.get(targetId) ?? [],
      );
    }

    const normalizedLimit = Math.max(
      1,
      Math.min(Math.floor(limit), 500),
    );
    return structuredClone(
      (this.#diagnosticsByTarget.get(targetId) ?? []).slice(
        -normalizedLimit,
      ),
    );
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;

    this.#wire.offEvent(this.#eventListener);
    await this.#wire
      .send("Browser.close")
      .catch(() => undefined);
    this.#wire.close();

    await stopOwnedChromiumProcesses(
      this.#child,
      this.#browserPid,
    );

    await rm(this.profile_dir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    });
  }

  #handleCdpEvent(event: {
    sessionId?: string;
    method: string;
    params: Record<string, unknown>;
  }): void {
    if (event.method === "Browser.downloadWillBegin") {
      const guid = stringField(event.params, "guid");
      const url = stringField(event.params, "url");
      const suggestedFilename = stringField(
        event.params,
        "suggestedFilename",
      );
      if (guid && url && suggestedFilename) {
        this.#downloadsByGuid.set(guid, {
          guid,
          url,
          suggested_filename: suggestedFilename,
          state: "in_progress",
          bytes_received: 0,
          total_bytes: null,
        });
      }
      return;
    }

    if (event.method === "Browser.downloadProgress") {
      const guid = stringField(event.params, "guid");
      if (!guid) {
        return;
      }
      const existing = this.#downloadsByGuid.get(guid);
      if (!existing) {
        return;
      }
      const state = stringField(event.params, "state");
      const received = numberField(event.params, "receivedBytes");
      const total = numberField(event.params, "totalBytes");
      existing.state =
        state === "completed"
          ? "complete"
          : state === "canceled"
            ? "interrupted"
            : "in_progress";
      existing.bytes_received = Math.max(
        0,
        received ?? existing.bytes_received,
      );
      existing.total_bytes =
        total !== null && total >= 0
          ? total
          : existing.total_bytes;
      return;
    }

    if (!event.sessionId) {
      return;
    }
    const targetId = this.#sessionTargets.get(event.sessionId);
    if (
      !targetId ||
      !this.#diagnosticsEnabled.has(targetId)
    ) {
      return;
    }

    const diagnostic = diagnosticFromCdpEvent(
      event.method,
      event.params,
    );
    if (!diagnostic) {
      return;
    }

    const events =
      this.#diagnosticsByTarget.get(targetId) ?? [];
    events.push(diagnostic);
    if (events.length > 500) {
      events.splice(0, events.length - 500);
    }
    this.#diagnosticsByTarget.set(targetId, events);
  }

  async #sessionForTarget(
    targetId: string,
  ): Promise<string> {
    const existing = this.#sessions.get(targetId);
    if (existing) {
      return existing;
    }

    const result = await this.#wire.send(
      "Target.attachToTarget",
      {
        targetId,
        flatten: true,
      },
    );
    const sessionId = requiredString(
      result,
      "sessionId",
    );
    this.#sessions.set(targetId, sessionId);
    this.#sessionTargets.set(sessionId, targetId);

    await this.#wire.send(
      "Page.enable",
      {},
      sessionId,
    );
    await this.#wire.send(
      "Runtime.enable",
      {},
      sessionId,
    );
    return sessionId;
  }

  async #isolatedWorld(
    sessionId: string,
    frameId: string,
  ): Promise<number> {
    const result = await this.#wire.send(
      "Page.createIsolatedWorld",
      {
        frameId,
        worldName: "tetherplane",
        grantUniveralAccess: false,
      },
      sessionId,
    );
    const contextId = result.executionContextId;
    if (
      typeof contextId !== "number" ||
      !Number.isFinite(contextId)
    ) {
      throw new CdpBackendError(
        "provider_failure",
        "CDP did not return an isolated execution context",
      );
    }
    return contextId;
  }

  async #navigateAndWait(
    targetId: string,
    url: string,
  ): Promise<void> {
    const sessionId = await this.#sessionForTarget(targetId);
    const navigation = await this.#wire.send(
      "Page.navigate",
      { url },
      sessionId,
    );
    const errorText =
      typeof navigation.errorText === "string"
        ? navigation.errorText.trim()
        : "";
    if (errorText) {
      throw new CdpBackendError(
        "provider_failure",
        `CDP navigation failed: ${errorText}`,
      );
    }

    const loaderId =
      typeof navigation.loaderId === "string" &&
      navigation.loaderId.trim()
        ? navigation.loaderId
        : null;
    await this.#waitForDocumentReady(
      targetId,
      loaderId,
      url,
    );
  }

  async #waitForDocumentReady(
    targetId: string,
    expectedLoaderId: string | null,
    expectedUrl: string,
  ): Promise<void> {
    const sessionId = await this.#sessionForTarget(targetId);
    const deadline = Date.now() + 10_000;
    const normalizedExpectedUrl = new URL(expectedUrl).href;

    while (Date.now() < deadline) {
      try {
        const frameTree = await this.#wire.send(
          "Page.getFrameTree",
          {},
          sessionId,
        );
        const topFrame =
          isRecord(frameTree.frameTree) &&
          isRecord(frameTree.frameTree.frame)
            ? frameTree.frameTree.frame
            : null;
        const topLoaderId =
          topFrame &&
          typeof topFrame.loaderId === "string"
            ? topFrame.loaderId
            : null;

        if (
          expectedLoaderId !== null &&
          topLoaderId !== expectedLoaderId
        ) {
          await sleep(25);
          continue;
        }

        const result = await this.#wire.send(
          "Runtime.evaluate",
          {
            expression:
              "({readyState:document.readyState,href:location.href})",
            returnByValue: true,
          },
          sessionId,
        );
        const value = evaluationValue(result);
        if (!isRecord(value)) {
          await sleep(25);
          continue;
        }

        const readyState =
          typeof value.readyState === "string"
            ? value.readyState
            : "";
        const href =
          typeof value.href === "string" ? value.href : "";

        const sameDocumentReady =
          expectedLoaderId === null &&
          href.length > 0 &&
          new URL(href).href === normalizedExpectedUrl;

        if (
          readyState === "complete" &&
          (expectedLoaderId !== null || sameDocumentReady)
        ) {
          return;
        }
      } catch {
        // Navigation can invalidate the default execution context.
      }
      await sleep(25);
    }

    throw new CdpBackendError(
      "timeout",
      "CDP page did not reach the expected ready document",
    );
  }
}

export function findInstalledChromium(): string | null {
  const explicit = process.env.TETHERPLANE_CHROMIUM;
  if (explicit && isExecutableFile(explicit)) {
    return explicit;
  }

  const candidates =
    process.platform === "win32"
      ? windowsChromiumCandidates()
      : process.platform === "darwin"
        ? macChromiumCandidates()
        : linuxChromiumCandidates();

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  if (process.platform !== "win32") {
    return findExecutableOnPath([
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "microsoft-edge",
    ]);
  }

  return null;
}

export async function launchCdpOwnedBrowser(options: {
  executablePath?: string;
  profileParent?: string;
  launchTimeoutMs?: number;
} = {}): Promise<LaunchedCdpControl> {
  const executablePath =
    options.executablePath ?? findInstalledChromium();
  if (!executablePath || !isExecutableFile(executablePath)) {
    throw new CdpBackendError(
      "capability_unavailable",
      "no compatible installed Chromium executable was found",
    );
  }

  const parent = options.profileParent ?? os.tmpdir();
  await mkdir(parent, { recursive: true });
  const profileDir = await mkdtemp(
    path.join(parent, "tetherplane-cdp-"),
  );
  const args = buildIsolatedChromiumArgs(profileDir);
  const child = spawn(executablePath, args, {
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    await Promise.race([
      once(child, "spawn").then(() => undefined),
      once(child, "error").then(([error]) =>
        Promise.reject(error),
      ),
    ]);

    const websocketUrl =
      await waitForDevToolsActivePort({
        child,
        profileDir,
        timeoutMs:
          options.launchTimeoutMs ?? DEFAULT_CDP_LAUNCH_TIMEOUT_MS,
      });
    const wire = await CdpWire.connect(websocketUrl);
    const browserPid = await discoverBrowserPid(wire);
    const downloadDir = path.join(profileDir, "Downloads");
    await mkdir(downloadDir, { recursive: true });
    await wire.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
      eventsEnabled: true,
    });

    return new OwnedChromiumControl({
      child,
      wire,
      profileDir,
      downloadDir,
      executablePath,
      browserPid,
    });
  } catch (error) {
    await stopOwnedChromiumProcesses(child, null);
    await rm(profileDir, {
      recursive: true,
      force: true,
    });
    if (error instanceof CdpBackendError) {
      throw error;
    }
    throw new CdpBackendError(
      "provider_failure",
      error instanceof Error
        ? `failed to launch isolated Chromium: ${error.message}`
        : "failed to launch isolated Chromium",
    );
  }
}

async function discoverBrowserPid(
  wire: CdpWire,
): Promise<number | null> {
  try {
    const result = await wire.send(
      "SystemInfo.getProcessInfo",
    );
    const processes = result.processInfo;
    if (!Array.isArray(processes)) {
      return null;
    }

    for (const processInfo of processes) {
      if (
        isRecord(processInfo) &&
        processInfo.type === "browser" &&
        typeof processInfo.id === "number" &&
        Number.isSafeInteger(processInfo.id)
      ) {
        return processInfo.id;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function stopOwnedChromiumProcesses(
  child: ChildProcess,
  browserPid: number | null,
): Promise<void> {
  if (browserPid !== null) {
    await waitForPidExit(browserPid, 500);
    if (isProcessAlive(browserPid)) {
      try {
        process.kill(browserPid);
      } catch {
        // The browser may have exited between the liveness check and kill.
      }
      await waitForPidExit(browserPid, 1_000);
    }
  }

  if (child.exitCode === null) {
    child.kill();
    await Promise.race([
      once(child, "exit").then(() => undefined),
      sleep(1_000),
    ]).catch(() => undefined);
  }
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

async function waitForDevToolsActivePort(options: {
  child: ChildProcess;
  profileDir: string;
  timeoutMs: number;
}): Promise<string> {
  const portFile = path.join(
    options.profileDir,
    "DevToolsActivePort",
  );
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    try {
      const raw = await readFile(portFile, "utf8");
      const [portLine, pathLine] = raw
        .split(/\r?\n/)
        .map((line) => line.trim());
      const port = Number(portLine);
      if (
        Number.isInteger(port) &&
        port > 0 &&
        pathLine?.startsWith("/devtools/browser/")
      ) {
        return `ws://127.0.0.1:${port}${pathLine}`;
      }
    } catch {
      // Chrome writes the file after DevTools has bound its port.
    }

    if (
      options.child.exitCode !== null &&
      options.child.exitCode !== 0
    ) {
      throw new CdpBackendError(
        "provider_failure",
        `isolated Chromium exited with code ${options.child.exitCode}`,
      );
    }

    await sleep(25);
  }

  throw new CdpBackendError(
    "timeout",
    "timed out waiting for isolated Chromium DevTools endpoint",
  );
}

function flattenFrameTree(
  tree: Record<string, unknown>,
  parentFrameId: string | null,
  output: CdpFrame[],
): void {
  const frame = tree.frame;
  if (!isRecord(frame)) {
    return;
  }

  const frameId =
    typeof frame.id === "string" ? frame.id : "";
  if (!frameId) {
    return;
  }

  output.push({
    frame_id: frameId,
    document_id:
      typeof frame.loaderId === "string" &&
      frame.loaderId
        ? frame.loaderId
        : frameId,
    parent_frame_id: parentFrameId,
  });

  const children = tree.childFrames;
  if (!Array.isArray(children)) {
    return;
  }
  for (const child of children) {
    if (isRecord(child)) {
      flattenFrameTree(
        child,
        frameId,
        output,
      );
    }
  }
}

function evaluationValue(
  response: Record<string, unknown>,
): unknown {
  if (response.exceptionDetails) {
    throw new CdpBackendError(
      "provider_failure",
      "CDP page evaluation raised an exception",
    );
  }
  if (!isRecord(response.result)) {
    throw new CdpBackendError(
      "provider_failure",
      "CDP Runtime.evaluate returned no result",
    );
  }
  return response.result.value;
}

function parseFrameObservation(
  value: unknown,
): CdpFrameObservation {
  if (!isRecord(value)) {
    throw new CdpBackendError(
      "provider_failure",
      "CDP semantic observation is invalid",
    );
  }

  if (
    typeof value.url !== "string" ||
    typeof value.semantic_revision !== "number" ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.validation_messages) ||
    !Array.isArray(value.toasts)
  ) {
    throw new CdpBackendError(
      "provider_failure",
      "CDP semantic observation is malformed",
    );
  }

  return {
    url: value.url,
    semantic_revision: value.semantic_revision,
    resource_revision:
      typeof value.resource_revision === "string" ||
      typeof value.resource_revision === "number"
        ? value.resource_revision
        : null,
    nodes: value.nodes
      .filter(isRecord)
      .filter(
        (node) =>
          typeof node.backend_id === "string" &&
          typeof node.role === "string" &&
          typeof node.accessible_name === "string",
      ) as CdpFrameObservation["nodes"],
    validation_messages:
      value.validation_messages.filter(
        (item): item is string =>
          typeof item === "string",
      ),
    toasts: value.toasts.filter(
      (item): item is string =>
        typeof item === "string",
    ),
  };
}

const SENSITIVE_DIAGNOSTIC_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
]);

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function diagnosticFromCdpEvent(
  method: string,
  params: Record<string, unknown>,
): RawBrowserDiagnosticEvent | null {
  if (method === "Log.entryAdded") {
    const entry = isRecord(params.entry) ? params.entry : {};
    const message = stringField(entry, "text") ?? "";
    return {
      kind: "console",
      level: stringField(entry, "level") ?? "info",
      message,
      ...(stringField(entry, "url")
        ? { url: stringField(entry, "url")! }
        : {}),
      ...(numberField(entry, "timestamp") !== null
        ? {
            timestamp_ms: Math.floor(
              numberField(entry, "timestamp")! * 1_000,
            ),
          }
        : {}),
    };
  }

  if (method === "Network.requestWillBeSent") {
    const request = isRecord(params.request) ? params.request : {};
    const url = stringField(request, "url") ?? "";
    const headers = safeDiagnosticHeaders(
      isRecord(request.headers) ? request.headers : {},
    );
    return {
      kind: "network",
      level: "info",
      message: `request ${url}`,
      ...(url ? { url } : {}),
      ...(Object.keys(headers).length > 0
        ? { request_headers: headers }
        : {}),
      ...(numberField(params, "timestamp") !== null
        ? {
            timestamp_ms: Math.floor(
              numberField(params, "timestamp")! * 1_000,
            ),
          }
        : {}),
    };
  }

  if (method === "Network.responseReceived") {
    const response = isRecord(params.response) ? params.response : {};
    const url = stringField(response, "url") ?? "";
    const status = numberField(response, "status");
    return {
      kind: "network",
      level:
        status !== null && status >= 400 ? "error" : "info",
      message: `response ${status ?? "unknown"} ${url}`,
      ...(url ? { url } : {}),
      ...(status !== null ? { response_status: status } : {}),
      ...(numberField(params, "timestamp") !== null
        ? {
            timestamp_ms: Math.floor(
              numberField(params, "timestamp")! * 1_000,
            ),
          }
        : {}),
    };
  }

  return null;
}

function safeDiagnosticHeaders(
  headers: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(
        ([name]) =>
          !SENSITIVE_DIAGNOSTIC_HEADERS.has(
            name.toLowerCase(),
          ),
      )
      .filter((entry): entry is [string, string] =>
        typeof entry[1] === "string",
      ),
  );
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  return typeof record[key] === "string"
    ? (record[key] as string)
    : null;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | null {
  return typeof record[key] === "number"
    ? (record[key] as number)
    : null;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new CdpBackendError(
      "provider_failure",
      `CDP response is missing ${key}`,
    );
  }
  return value;
}

function windowsChromiumCandidates(): string[] {
  const programFiles =
    process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] ??
    "C:\\Program Files (x86)";
  const localAppData =
    process.env.LOCALAPPDATA ?? "";

  return [
    path.join(
      programFiles,
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.join(
      programFilesX86,
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.join(
      localAppData,
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.join(
      programFiles,
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
    path.join(
      programFilesX86,
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
  ];
}

function macChromiumCandidates(): string[] {
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
}

function linuxChromiumCandidates(): string[] {
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
}

function findExecutableOnPath(
  names: string[],
): string | null {
  const searchPath = process.env.PATH ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function isExecutableFile(candidate: string): boolean {
  if (!candidate || !existsSync(candidate)) {
    return false;
  }
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    if (process.platform === "win32") {
      return true;
    }
    return false;
  }
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, delayMs),
  );
}

function collectCdpFrameObservation() {
  const maxNodes = 500;
  const candidates = Array.from(
    document.querySelectorAll(
      [
        "button",
        "input",
        "textarea",
        "select",
        "a[href]",
        "[role]",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
      ].join(","),
    ),
  ).slice(0, maxNodes);

  function normalizedText(
    value: string | null | undefined,
  ): string {
    return (value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  }

  function roleFor(element: Element): string {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;

    const tag = element.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (
        element.getAttribute("type") ?? "text"
      ).toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (
        type === "submit" ||
        type === "button"
      ) {
        return "button";
      }
      return "textbox";
    }
    return tag;
  }

  function labelText(element: Element): string {
    const ariaLabel =
      element.getAttribute("aria-label");
    if (ariaLabel) {
      return normalizedText(ariaLabel);
    }

    const labelledBy =
      element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labels = labelledBy
        .split(/\s+/)
        .map(
          (id) =>
            document.getElementById(id)?.textContent ??
            "",
        )
        .join(" ");
      if (labels.trim()) {
        return normalizedText(labels);
      }
    }

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      const labels = Array.from(
        element.labels ?? [],
      )
        .map((label) => label.textContent ?? "")
        .join(" ");
      if (labels.trim()) {
        return normalizedText(labels);
      }
    }

    return normalizedText(
      element.getAttribute("alt") ??
        element.getAttribute("title") ??
        element.textContent,
    );
  }

  function selectorFor(element: Element): string {
    if (element.id) {
      return `#${CSS.escape(element.id)}`;
    }

    const parts: string[] = [];
    let current: Element | null = element;
    while (
      current &&
      current !== document.documentElement
    ) {
      const tag = current.tagName.toLowerCase();
      const parent: Element | null =
        current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }

      const siblings = Array.from(
        parent.children,
      ).filter(
        (candidate: Element) =>
          candidate.tagName === current!.tagName,
      );
      const position =
        siblings.indexOf(current) + 1;
      parts.unshift(
        siblings.length > 1
          ? `${tag}:nth-of-type(${position})`
          : tag,
      );
      current = parent;
    }
    return parts.join(" > ");
  }

  function isSensitive(element: Element): boolean {
    if (!(element instanceof HTMLInputElement)) {
      return false;
    }
    const type = element.type.toLowerCase();
    const autocomplete =
      element.autocomplete.toLowerCase();
    return (
      type === "password" ||
      autocomplete.includes("password") ||
      autocomplete === "one-time-code"
    );
  }

  function valueFor(
    element: Element,
  ): string | undefined {
    if (isSensitive(element)) {
      return undefined;
    }
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      return normalizedText(element.value);
    }
    return undefined;
  }

  function stableAncestorName(element: Element): string {
    const ariaLabel =
      element.getAttribute("aria-label");
    if (ariaLabel) {
      return normalizedText(ariaLabel);
    }

    const labelledBy =
      element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labels = labelledBy
        .split(/\s+/)
        .map(
          (id) =>
            document.getElementById(id)?.textContent ??
            "",
        )
        .join(" ");
      if (labels.trim()) {
        return normalizedText(labels);
      }
    }

    return "";
  }

  function ancestryFor(
    element: Element,
  ): Array<{
    role: string;
    accessible_name: string;
  }> {
    const ancestry: Array<{
      role: string;
      accessible_name: string;
    }> = [];
    let current = element.parentElement;
    while (current && ancestry.length < 4) {
      const role = roleFor(current);
      const name = stableAncestorName(current);
      const tag = current.tagName.toLowerCase();
      const structural =
        tag === "main" ||
        tag === "form" ||
        tag === "fieldset" ||
        tag === "section" ||
        tag === "nav" ||
        tag === "article" ||
        tag === "dialog";

      if (
        name ||
        current.hasAttribute("role") ||
        structural
      ) {
        ancestry.unshift({
          role,
          accessible_name: name,
        });
      }
      current = current.parentElement;
    }
    return ancestry;
  }

  const nodes: Array<Record<string, unknown>> = [];
  for (const element of candidates) {
    if (
      element.hasAttribute("hidden") ||
      element.getAttribute("aria-hidden") ===
        "true"
    ) {
      continue;
    }

    const sensitive = isSensitive(element);
    const node: Record<string, unknown> = {
      backend_id: `css:${selectorFor(element)}`,
      role: roleFor(element),
      accessible_name: labelText(element),
      ancestry: ancestryFor(element),
      sensitive,
    };

    const value = valueFor(element);
    if (value !== undefined) {
      node.value = value;
    }

    if (
      element instanceof HTMLButtonElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    ) {
      node.disabled = element.disabled;
    }
    if (
      element instanceof HTMLInputElement &&
      (element.type === "checkbox" ||
        element.type === "radio")
    ) {
      node.checked = element.checked;
    }
    nodes.push(node);
  }

  const validationMessages = Array.from(
    document.querySelectorAll(
      '[role="alert"], [aria-invalid="true"], .error, .validation-error',
    ),
  )
    .filter(
      (element) =>
        !element.hasAttribute("hidden") &&
        element.getAttribute("aria-hidden") !== "true",
    )
    .map((element) =>
      normalizedText(element.textContent),
    )
    .filter(Boolean)
    .slice(0, 50);

  const toasts = Array.from(
    document.querySelectorAll(
      '[role="status"], [aria-live="polite"], [aria-live="assertive"]',
    ),
  )
    .filter(
      (element) =>
        !element.hasAttribute("hidden") &&
        element.getAttribute("aria-hidden") !== "true",
    )
    .map((element) =>
      normalizedText(element.textContent),
    )
    .filter(Boolean)
    .slice(0, 50);

  const resourceRevision =
    document
      .querySelector("[data-revision]")
      ?.getAttribute("data-revision") ??
    null;

  const fingerprint = JSON.stringify({
    url: location.href,
    resourceRevision,
    nodes,
    validationMessages,
    toasts,
  });
  let hash = 2166136261;
  for (
    let index = 0;
    index < fingerprint.length;
    index += 1
  ) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return {
    url: location.href,
    semantic_revision: hash >>> 0,
    resource_revision: resourceRevision,
    nodes,
    validation_messages: validationMessages,
    toasts,
  };
}

function performCdpFrameAction(
  selectorToken: string,
  action: Record<string, unknown>,
) {
  if (!selectorToken.startsWith("css:")) {
    return {
      ok: false,
      code: "stale_reference",
      message: "unsupported CDP selector token",
    };
  }

  const selector =
    selectorToken.slice("css:".length);
  let element: Element | null;
  try {
    element = document.querySelector(selector);
  } catch {
    return {
      ok: false,
      code: "stale_reference",
      message: "CDP selector is no longer valid",
    };
  }

  if (!element) {
    return {
      ok: false,
      code: "stale_reference",
      message: "target no longer exists",
    };
  }

  if (action.kind === "click") {
    if (!(element instanceof HTMLElement)) {
      return {
        ok: false,
        code: "invalid_arguments",
        message:
          "click target is not an HTML element",
      };
    }
    element.click();
    return { ok: true };
  }

  if (action.kind === "fill") {
    if (
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) ||
      typeof action.value !== "string"
    ) {
      return {
        ok: false,
        code: "invalid_arguments",
        message:
          "fill requires a text input and string value",
      };
    }

    const prototype =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const descriptor =
      Object.getOwnPropertyDescriptor(
        prototype,
        "value",
      );
    descriptor?.set?.call(
      element,
      action.value,
    );
    element.dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    element.dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    return { ok: true };
  }

  if (action.kind === "select") {
    if (
      !(element instanceof HTMLSelectElement) ||
      typeof action.value !== "string"
    ) {
      return {
        ok: false,
        code: "invalid_arguments",
        message:
          "select requires a select element and string value",
      };
    }
    element.value = action.value;
    element.dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    element.dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    return { ok: true };
  }

  if (action.kind === "check") {
    if (
      !(element instanceof HTMLInputElement) ||
      typeof action.checked !== "boolean"
    ) {
      return {
        ok: false,
        code: "invalid_arguments",
        message:
          "check requires an input and boolean checked state",
      };
    }
    element.checked = action.checked;
    element.dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    element.dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    return { ok: true };
  }

  return {
    ok: false,
    code: "invalid_arguments",
    message: "unsupported CDP semantic action",
  };
}
