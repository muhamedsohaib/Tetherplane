import { lstatSync } from "node:fs";

// An owner-created marker is an authorization barrier. Filesystem inspection
// must fail closed: existsSync would mistake access-denied for an absent marker.
export function assertBrowserNotRevoked(markerPath: string): void {
  try {
    lstatSync(markerPath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
  }
  throw Object.assign(
    new Error("browser owner authorization revoked or cannot be verified"),
    { code: "permission_denied" },
  );
}
