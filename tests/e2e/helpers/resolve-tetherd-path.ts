import path from "node:path";

// Test-harness-only override. Production runtime behavior is unchanged:
// when no explicit path is given and TETHERPLANE_TETHERD_PATH is unset,
// the historical target/debug default is returned.
export function resolveTetherdPath(
  repoRoot: string,
  explicitPath?: string,
): string {
  if (explicitPath?.trim()) {
    return explicitPath.trim();
  }
  const override = process.env.TETHERPLANE_TETHERD_PATH?.trim();
  if (override) {
    return override;
  }
  const executable =
    process.platform === "win32" ? "tetherd.exe" : "tetherd";
  return path.join(repoRoot, "target", "debug", executable);
}
