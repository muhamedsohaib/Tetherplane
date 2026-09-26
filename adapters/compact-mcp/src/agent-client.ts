import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
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
      const result = await callWithTimeout(
        client,
        startupProbeInvocation(),
        15_000,
      );
      if (result.status !== "success") {
        throw new AgentProtocolError(
          "local Tetherplane agent failed startup readiness probe",
        );
      }
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


function startupProbeInvocation(): InvocationEnvelope {
  return {
    protocol_version: "1.0",
    request_id: randomUUID(),
    device_id: null,
    principal_id: null,
    job_id: null,
    capability: "device.status",
    arguments: {},
    actor: {
      id: "compact-mcp-bootstrap",
      kind: "ai_client",
    },
    session_id: null,
    response_mode: "compact",
    idempotency_key: null,
    preconditions: [],
    expectations: [],
  };
}

async function callWithTimeout(
  client: AgentClient,
  invocation: InvocationEnvelope,
  timeoutMs: number,
): Promise<ResultEnvelope> {
  return new Promise<ResultEnvelope>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AgentDisconnectedError(
          "local Tetherplane agent did not become ready before startup timeout",
        ),
      );
    }, timeoutMs);

    void client.call(invocation).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
