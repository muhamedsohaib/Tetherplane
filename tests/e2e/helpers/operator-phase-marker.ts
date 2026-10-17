import { writeFile } from "node:fs/promises";

export type PhaseWriter = (path: string, value: string, encoding: "utf8") => Promise<void>;

/** Write a phase marker without extending the actual semantic-RPC interval. */
export async function writePhaseMarker(
  path: string,
  phase: string,
  writer: PhaseWriter = writeFile,
): Promise<void> {
  // Windows can reject a writer while the read-only sampler holds a
  // transient read handle. Retry *only* EBUSY and keep the delay bounded.
  // Marker readiness is outside the measured semantic-RPC interval.
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      await writer(path, phase, "utf8");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EBUSY" || attempt === 40) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
