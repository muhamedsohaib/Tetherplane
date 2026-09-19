import type {
  InvocationEnvelope,
  ResultEnvelope,
} from "@tetherplane/protocol";

import {
  makeCanonicalInvocation,
  translateRdcCall,
  type RdcCompatibilityError,
} from "./translate.ts";

export type AgentCaller = {
  call(invocation: InvocationEnvelope): Promise<ResultEnvelope>;
};

export type CompatibilityResult =
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        recovery_hint: string | null;
        details: unknown;
      };
    };

type SearchState = {
  matches: Array<Record<string, unknown>>;
  done: boolean;
};

export class RdcCompatibilityService {
  readonly #agent: AgentCaller;
  readonly #platform: NodeJS.Platform;
  readonly #searches = new Map<string, SearchState>();
  readonly #processByCompatPid = new Map<number, string>();
  readonly #compatPidByHandle = new Map<string, number>();
  #nextCompatPid = 10_000;

  constructor(options: {
    agentClient: AgentCaller;
    platform?: NodeJS.Platform;
  }) {
    this.#agent = options.agentClient;
    this.#platform = options.platform ?? process.platform;
  }

  async call(
    tool: string,
    input: Record<string, unknown>,
  ): Promise<CompatibilityResult> {
    switch (tool) {
      case "list_devices":
        return this.#listDevices(input);
      case "ping":
        return this.#ping(input);
      case "get_config":
        return this.#getConfig(input);
      case "start_search":
        return this.#startSearch(input);
      case "get_more_search_results":
        return this.#readSearch(input);
      case "stop_search":
        return this.#stopSearch(input);
      case "list_searches":
        return this.#listSearches(input);
      case "start_process":
        return this.#startProcess(input);
      case "read_process_output":
        return this.#readProcess(input);
      case "interact_with_process":
        return this.#interactProcess(input);
      case "force_terminate":
        return this.#terminateCompatProcess(input, true);
      case "list_sessions":
        return this.#listSessions(input);
      case "list_processes":
        return this.#invokeData(
          makeCanonicalInvocation(
            "process.list_system",
            {},
            input,
          ),
        );
      case "kill_process":
        return this.#killProcess(input);
      default:
        return this.#translateAndInvoke(tool, input);
    }
  }

  async #listDevices(
    input: Record<string, unknown>,
  ): Promise<CompatibilityResult> {
    const result = await this.#agent.call(
      makeCanonicalInvocation("device.status", {}, input),
    );
    const data = successfulData(result);
    if (!data.ok) return data;
    const id =
      typeof input.deviceId === "string"
        ? input.deviceId
        : "local";
    return {
      ok: true,
      data: {
        devices: [
          {
            id,
            name: id,
            status: "online",
            agent_version: data.data.agent_version,
            os: data.data.os,
            arch: data.data.arch,
          },
        ],
      },
    };
  }

  async #ping(
    input: Record<string, unknown>,
  ): Promise<CompatibilityResult> {
    const result = await this.#agent.call(
      makeCanonicalInvocation("device.status", {}, input),
    );
    const data = successfulData(result);
    if (!data.ok) return data;
    return {
      ok: true,
      data: {
        pong: true,
        deviceId:
          typeof input.deviceId === "string"
            ? input.deviceId
            : "local",
        agent_version: data.data.agent_version,
      },
    };
  }

  async #getConfig(
    input: Record<string, unknown>,
  ): Promise<CompatibilityResult> {
    const result = await this.#agent.call(
      makeCanonicalInvocation(
        "device.capabilities",
        {},
        input,
      ),
    );
    const data = successfulData(result);
    if (!data.ok) return data;
    return {
      ok: true,
      data: {
        policyMode: "background_only",
        providers: data.data.providers ?? [],
        allowedDirectories:
          "launch-controlled; intentionally not exposed by compatibility edge",
        runtimeConfigMutation: false,
      },
    };
  }

  async #translateAndInvoke(
    tool: string,
    input: Record<string, unknown>,
  ): Promise<CompatibilityResult> {
    const translated = translateRdcCall(tool, input);
    if (translated.kind === "unsupported") {
      return compatibilityError(translated.error);
    }
    return this.#invokeData(translated.invocation);
  }

  async #startSearch(
    input: Record<string, unknown>,
  ): Promise<CompatibilityResult> {
    const translated = translateRdcCall("start_search", input);
    if (translated.kind === "unsupported") {
      return compatibilityError(translated.error);
    }
    const result = await this.#agent.call(translated.invocation);
    const data = successfulData(result);
    if (!data.ok) return data;
    const handle = data.data.handle;
    if (typeof handle !== "string") {
      return localError(
        "provider_failure",
        "search.start did not return a handle",
      );
    }
    this.#searches.set(handle, { matches: [], done: false });
    return {
      ok: true,
      data: {
        sessionId: handle,
        status: data.data.state ?? "running",
        searchType: input.searchType ?? "files",
        pattern: input.pattern,
      },
    };
  }

  async #readSearch(
    input: Record<string, unknown>,
  ): Promise<CompatibilityResult> {
    const sessionId = input.sessionId;
    if (typeof sessionId !== "string") {
      return localError(
        "invalid_arguments",
        "get_more_search_results requires sessionId",
      );
    }
    const state = this.#searches.get(sessionId) ?? {
      matches: [],
      done: false,
    };
    this.#searches.set(sessionId, state);

    const offset = integer(input.offset, 0);
    const length = positiveInteger(input.length, 100);
    const desiredEnd =
      offset < 0
        ? state.matches.length
        : offset + length;

    if (!state.done && state.matches.length < desiredEnd) {
      const need = Math.max(
        length,
        desiredEnd - state.matches.length,
      );
      const result = await this.#agent.call(
        makeCanonicalInvocation(
          "search.read",
          { handle: sessionId, max_items: need },
          input,
        ),
      );
      const data = successfulData(result);
      if (!data.ok) return data;
      const matches = Array.isArray(data.data.matches)
        ? data.data.matches.filter(isRecord)
        : [];
      state.matches.push(
        ...matches.map((item) => structuredClone(item)),
      );
      state.done = data.data.done === true;
    }

    const start =
      offset < 0
        ? Math.max(0, state.matches.length - Math.abs(offset))
        : offset;
    const end =
      offset < 0
        ? state.matches.length
        : start + length;

    return {
      ok: true,
      data: {
        sessionId,
        results: state.matches.slice(start, end),
        offset: start,
        totalResults: state.matches.length,
        isComplete: state.done,
      },
    };
  }

  async #stopSearch(
    input: Record<string, unknown>,
  ): Promise<CompatibilityResult> {
    const translated = translateRdcCall("stop_search", input);
    if (translated.kind === "unsupported") {
      return compatibilityError(translated.error);
    }
    const result = await this.#invokeData(translated.invocation);
    if (
      result.ok &&
      typeof input.sessionId === "string" &&
      this.#searches.has(input.sessionId)
    ) {
      this.#searches.get(input.sessionId)!.done = true;
    }
    return result;
  }

  async #listSearches(
    input: Record<string, unknown>,
  ): Promise<CompatibilityResult> {
    const result = await this.#agent.call(
      makeCanonicalInvocation("search.list", {}, input),
    );
    const data = successfulData(result);
    if (!data.ok) return data;
    const sessions = Array.isArray(data.data.sessions)
      ? data.data.sessions.filter(isRecord)
      : [];
    return {
      ok: true,
      data: {
        searches: sessions.map((session) => ({
          ...session,
          sessionId: session.handle,
          handle: undefined,
        })),
      },
    };
  }

  async #startProcess(
    input: Record<string, unknown>,
  ): Promise<CompatibilityResult> {
    if (typeof input.command !== "string" || !input.command) {
      return localError(
        "invalid_arguments",
        "start_process requires command",
      );
    }
    const shell = shellCommand(
      this.#platform,
      input.shell,
      input.command,
    );
    const result = await this.#agent.call(
      makeCanonicalInvocation(
        "process.run",
        {
          program: shell.program,
          args: shell.args,
          wait_ms: positiveInteger(input.timeout_ms, 250),
          pty: true,
        },
        input,
      ),
    );
    const data = successfulData(result);
    if (!data.ok) return data;
    const handle = data.data.handle;
    if (typeof handle !== "string") {
      return localError(
        "provider_failure",
        "process.run did not return a handle",
      );
    }
    const pid = this.#compatPid(handle);
    return {
      ok: true,
      data: {
        ...data.data,
        pid,
        system_pid: undefined,
        handle: undefined,
      },
    };
  }

  async #readProcess(
    input: Record<string, unknown>,
  ): Promise<CompatibilityResult> {
    const resolved = this.#resolveCompatPid(input.pid);
    if (!resolved.ok) return resolved;
    const offset = integer(input.offset, 0);
    const length = positiveInteger(input.length, 100);
    const args: Record<string, unknown> = {
      handle: resolved.handle,
      timeout_ms: positiveInteger(input.timeout_ms, 0),
    };
    if (offset > 0) {
      args.mode = "absolute";
      args.offset = offset;
    } else if (offset < 0) {
      args.mode = "tail";
      args.tail_bytes = Math.max(1024, Math.abs(offset) * 256);
    }
    const result = await this.#invokeData(
      makeCanonicalInvocation("process.read", args, input),
    );
    if (!result.ok) return result;
    return {
      ok: true,
      data: {
        ...result.data,
        pid: input.pid,
        length,
        handle: undefined,
      },
    };
  }

  async #interactProcess(
    input: Record<string, unknown>,
  ): Promise<CompatibilityResult> {
    const resolved = this.#resolveCompatPid(input.pid);
    if (!resolved.ok) return resolved;
    if (typeof input.input !== "string") {
      return localError(
        "invalid_arguments",
        "interact_with_process requires input",
      );
    }
    const written = await this.#invokeData(
      makeCanonicalInvocation(
        "process.input",
        {
          handle: resolved.handle,
          data: normalizeInteractiveInput(
            input.input,
            this.#platform,
          ),
        },
        input,
      ),
    );
    if (!written.ok || input.wait_for_prompt === false) {
      return written;
    }
    return this.#readProcess({
      ...input,
      offset: 0,
      timeout_ms: positiveInteger(input.timeout_ms, 8_000),
    });
  }

  async #terminateCompatProcess(
    input: Record<string, unknown>,
    force: boolean,
  ): Promise<CompatibilityResult> {
    const resolved = this.#resolveCompatPid(input.pid);
    if (!resolved.ok) return resolved;
    return this.#invokeData(
      makeCanonicalInvocation(
        "process.terminate",
        {
          handle: resolved.handle,
          force,
          grace_ms: force ? 0 : 250,
        },
        input,
      ),
    );
  }

  async #listSessions(
    input: Record<string, unknown>,
  ): Promise<CompatibilityResult> {
    const result = await this.#agent.call(
      makeCanonicalInvocation(
        "process.list_sessions",
        {},
        input,
      ),
    );
    const data = successfulData(result);
    if (!data.ok) return data;
    const sessions = Array.isArray(data.data.sessions)
      ? data.data.sessions.filter(isRecord)
      : [];
    return {
      ok: true,
      data: {
        sessions: sessions.map((session) => {
          const handle = session.handle;
          const pid =
            typeof handle === "string"
              ? this.#compatPid(handle)
              : null;
          return {
            ...session,
            pid,
            system_pid: session.pid,
            handle: undefined,
          };
        }),
      },
    };
  }

  async #killProcess(
    input: Record<string, unknown>,
  ): Promise<CompatibilityResult> {
    if (typeof input.pid !== "number") {
      return localError(
        "invalid_arguments",
        "kill_process requires numeric pid",
      );
    }
    const handle = this.#processByCompatPid.get(input.pid);
    const argumentsValue = handle
      ? { handle, force: true, grace_ms: 0 }
      : { pid: input.pid };
    return this.#invokeData(
      makeCanonicalInvocation(
        "process.terminate",
        argumentsValue,
        input,
      ),
    );
  }

  async #invokeData(
    invocation: InvocationEnvelope,
  ): Promise<CompatibilityResult> {
    return successfulData(await this.#agent.call(invocation));
  }

  #compatPid(handle: string): number {
    const existing = this.#compatPidByHandle.get(handle);
    if (existing !== undefined) return existing;
    const pid = this.#nextCompatPid++;
    this.#compatPidByHandle.set(handle, pid);
    this.#processByCompatPid.set(pid, handle);
    return pid;
  }

  #resolveCompatPid(
    value: unknown,
  ):
    | { ok: true; handle: string }
    | { ok: false; error: CompatibilityResult extends infer _ ? {
        code: string;
        message: string;
        recovery_hint: string | null;
        details: unknown;
      } : never } {
    if (typeof value !== "number") {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "pid must be a compatibility session id",
          recovery_hint: null,
          details: {},
        },
      };
    }
    const handle = this.#processByCompatPid.get(value);
    if (!handle) {
      return {
        ok: false,
        error: {
          code: "permission_denied",
          message:
            "pid is not an owned RDC compatibility process session",
          recovery_hint: null,
          details: { pid: value },
        },
      };
    }
    return { ok: true, handle };
  }
}

function successfulData(
  result: ResultEnvelope,
): CompatibilityResult {
  if (result.status === "success") {
    return {
      ok: true,
      data: isRecord(result.data) ? result.data : {},
    };
  }
  return {
    ok: false,
    error: {
      code: result.error?.code ?? "provider_failure",
      message: result.error?.message ?? "canonical operation failed",
      recovery_hint: result.error?.recovery_hint ?? null,
      details: result.error?.details ?? {},
    },
  };
}

function compatibilityError(
  error: RdcCompatibilityError,
): CompatibilityResult {
  return { ok: false, error };
}

function localError(
  code: string,
  message: string,
): CompatibilityResult {
  return {
    ok: false,
    error: {
      code,
      message,
      recovery_hint: null,
      details: {},
    },
  };
}

function normalizeInteractiveInput(
  value: string,
  platform: NodeJS.Platform,
): string {
  if (platform === "win32") {
    const normalized = value.replace(/\r?\n/g, "\r\n");
    return normalized.endsWith("\r\n")
      ? normalized
      : normalized + "\r\n";
  }
  return value.endsWith("\n") ? value : value + "\n";
}

function shellCommand(
  platform: NodeJS.Platform,
  requestedShell: unknown,
  command: string,
): { program: string; args: string[] } {
  if (platform === "win32") {
    const shell =
      typeof requestedShell === "string"
        ? requestedShell.toLowerCase()
        : "cmd";
    if (shell.includes("powershell")) {
      return {
        program: "powershell.exe",
        args: ["-NoProfile", "-Command", command],
      };
    }
    return { program: "cmd.exe", args: ["/C", command] };
  }
  return {
    program:
      typeof requestedShell === "string" && requestedShell
        ? requestedShell
        : "/bin/sh",
    args: ["-c", command],
  };
}

function integer(value: unknown, fallback: number): number {
  return Number.isInteger(value) ? Number(value) : fallback;
}

function positiveInteger(
  value: unknown,
  fallback: number,
): number {
  return Number.isInteger(value) && Number(value) >= 0
    ? Number(value)
    : fallback;
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
