import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Chromium with --remote-debugging-port=0 writes its assigned port to this
 * per-test profile. Never assume a shared fixed CDP port: it could belong to
 * an unrelated browser.
 */
export async function readChromiumDevToolsPort(profileDir: string): Promise<number> {
  const content = await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8");
  const first = content.split(/\r?\n/, 1)[0] ?? "";
  const port = Number(first);
  if (!/^[0-9]+$/.test(first) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid Chromium debugging port in the test profile");
  }
  return port;
}
