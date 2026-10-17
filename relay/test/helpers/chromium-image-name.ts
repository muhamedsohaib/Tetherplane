import { win32 } from "node:path";

/** The image name is used only to audit test-owned profile processes.
 * Do not permit arbitrary shell input in the Windows CIM process filter. */
export function windowsChromiumImageName(executablePath: string): string {
  const image = win32.basename(executablePath).toLowerCase();
  if (!/^(?:chrome|msedge|chromium)\.exe$/.test(image)) {
    throw new Error("unsupported Chromium executable image for owned-profile cleanup");
  }
  return image;
}
