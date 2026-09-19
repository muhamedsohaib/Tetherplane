/* Generated from Tetherplane JSON Schemas. Do not edit. */

export interface ProtocolTypes {
  invocation: InvocationEnvelope;
  result: ResultEnvelope;
  error: CapabilityError;
  capability: CapabilityDescriptor;
}
export interface InvocationEnvelope {
  protocol_version: "1.0";
  request_id: string;
  device_id: string | null;
  principal_id?: string | null;
  capability: string;
  arguments: {
    [k: string]: unknown;
  };
  actor: {
    id: string;
    kind: "human" | "ai_client" | "system";
  };
  session_id: string | null;
  response_mode: "compact" | "normal" | "debug";
  idempotency_key: string | null;
  preconditions: {
    [k: string]: unknown;
  }[];
  expectations: {
    [k: string]: unknown;
  }[];
}
export interface ResultEnvelope {
  protocol_version: "1.0";
  request_id: string;
  status: "success" | "error";
  data: {
    [k: string]: unknown;
  } | null;
  delta: {
    [k: string]: unknown;
  } | null;
  error: CapabilityError | null;
  verification: "not_applicable" | "verified" | "executed_unverified" | "failed";
  continuation: {
    [k: string]: unknown;
  } | null;
  policy: {
    [k: string]: unknown;
  } | null;
  timing: {
    duration_ms: number;
  };
}
export interface CapabilityError {
  code:
    | "invalid_arguments"
    | "capability_unavailable"
    | "permission_denied"
    | "approval_required"
    | "foreground_lease_required"
    | "human_activity_conflict"
    | "stale_reference"
    | "resource_conflict"
    | "precondition_failed"
    | "action_unverified"
    | "timeout"
    | "disconnected"
    | "process_finished"
    | "output_truncated"
    | "provider_failure";
  message: string;
  recovery_hint: string | null;
  details: {
    [k: string]: unknown;
  };
}
export interface CapabilityDescriptor {
  protocol_version: "1.0";
  capability: string;
  available: boolean;
  provider: string | null;
  input_schema: {
    [k: string]: unknown;
  } | null;
  reason: string | null;
}
