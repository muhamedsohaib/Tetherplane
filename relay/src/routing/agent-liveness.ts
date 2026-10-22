import { randomUUID } from "node:crypto";

import type { InvocationEnvelope, ResultEnvelope } from "@tetherplane/protocol";
import type { ClientIdentity } from "../auth/static-auth.ts";
import type { DeviceRouter } from "./device-router.ts";

export type AgentProbeResult = {
  state: "ready" | "degraded" | "saturated" | "unresponsive" |
    "disconnected" | "denied" | "unknown";
  relay_health: "not_measured";
  transport: "authenticated" | "disconnected" | "unknown";
  authentication: "verified" | "denied" | "unknown";
  agent_response: "responsive" | "unresponsive" | "unknown";
  elapsed_ms: number;
  error_code?: string;
};

// On-demand, independently timed authenticated request. A timeout does NOT
// establish why the operation failed; the relay HTTP health is not measured.
export async function probeAuthenticatedAgent(
  router: DeviceRouter,
  identity: ClientIdentity,
  deviceId: string,
  deadlineMs: number,
): Promise<AgentProbeResult> {
  const started = performance.now();
  const request: InvocationEnvelope = {
    protocol_version: "1.0",
    request_id: randomUUID(),
    device_id: deviceId,
    principal_id: identity.principalId,
    capability: "device.status",
    arguments: {},
    job_id: null,
    actor: { id: identity.clientId, kind: "ai_client" },
    session_id: null,
    response_mode: "compact",
    idempotency_key: null,
    preconditions: [],
    expectations: [],
  };
  const timeout = Number.isFinite(deadlineMs) ? Math.max(1, deadlineMs) : 1000;
  const result = await new Promise<ResultEnvelope | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    void router.call(identity, request).then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  const elapsed_ms = Number((performance.now() - started).toFixed(2));
  const common = { relay_health: "not_measured" as const, elapsed_ms };
  if (!result || result.error?.code === "timeout") {
    return {
      ...common, state: "unresponsive", transport: "unknown",
      authentication: "unknown", agent_response: "unresponsive",
      error_code: "timeout",
    };
  }
  if (result.error?.code === "permission_denied") {
    return {
      ...common, state: "denied", transport: "unknown",
      authentication: "denied", agent_response: "unknown",
      error_code: "permission_denied",
    };
  }
  if (result.error?.code === "disconnected") {
    return {
      ...common, state: "disconnected", transport: "disconnected",
      authentication: "unknown", agent_response: "unknown",
      error_code: "disconnected",
    };
  }
  if (result.status !== "success") {
    return {
      ...common, state: "unknown", transport: "unknown",
      authentication: "unknown", agent_response: "unknown",
      error_code: result.error?.code ?? "unknown",
    };
  }
  const data = result.data;
  const liveness = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>).agent_liveness
    : null;
  const details = liveness && typeof liveness === "object" && !Array.isArray(liveness)
    ? liveness as Record<string, unknown>
    : null;
  const reported = details?.state;
  const state = reported === "ready" || reported === "degraded" || reported === "saturated"
    ? reported : "unknown";
  return {
    ...common, state, transport: "authenticated",
    authentication: "verified", agent_response: "responsive",
  };
}
