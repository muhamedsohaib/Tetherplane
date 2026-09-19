import assert from "node:assert/strict";
import { basename } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

import { startBrowserLab } from "../fixtures/browser-lab/src/index.ts";
import {
  BrowserBridgeService,
  CdpBrowserBackend,
  findInstalledChromium,
  launchCdpOwnedBrowser,
  startBrowserRpcServer,
} from "../browser/bridge/src/index.ts";
import { startLocalCompact } from "../tests/e2e/helpers/start-local.ts";

const executablePath = findInstalledChromium();
assert.ok(
  executablePath,
  "no installed compatible Chromium executable was found",
);

const lab = await startBrowserLab();
const control = await launchCdpOwnedBrowser({ executablePath });
const backend = new CdpBrowserBackend({
  control,
  pollIntervalMs: 20,
});
const bridge = await startBrowserRpcServer({
  service: new BrowserBridgeService({ backend }),
  token: "browser-benchmark-ephemeral",
});
const local = await startLocalCompact({
  browserBridge: {
    address: bridge.address,
    token: "browser-benchmark-ephemeral",
  },
});

try {
  const created = await local.client.callTool({
    name: "browser",
    arguments: {
      op: "create_tab",
      args: { url: lab.origin },
    },
  });
  assert.ok(created.structuredContent);
  const pageId = (
    created.structuredContent as Record<string, unknown>
  ).page_id;
  assert.equal(typeof pageId, "string");

  const snapshotStarted = performance.now();
  const snapshot = await local.client.callTool({
    name: "browser",
    arguments: {
      op: "snapshot",
      args: { page_id: pageId },
    },
  });
  const snapshotMs = performance.now() - snapshotStarted;
  assert.ok(snapshot.structuredContent);
  const nodes = (
    snapshot.structuredContent as Record<string, unknown>
  ).nodes as Array<Record<string, unknown>>;
  const input = nodes.find(
    (node) => node.accessible_name === "Project value",
  );
  const save = nodes.find(
    (node) => node.accessible_name === "Save",
  );
  assert.ok(input?.ref);
  assert.ok(save?.ref);

  const actionStarted = performance.now();
  const action = await local.client.callTool({
    name: "browser",
    arguments: {
      op: "act",
      args: {
        page_id: pageId,
        actions: [
          {
            kind: "fill",
            target: input.ref,
            value: "benchmark-saved",
          },
          {
            kind: "click",
            target: save.ref,
          },
        ],
        expectations: [
          {
            kind: "value",
            target: input.ref,
            equals: "benchmark-saved",
          },
          { kind: "toast", includes: "Saved" },
          { kind: "validation_absent" },
        ],
        timeout_ms: 5_000,
      },
    },
  });
  const actionMs = performance.now() - actionStarted;
  assert.ok(action.structuredContent);
  assert.equal(
    (action.structuredContent as Record<string, unknown>).state,
    "verified",
  );

  const persisted = await fetch(new URL("/api/state", lab.origin));
  assert.equal(persisted.status, 200);
  const state = (await persisted.json()) as Record<string, unknown>;
  assert.equal(state.value, "benchmark-saved");

  const result = {
    measured_at: new Date().toISOString(),
    os: process.platform,
    arch: process.arch,
    node: process.version,
    browser_executable: basename(executablePath),
    backend: "cdp_isolated_installed_browser",
    ai_visible_round_trips_unknown_initial_state: 2,
    calls: {
      semantic_snapshot_ms: Number(snapshotMs.toFixed(2)),
      verified_action_ms: Number(actionMs.toFixed(2)),
    },
    total_two_call_ms: Number(
      (snapshotMs + actionMs).toFixed(2),
    ),
    verification: "verified",
  };

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally {
  await local.close();
  await bridge.close();
  await backend.shutdown();
  await lab.close();
}
