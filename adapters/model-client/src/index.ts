import { randomUUID } from "node:crypto";

import type { InvocationEnvelope, ResultEnvelope } from "@tetherplane/protocol";

export {
  LocalAgentClient,
  LocalAgentDisconnectedError,
  LocalAgentProtocolError,
} from "./local-agent.ts";

export type ModelAction = {
  capability: string;
  arguments: Record<string, unknown>;
  device?: string;
  job_id?: string;
  response_mode?: "compact" | "normal" | "debug";
  idempotency_key?: string;
};

export type NextActionInput = {
  objective: string;
  context?: Record<string, unknown>;
};

export type AgentTransport = {
  call(invocation: InvocationEnvelope): Promise<ResultEnvelope>;
};

export class ModelActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelActionError";
  }
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class OpenAICompatibleModelClient {
  readonly #endpoint: string;
  readonly #model: string;
  readonly #fetch: FetchLike;
  readonly #apiKey: string | undefined;

  constructor(options: {
    endpoint: string;
    model: string;
    apiKey?: string;
    fetchFn?: FetchLike;
  }) {
    if (!options.endpoint.trim()) {
      throw new Error("model endpoint is required");
    }
    if (!options.model.trim()) {
      throw new Error("model name is required");
    }
    this.#endpoint = options.endpoint;
    this.#model = options.model;
    this.#fetch = options.fetchFn ?? fetch;
    this.#apiKey = options.apiKey;
  }

  async nextAction(input: NextActionInput): Promise<ModelAction> {
    if (!input.objective.trim()) {
      throw new ModelActionError("objective is required");
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.#apiKey) {
      headers.authorization = `Bearer ${this.#apiKey}`;
    }

    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.#model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Return exactly one JSON object describing the next Tetherplane action. Allowed fields: capability, arguments, device, job_id, response_mode, idempotency_key. Never include principal identity, credentials, approval claims, actor metadata, or policy overrides.",
          },
          {
            role: "user",
            content: JSON.stringify({
              objective: input.objective,
              context: input.context ?? {},
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new ModelActionError(
        `model endpoint returned HTTP ${response.status}`,
      );
    }

    const payload = (await response.json()) as unknown;
    const content = extractMessageContent(payload);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      throw new ModelActionError("model response content is not valid JSON");
    }
    return validateModelAction(parsed);
  }
}

export class ModelController {
  readonly #model: OpenAICompatibleModelClient;
  readonly #agent: AgentTransport;

  constructor(options: {
    model: OpenAICompatibleModelClient;
    agent: AgentTransport;
  }) {
    this.#model = options.model;
    this.#agent = options.agent;
  }

  async executeNext(input: NextActionInput): Promise<ResultEnvelope> {
    const action = await this.#model.nextAction(input);
    const invocation: InvocationEnvelope = {
      protocol_version: "1.0",
      request_id: randomUUID(),
      device_id: action.device ?? null,
      principal_id: null,
      job_id: action.job_id ?? null,
      capability: action.capability,
      arguments: action.arguments,
      actor: {
        id: "model-client",
        kind: "ai_client",
      },
      session_id: null,
      response_mode: action.response_mode ?? "compact",
      idempotency_key: action.idempotency_key ?? null,
      preconditions: [],
      expectations: [],
    };
    return this.#agent.call(invocation);
  }
}

const ACTION_FIELDS = new Set([
  "capability",
  "arguments",
  "device",
  "job_id",
  "response_mode",
  "idempotency_key",
]);

function validateModelAction(value: unknown): ModelAction {
  if (!isRecord(value)) {
    throw new ModelActionError("model action must be a JSON object");
  }

  for (const key of Object.keys(value)) {
    if (!ACTION_FIELDS.has(key)) {
      throw new ModelActionError(`unsupported field in model action: ${key}`);
    }
  }

  if (typeof value.capability !== "string" || !value.capability.includes(".")) {
    throw new ModelActionError(
      "model action capability must be a canonical namespace.operation string",
    );
  }
  if (!isRecord(value.arguments)) {
    throw new ModelActionError("model action arguments must be an object");
  }

  optionalString(value, "device");
  optionalString(value, "job_id");
  optionalString(value, "idempotency_key");

  if (
    value.response_mode !== undefined &&
    value.response_mode !== "compact" &&
    value.response_mode !== "normal" &&
    value.response_mode !== "debug"
  ) {
    throw new ModelActionError(
      "response_mode must be compact, normal, or debug",
    );
  }

  return {
    capability: value.capability,
    arguments: value.arguments,
    ...(typeof value.device === "string" ? { device: value.device } : {}),
    ...(typeof value.job_id === "string" ? { job_id: value.job_id } : {}),
    ...(typeof value.response_mode === "string"
      ? {
          response_mode: value.response_mode as
            | "compact"
            | "normal"
            | "debug",
        }
      : {}),
    ...(typeof value.idempotency_key === "string"
      ? { idempotency_key: value.idempotency_key }
      : {}),
  };
}

function extractMessageContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new ModelActionError("model response is missing choices");
  }
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new ModelActionError("model response is missing message");
  }
  if (typeof choice.message.content !== "string") {
    throw new ModelActionError("model response message content must be a string");
  }
  return choice.message.content;
}

function optionalString(value: Record<string, unknown>, key: string): void {
  const candidate = value[key];
  if (
    candidate !== undefined &&
    (typeof candidate !== "string" || candidate.length === 0)
  ) {
    throw new ModelActionError(`${key} must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
