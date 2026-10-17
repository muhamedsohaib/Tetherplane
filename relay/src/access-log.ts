import { appendFile, stat } from "node:fs/promises";
import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";

const MCP_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
]);

const DEFAULT_MAX_BYTES = 1024 * 1024;

let nextId = 1;
const inFlight = new WeakMap<
  ServerResponse,
  { id: number; startMs: number }
>();

export type AccessLogOptions = {
  file: string;
  maxBytes?: number;
};

export class AccessLog {
  readonly #file: string;
  readonly #maxBytes: number;
  #disabled = false;
  #writeStopped = false;
  #remainingBytes: number;
  #writes: Promise<void> = Promise.resolve();

  constructor(options: AccessLogOptions) {
    this.#file = options.file;
    this.#maxBytes =
      options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) {
      throw new Error("access log maxBytes must be a positive safe integer");
    }
    this.#remainingBytes = this.#maxBytes;
  }

  requestStarted(
    response: ServerResponse,
    method: string,
    rawUrl: string,
  ): Promise<void> {
    if (this.#disabled) return Promise.resolve();
    const id = nextId++;
    inFlight.set(response, { id, startMs: Date.now() });
    return this.#append({
      id,
      event: "start",
      ts: new Date().toISOString(),
      method: cleanMethod(method),
      path: cleanPath(rawUrl),
    });
  }

  requestFinished(
    response: ServerResponse,
    status: number,
  ): Promise<void> {
    const tracked = inFlight.get(response);
    if (!tracked || this.#disabled) {
      inFlight.delete(response);
      return Promise.resolve();
    }
    inFlight.delete(response);
    return this.#append({
      id: tracked.id,
      event: "finish",
      ts: new Date().toISOString(),
      status,
      durationMs: Date.now() - tracked.startMs,
    });
  }

  requestAborted(response: ServerResponse): Promise<void> {
    const tracked = inFlight.get(response);
    if (!tracked || this.#disabled) {
      inFlight.delete(response);
      return Promise.resolve();
    }
    inFlight.delete(response);
    return this.#append({
      id: tracked.id,
      event: "abort",
      ts: new Date().toISOString(),
      durationMs: Date.now() - tracked.startMs,
    });
  }

  noteMcpMethod(
    response: ServerResponse,
    raw: unknown,
  ): Promise<void> {
    if (this.#disabled) return Promise.resolve();
    if (typeof raw !== "string" || !MCP_METHODS.has(raw)) return Promise.resolve();
    const tracked = inFlight.get(response);
    if (!tracked) return Promise.resolve();
    return this.#append({
      id: tracked.id,
      event: "mcp",
      ts: new Date().toISOString(),
      mcpMethod: raw,
    });
  }

  #append(
    entry: Record<string, string | number>,
  ): Promise<void> {
    if (this.#disabled) return Promise.resolve();
    const line = JSON.stringify(entry) + "\n";
    const bytes = Buffer.byteLength(line, "utf8");
    // Reserve before adding a promise to the queue: pending content shares the
    // lifetime byte budget, so slow I/O cannot grow an unbounded write queue.
    if (bytes > this.#remainingBytes) {
      this.#disabled = true;
      return Promise.resolve();
    }
    this.#remainingBytes -= bytes;
    this.#writes = this.#writes.then(async () => {
      if (this.#writeStopped) return;
      try {
        const current = await stat(this.#file).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if ((current?.size ?? 0) + bytes > this.#maxBytes) {
          this.#disabled = true;
          this.#writeStopped = true;
          return;
        }
        await appendFile(this.#file, line, "utf8");
      } catch {
        // Diagnostic failures never reject the HTTP event or future completions.
        this.#disabled = true;
        this.#writeStopped = true;
      }
    });
    return this.#writes;
  }
}

export function attachAccessLogging(
  server: Server,
  log: AccessLog,
): void {
  server.on(
    "request",
    (request: IncomingMessage, response: ServerResponse) => {
      log.requestStarted(
        response,
        request.method ?? "",
        request.url ?? "/",
      );
      let finished = false;
      response.on("finish", () => {
        finished = true;
        log.requestFinished(
          response,
          response.statusCode,
        );
      });
      response.on("close", () => {
        if (!finished) log.requestAborted(response);
      });
    },
  );
}

function cleanMethod(method: string): string {
  return /^[A-Z]{1,16}$/.test(method)
    ? method
    : "OTHER";
}

function cleanPath(rawUrl: string): string {
  try {
    return new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return "/invalid";
  }
}
