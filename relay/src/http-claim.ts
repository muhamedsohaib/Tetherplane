import type { ServerResponse } from "node:http";

const CLAIM = Symbol.for("tetherplane.http.claimed");

export function markClaimed(response: ServerResponse): void {
  (response as unknown as Record<symbol, boolean>)[CLAIM] = true;
}

export function isClaimed(response: ServerResponse): boolean {
  return (
    (response as unknown as Record<symbol, boolean | undefined>)[CLAIM] ===
    true
  );
}
