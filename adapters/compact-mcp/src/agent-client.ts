import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface, type Interface } from "node:readline";

import { Ajv, type ValidateFunction } from "ajv";

import type { InvocationEnvelope, ResultEnvelope } from "@tetherplane/protocol";

type PendingCall = {
  resolve: (result: ResultEnvelope) => void;
  reject: (error: Error) => void;
};

export class AgentDisconnectedError extends Error {
  readonly code = "disconnected" as const;

  constructor(message = "local Tetherplane agent is disconnected") {
    super(message);
    this.name = "AgentDisconnectedError";
  }
}

export class AgentProtocolError extends Error {
  readonly code = "provider_failure" as const;

  constructor(message: string) {
    super(message);
    this.name = "AgentProtocolError";
  }
}

const require = createRequire(import.meta.url);

const validateResult =
  process.env.NODE_ENV === "production" ? null : createResultValidator();

export class AgentClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: Interface;
  readonly #pending = new Map<string, PendingCall>();
  #disconnected = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    this.#lines = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    this.#lines.on("line", (line) => this.#handleLine(line));
    child.once("exit", () => this.#disconnect());
    child.once("error", () => this.#disconnect());
  }

  static async spawn(options: {
    tetherdPath: string;
    tetherdArgs?: string[];
  }): Promise<AgentClient> {
    const scriptLike = /\.(?:[cm]?js|ts)$/i.test(options.tetherdPath);
    const command = scriptLike ? process.execPath : options.tetherdPath;
    const tetherdArgs = options.tetherdArgs ?? [];
    const args = scriptLike
      ? [options.tetherdPath, "--stdio-rpc", ...tetherdArgs]
      : ["--stdio-rpc", ...tetherdArgs];

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    await Promise.race([
      once(child, "spawn"),
      once(child, "error").then(([error]) => Promise.reject(error)),
    ]);

    const client = new AgentClient(child);
    try {
      await waitForAgentReady(child, 15_000);
      child.stderr.resume();
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  call(invocation: InvocationEnvelope): Promise<ResultEnvelope> {
    if (this.#disconnected || this.#child.stdin.destroyed) {
      return Promise.reject(new AgentDisconnectedError());
    }

    if (this.#pending.has(invocation.request_id)) {
      return Promise.reject(
        new Error(`duplicate in-flight request_id: ${invocation.request_id}`),
      );
    }

    return new Promise<ResultEnvelope>((resolve, reject) => {
      this.#pending.set(invocation.request_id, { resolve, reject });
      const payload = `${JSON.stringify(invocation)}\n`;
      this.#child.stdin.write(payload, (error) => {
        if (error) {
          this.#pending.delete(invocation.request_id);
          reject(new AgentDisconnectedError(String(error)));
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.#disconnected) {
      return;
    }

    this.#child.stdin.end();
    const exited = once(this.#child, "exit");
    const timer = new Promise<void>((resolve) => {
      setTimeout(resolve, 1_000);
    });

    await Promise.race([exited.then(() => undefined), timer]);
    if (this.#child.exitCode === null) {
      this.#child.kill();
      await once(this.#child, "exit").catch(() => undefined);
    }
    this.#disconnect();
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.#disconnect("local agent emitted invalid JSONL");
      return;
    }

    if (validateResult && !validateResult(parsed)) {
      const message = `local agent result failed protocol validation: ${JSON.stringify(
        validateResult.errors,
      )}`;
      const requestId = resultRequestId(parsed);
      const pending = requestId ? this.#pending.get(requestId) : undefined;
      if (requestId && pending) {
        this.#pending.delete(requestId);
        pending.reject(new AgentProtocolError(message));
        return;
      }

      this.#disconnect(message);
      return;
    }

    const result = parsed as ResultEnvelope;
    const pending = this.#pending.get(result.request_id);
    if (!pending) {
      return;
    }

    this.#pending.delete(result.request_id);
    pending.resolve(result);
  }

  #disconnect(message?: string): void {
    if (this.#disconnected) {
      return;
    }

    this.#disconnected = true;
    this.#lines.close();
    const error = new AgentDisconnectedError(message);
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function createResultValidator(): ValidateFunction<unknown> {
  const ajv = new Ajv({ allErrors: true, strict: true });
  ajv.addSchema(loadSchema("@tetherplane/protocol/schemas/error.schema.json"));
  return ajv.compile(
    loadSchema("@tetherplane/protocol/schemas/result.schema.json"),
  );
}

function loadSchema(specifier: string): object {
  return JSON.parse(readFileSync(require.resolve(specifier), "utf8")) as object;
}

function resultRequestId(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "request_id" in value &&
    typeof (value as { request_id?: unknown }).request_id === "string"
  ) {
    return (value as { request_id: string }).request_id;
  }

  return null;
}


const TETHERD_STDIO_READY_MARKER =
  "TETHERPLANE_STDIO_READY_V1";

async function waitForAgentReady(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) {
    throw new AgentDisconnectedError(
      "local Tetherplane agent exited before startup readiness",
    );
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffer = "";

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer
          .slice(0, newline)
          .trim();
        buffer = buffer.slice(newline + 1);
        if (line === TETHERD_STDIO_READY_MARKER) {
          finish();
          return;
        }
        newline = buffer.indexOf("\n");
      }

      if (buffer.length > 16_384) {
        buffer = buffer.slice(-4_096);
      }
    };

    const onExit = () => {
      finish(
        new AgentDisconnectedError(
          "local Tetherplane agent exited before startup readiness",
        ),
      );
    };

    const onError = () => {
      finish(
        new AgentDisconnectedError(
          "local Tetherplane agent failed before startup readiness",
        ),
      );
    };

    const timer = setTimeout(() => {
      finish(
        new AgentDisconnectedError(
          "local Tetherplane agent did not become ready before startup timeout",
        ),
      );
    }, timeoutMs);

    child.stderr.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
