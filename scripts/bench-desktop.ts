import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { startLocalCompact } from "../tests/e2e/helpers/start-local.ts";

type Json = Record<string, unknown>;
type DesktopNode = {
  reference: string;
  name: string;
  process_id: number;
  origin: string;
  patterns: string[];
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const fixturePath = path.join(
  repoRoot,
  "tests",
  "e2e",
  "fixtures",
  "windows-desktop-fixture.ps1",
);
const tetherdPath = path.join(repoRoot, "target", "release", "tetherd.exe");

assert.equal(process.platform, "win32", "desktop benchmark currently requires Windows");

const temp = await mkdtemp(path.join(os.tmpdir(), "tetherplane-bench-desktop-"));
const statePath = path.join(temp, "owned.json");
const local = await startLocalCompact({ tetherdPath });
let ownedHandle: string | undefined;

try {
  const started = structured(
    await call(local.client, "process", {
      op: "run",
      args: {
        program: "powershell.exe",
        args: [
          "-NoProfile",
          "-Sta",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          fixturePath,
          "-StatePath",
          statePath,
          "-Title",
          "Tetherplane Desktop Benchmark",
          "-Prefix",
          "Bench",
        ],
        wait_ms: 0,
        pty: false,
      },
    }),
  );
  ownedHandle = String(started.handle);
  const ownedPid = Number(started.pid);
  assert.ok(Number.isInteger(ownedPid) && ownedPid > 0);
  await waitForState(statePath, (state) => state.ready === true);

  const cursorBefore = cursorPosition();

  const snapshotStarted = performance.now();
  const snapshot = structured(
    await call(local.client, "desktop", {
      op: "snapshot",
      args: { max_nodes: 1000 },
    }),
  );
  const snapshotMs = performance.now() - snapshotStarted;

  const nodes = (snapshot.nodes as DesktopNode[]).filter(
    (node) => node.process_id === ownedPid,
  );
  assert.ok(nodes.length > 0, "owned benchmark fixture was not observed");
  assert.ok(nodes.every((node) => node.origin === "tetherplane"));

  const valueNode = findPattern(nodes, "value");
  const invokeNode = findPattern(nodes, "invoke");
  const selectionNode =
    nodes.find(
      (node) =>
        node.patterns.includes("selection") && node.name.includes("Beta"),
    ) ?? findPattern(nodes, "selection");

  const valueStarted = performance.now();
  const valueResult = await call(local.client, "desktop", {
    op: "act",
    args: {
      reference: valueNode.reference,
      action: "set_value",
      value: "benchmark-semantic-value",
    },
  });
  const valueMs = performance.now() - valueStarted;
  assert.equal(valueResult.isError, undefined);

  const invokeStarted = performance.now();
  const invokeResult = await call(local.client, "desktop", {
    op: "act",
    args: {
      reference: invokeNode.reference,
      action: "invoke",
    },
  });
  const invokeMs = performance.now() - invokeStarted;
  assert.equal(invokeResult.isError, undefined);

  const selectStarted = performance.now();
  const selectResult = await call(local.client, "desktop", {
    op: "act",
    args: {
      reference: selectionNode.reference,
      action: "select",
    },
  });
  const selectMs = performance.now() - selectStarted;
  assert.equal(selectResult.isError, undefined);

  const state = await waitForState(
    statePath,
    (value) =>
      value.text === "benchmark-semantic-value" &&
      value.status === "invoked" &&
      typeof value.selected === "string",
  );
  assert.equal(state.text, "benchmark-semantic-value");
  assert.equal(state.status, "invoked");
  assert.deepEqual(cursorPosition(), cursorBefore);

  const result = {
    measured_at: new Date().toISOString(),
    commit_sha: commandOutput("git", ["rev-parse", "HEAD"]),
    os: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model ?? "unknown",
    },
    runtime: {
      build_profile: "release",
      node: process.version,
    },
    backend: "windows_uia_semantic",
    fixture_nodes_observed: nodes.length,
    cursor_unchanged: true,
    calls: {
      semantic_snapshot_ms: round(snapshotMs),
      value_set_ms: round(valueMs),
      invoke_ms: round(invokeMs),
      selection_ms: round(selectMs),
    },
    total_four_call_ms: round(snapshotMs + valueMs + invokeMs + selectMs),
  };

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally {
  if (ownedHandle !== undefined) {
    await call(local.client, "process", {
      op: "terminate",
      args: { handle: ownedHandle, grace_ms: 100, force: true },
    }).catch(() => undefined);
  }
  await local.close().catch(() => undefined);
  await rm(temp, { recursive: true, force: true });
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  return client.callTool({ name, arguments: args });
}

function structured(
  result: Awaited<ReturnType<typeof call>>,
): Record<string, unknown> {
  assert.ok(result.structuredContent, "expected structuredContent");
  return result.structuredContent as Record<string, unknown>;
}

function findPattern(
  nodes: DesktopNode[],
  pattern: string,
): DesktopNode {
  const node = nodes.find((candidate) =>
    candidate.patterns.includes(pattern),
  );
  assert.ok(node, "expected desktop node with pattern " + pattern);
  return node;
}

async function waitForState(
  statePath: string,
  predicate: (state: Json) => boolean,
): Promise<Json> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8")) as Json;
      if (predicate(state)) return state;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "fixture state did not reach expected condition: " +
      String(lastError ?? ""),
  );
}

function cursorPosition(): { x: number; y: number } {
  const value = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output ($p.X.ToString()+','+$p.Y.ToString())",
    ],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true },
  ).trim();
  const [x, y] = value.split(",").map(Number);
  assert.ok(Number.isInteger(x) && Number.isInteger(y));
  return { x: x as number, y: y as number };
}

function commandOutput(command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function round(value: number): number {
  return Number(value.toFixed(2));
}
