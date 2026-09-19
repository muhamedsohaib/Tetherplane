import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface, type Interface } from "node:readline";

import type { InvocationEnvelope, ResultEnvelope } from "@tetherplane/protocol";

type PendingCall = {
  resolve: (result: ResultEnvelope) => void;
  reject: (error: Error) => void;
};

export class LocalAgentDisconnectedError extends Error {
  readonly code = "disconnected" as const;

  constructor(message = "local Tetherplane agent is disconnected") {
    super(message);
    this.name = "LocalAgentDisconnectedError";
  }
}

export class LocalAgentProtocolError extends Error {
  readonly code = "provider_failure" as const;

  constructor(message: string) {
    super(message);
    this.name = "LocalAgentProtocolError";
  }
}

export class LocalAgentClient {
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

    // Drain stderr so a verbose local agent can never block the JSONL transport.
    child.stderr.resume();
  }

  static async spawn(options: {
    tetherdPath: string;
    tetherdArgs?: string[];
  }): Promise<LocalAgentClient> {
    const scriptLike = /\.(?:[cm]?js|ts)$/i.test(options.tetherdPath);
    const command = scriptLike ? process.execPath : options.tetherdPath;
    const extraArgs = options.tetherdArgs ?? [];
    const args = scriptLike
      ? [options.tetherdPath, "--stdio-rpc", ...extraArgs]
      : ["--stdio-rpc", ...extraArgs];

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    await Promise.race([
      once(child, "spawn"),
      once(child, "error").then(([error]) => Promise.reject(error)),
    ]);

    return new LocalAgentClient(child);
  }

  call(invocation: InvocationEnvelope): Promise<ResultEnvelope> {
    if (this.#disconnected || this.#child.stdin.destroyed) {
      return Promise.reject(new LocalAgentDisconnectedError());
    }
    if (this.#pending.has(invocation.request_id)) {
      return Promise.reject(
        new LocalAgentProtocolError(
          `duplicate in-flight request_id: ${invocation.request_id}`,
        ),
      );
    }

    return new Promise<ResultEnvelope>((resolve, reject) => {
      this.#pending.set(invocation.request_id, { resolve, reject });
      this.#child.stdin.write(`${JSON.stringify(invocation)}\n`, (error) => {
        if (error) {
          this.#pending.delete(invocation.request_id);
          reject(new LocalAgentDisconnectedError(String(error)));
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
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, 1_000);
    });
    await Promise.race([exited.then(() => undefined), timeout]);

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

    if (!isResultEnvelope(parsed)) {
      this.#disconnect("local agent emitted an invalid result envelope");
      return;
    }

    const pending = this.#pending.get(parsed.request_id);
    if (!pending) {
      return;
    }
    this.#pending.delete(parsed.request_id);
    pending.resolve(parsed);
  }

  #disconnect(message?: string): void {
    if (this.#disconnected) {
      return;
    }

    this.#disconnected = true;
    this.#lines.close();
    const error = new LocalAgentDisconnectedError(message);
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isResultEnvelope(value: unknown): value is ResultEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.protocol_version === "1.0" &&
    typeof candidate.request_id === "string" &&
    (candidate.status === "success" || candidate.status === "error") &&
    typeof candidate.verification === "string" &&
    typeof candidate.timing === "object" &&
    candidate.timing !== null
  );
}
