import { lstatSync, readFileSync } from "node:fs";

// An owner-created marker is an authorization barrier. Filesystem inspection
// must fail closed: existsSync would mistake access-denied for an absent marker.
// A signed-in background host has a distinct explicit owner authorization
// beyond extension enrollment. Removing it denies the NEXT browser RPC.
export function assertOwnerBackgroundOptIn(markerPath?: string): void {
  if (!markerPath) return;
  try {
    if (readFileSync(markerPath, "utf8") ===
        "owner-approved-browser-background-v1\n") return;
  } catch {
    // Missing or unreadable opt-in must not authorize any new request.
  }
  throw Object.assign(new Error("background browser owner approval withdrawn"), {
    code: "permission_denied",
  });
}

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
