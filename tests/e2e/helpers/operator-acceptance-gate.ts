export function operatorAcceptanceHostAllowed(hostname: string): boolean {
  return hostname.toLowerCase() === "leno";
}

export type OperatorPhaseMetrics = {
  sample_count: number;
  cursor_motion_samples: number;
  input_change_samples: number;
};

// Require sustained evidence in a single acknowledged action window.
// One late sampler tick after each RPC cannot satisfy this threshold.
export function hasActionPhaseOverlap(
  metrics: Record<string, OperatorPhaseMetrics | undefined>,
): boolean {
  return ["set_value", "invoke", "select"].some((phase) => {
    const sample = metrics[phase];
    return sample !== undefined && sample.sample_count >= 3 &&
      sample.cursor_motion_samples >= 3 && sample.input_change_samples >= 3;
  });
}

export type OperatorAcceptanceInput = {
  interactive: string | undefined;
  operatorActive: string | undefined;
  deadline: string | undefined;
  approvedSha: string | undefined;
};

/**
 * An opt-in safety interlock, not a grant of foreground authority.
 * Real operator consent and availability must be verified independently.
 */
export function operatorAcceptanceAllowed(
  input: OperatorAcceptanceInput,
  actualSha: string,
  now: number,
): boolean {
  if (input.interactive !== "1" || input.operatorActive !== "1") return false;
  if (!Number.isFinite(now) || !input.deadline || !input.approvedSha) return false;
  if (!/^[0-9a-f]{40}$/i.test(actualSha) || input.approvedSha !== actualSha) return false;
  const deadline = Date.parse(input.deadline);
  const remaining = deadline - now;
  return Number.isFinite(deadline) && remaining >= 90_000 && remaining <= 15 * 60_000;
}
