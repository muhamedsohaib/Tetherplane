import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
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

  static async spawn(options: { tetherdPath: string }): Promise<AgentClient> {
    const scriptLike = /\.(?:[cm]?js|ts)$/i.test(options.tetherdPath);
    const command = scriptLike ? process.execPath : options.tetherdPath;
    const args = scriptLike
      ? [options.tetherdPath, "--stdio-rpc"]
      : ["--stdio-rpc"];

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    await Promise.race([
      once(child, "spawn"),
      once(child, "error").then(([error]) => Promise.reject(error)),
    ]);

    return new AgentClient(child);
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
  ajv.addSchema(loadSchema("../../../protocol/schemas/error.schema.json"));
  return ajv.compile(
    loadSchema("../../../protocol/schemas/result.schema.json"),
  );
}

function loadSchema(relativePath: string): object {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as object;
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
