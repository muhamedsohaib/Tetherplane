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

  constructor(options: AccessLogOptions) {
    this.#file = options.file;
    this.#maxBytes =
      options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  requestStarted(
    response: ServerResponse,
    method: string,
    rawUrl: string,
  ): void {
    if (this.#disabled) return;
    const id = nextId++;
    inFlight.set(response, { id, startMs: Date.now() });
    void this.#append({
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
  ): void {
    const tracked = inFlight.get(response);
    if (!tracked || this.#disabled) {
      inFlight.delete(response);
      return;
    }
    inFlight.delete(response);
    void this.#append({
      id: tracked.id,
      event: "finish",
      ts: new Date().toISOString(),
      status,
      durationMs: Date.now() - tracked.startMs,
    });
  }

  requestAborted(response: ServerResponse): void {
    const tracked = inFlight.get(response);
    if (!tracked || this.#disabled) {
      inFlight.delete(response);
      return;
    }
    inFlight.delete(response);
    void this.#append({
      id: tracked.id,
      event: "abort",
      ts: new Date().toISOString(),
      durationMs: Date.now() - tracked.startMs,
    });
  }

  noteMcpMethod(
    response: ServerResponse,
    raw: unknown,
  ): void {
    if (this.#disabled) return;
    if (typeof raw !== "string" || !MCP_METHODS.has(raw)) return;
    const tracked = inFlight.get(response);
    if (!tracked) return;
    void this.#append({
      id: tracked.id,
      event: "mcp",
      ts: new Date().toISOString(),
      mcpMethod: raw,
    });
  }

  async #append(
    entry: Record<string, string | number>,
  ): Promise<void> {
    try {
      const current = await stat(this.#file).catch(() => null);
      if (
        current &&
        current.size >= this.#maxBytes
      ) {
        this.#disabled = true;
        return;
      }
      await appendFile(
        this.#file,
        JSON.stringify(entry) + "\n",
        "utf8",
      );
    } catch {
      this.#disabled = true;
    }
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
