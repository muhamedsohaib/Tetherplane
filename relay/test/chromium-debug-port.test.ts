import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readChromiumDevToolsPort } from "./helpers/chromium-debug-port.ts";

test("headless Chrome uses the debugging port assigned to its private profile", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "tether-cdp-port-test-"));
  try {
    await writeFile(path.join(profile, "DevToolsActivePort"),
      "43021\n/devtools/browser/synthetic\n", "utf8");
    assert.equal(await readChromiumDevToolsPort(profile), 43021);
    await writeFile(path.join(profile, "DevToolsActivePort"), "invalid\n", "utf8");
    await assert.rejects(readChromiumDevToolsPort(profile), /debugging port/i);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
