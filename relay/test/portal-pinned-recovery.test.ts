import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadReadOnlyPortalPilotConfig,
  parseRelayArgs,
} from "../src/cli-config.ts";

const pilot = {
  schema: 1,
  portalPort: 8789,
  publicOrigin: "https://vaulter.tailf65eba.ts.net:9447",
  readOnly: true,
};

function existingPinnedLauncherArgs(stateFile: string): string[] {
  return [
    "--auth-config", "C:\\Tetherplane\\relay\\auth.json",
    "--state-file", stateFile,
    "--host", "127.0.0.1",
    "--port", "8788",
    "--allow-insecure-localhost",
  ];
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tetherplane-pinned-portal-"));
  const stateFile = path.join(dir, "devices.json");
  const configFile = stateFile + ".portal-pilot.json";
  const original = parseRelayArgs(existingPinnedLauncherArgs(stateFile));
  return { dir, stateFile, configFile, original };
}

test("pinned launcher without an opt-in file retains MCP routing but isolates the portal", async () => {
  const t = await fixture();
  try {
    const safe = await loadReadOnlyPortalPilotConfig(t.original);
    assert.equal(safe.port, t.original.port);
    assert.equal(safe.host, t.original.host);
    assert.equal(safe.stateFile, t.original.stateFile);
    assert.equal(safe.authConfig, t.original.authConfig);
    assert.equal(safe.portalReadOnly, true);
    assert.equal(safe.portalPort, 0);
    assert.equal(safe.publicOrigin, undefined);
    assert.equal(t.original.portalReadOnly, false);
    assert.equal(t.original.portalPort, undefined);
  } finally {
    await rm(t.dir, { recursive: true, force: true });
  }
});

test("read-only file enables private portal without changing pinned launcher arguments", async () => {
  const t = await fixture();
  try {
    await writeFile(t.configFile, JSON.stringify(pilot));
    const resolved = await loadReadOnlyPortalPilotConfig(t.original);
    assert.equal(resolved.host, "127.0.0.1");
    assert.equal(resolved.port, 8788);
    assert.equal(resolved.portalPort, 8789);
    assert.equal(resolved.portalReadOnly, true);
    assert.equal(resolved.publicOrigin, pilot.publicOrigin);
    assert.equal(resolved.trustProxyHeaders, true);
    assert.equal(resolved.authConfig, t.original.authConfig);
    assert.equal(resolved.stateFile, t.original.stateFile);
    assert.deepEqual(t.original, parseRelayArgs(existingPinnedLauncherArgs(t.stateFile)));
    await writeFile(t.configFile, "\uFEFF" + JSON.stringify(pilot));
    const powershellUtf8 = await loadReadOnlyPortalPilotConfig(t.original);
    assert.equal(powershellUtf8.portalPort, 8789);
    assert.equal(powershellUtf8.portalReadOnly, true);
  } finally {
    await rm(t.dir, { recursive: true, force: true });
  }
});

test("invalid opt-in files fail closed instead of exposing a mutable or public portal", async () => {
  const t = await fixture();
  const cases: Array<[string, unknown]> = [
    ["missing readOnly", { ...pilot, readOnly: undefined }],
    ["readOnly false", { ...pilot, readOnly: false }],
    ["wrong schema", { ...pilot, schema: 2 }],
    ["unknown field", { ...pilot, mutable: true }],
    ["port conflict", { ...pilot, portalPort: 8788 }],
    ["invalid port", { ...pilot, portalPort: 70000 }],
    ["no HTTPS", { ...pilot, publicOrigin: "http://localhost:9447" }],
    ["implicit public 443", { ...pilot, publicOrigin: "https://vaulter.tailf65eba.ts.net" }],
    ["public 443 explicit", { ...pilot, publicOrigin: "https://vaulter.tailf65eba.ts.net:443" }],
    ["credentialed URL", { ...pilot, publicOrigin: "https://alice:secret@vaulter.tailf65eba.ts.net:9447" }],
  ];
  try {
    for (const [label, value] of cases) {
      await writeFile(t.configFile, JSON.stringify(value));
      await assert.rejects(
        loadReadOnlyPortalPilotConfig(t.original),
        "Case " + label + " must fail closed",
      );
    }
    await writeFile(t.configFile, "{not-json");
    await assert.rejects(loadReadOnlyPortalPilotConfig(t.original), /Invalid.*JSON/);
  } finally {
    await rm(t.dir, { recursive: true, force: true });
  }
});

test("opt-in config rejects non-loopback main hosts and conflicting CLI controls", async () => {
  const t = await fixture();
  try {
    await writeFile(t.configFile, JSON.stringify(pilot));
    const wide = parseRelayArgs(existingPinnedLauncherArgs(t.stateFile)
      .flatMap((arg, index, all) => arg === "127.0.0.1" && all[index - 1] === "--host" ? ["0.0.0.0"] : [arg]));
    await assert.rejects(loadReadOnlyPortalPilotConfig(wide), /loopback/);
    const override = parseRelayArgs([
      ...existingPinnedLauncherArgs(t.stateFile), "--portal-port", "8789",
      "--portal-read-only",
    ]);
    await assert.rejects(loadReadOnlyPortalPilotConfig(override), /conflicts/);
  } finally {
    await rm(t.dir, { recursive: true, force: true });
  }
});

test("opt-in refuses directories and symlinked files", async (t) => {
  const f = await fixture();
  try {
    await mkdir(f.configFile);
    await assert.rejects(loadReadOnlyPortalPilotConfig(f.original), /regular file/);
    await rm(f.configFile, { recursive: true, force: true });
    const target = path.join(f.dir, "portal-target.json");
    await writeFile(target, JSON.stringify(pilot));
    try {
      await symlink(target, f.configFile, "file");
    } catch (e) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((e as NodeJS.ErrnoException).code ?? "")) {
        t.diagnostic("Symlink creation unavailable on this Windows runner");
        return;
      }
      throw e;
    }
    await assert.rejects(loadReadOnlyPortalPilotConfig(f.original), /regular file/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
