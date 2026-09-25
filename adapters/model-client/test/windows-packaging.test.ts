import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

test("Windows release packages an always-on per-user model worker", async () => {
  const packageScript = await readFile(
    path.join(root, "scripts", "package-windows.ps1"),
    "utf8",
  );
  const installer = await readFile(
    path.join(root, "scripts", "install-model-worker-windows.ps1"),
    "utf8",
  );
  const uninstall = await readFile(
    path.join(root, "scripts", "uninstall-windows.ps1"),
    "utf8",
  );

  assert.match(packageScript, /@tetherplane\/model-client/);
  assert.match(packageScript, /install-model-worker-windows\.ps1/);

  assert.match(
    installer,
    /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run/,
  );
  assert.match(installer, /TetherplaneModelWorker/);
  assert.match(installer, /-WindowStyle Hidden/);
  assert.match(installer, /worker-main\.js/);
  assert.match(installer, /--api-key-env/);
  assert.doesNotMatch(installer, /--api-key(?!-env)/);
  assert.doesNotMatch(installer, /Register-ScheduledTask/);
  assert.match(installer, /while \(\$true\)/);

  assert.match(uninstall, /TetherplaneModelWorker/);
});
