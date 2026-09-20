import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { startLocalCompact } from "../tests/e2e/helpers/start-local.ts";

type Json = Record<string, unknown>;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const executable = process.platform === "win32" ? "tetherd.exe" : "tetherd";
const tetherdPath = path.join(
  repoRoot,
  "target",
  "release",
  executable,
);

const benchmarkRoot = await mkdtemp(
  path.join(os.tmpdir(), "tetherplane-bench-local-"),
);

try {
  const direct = await measureDirectAgent(benchmarkRoot);
  const mcp = await measureCompactMcp(benchmarkRoot);

  const result = {
    measured_at: new Date().toISOString(),
    commit_sha: commandOutput("git", ["rev-parse", "HEAD"], repoRoot),
    os: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model ?? "unknown",
    },
    runtime: {
      build_profile: "release",
      rust: commandOutput("rustc", ["--version"], repoRoot),
      node: process.version,
    },
    direct_agent: direct,
    compact_mcp: mcp,
    methodology: {
      temporary_data_root: true,
      idle_rss_wait_seconds: 10,
      file_fixture_lines: 1000,
      browser_provider: "not configured",
      desktop_provider:
        process.platform === "win32" ? "windows_uia" : "not configured",
    },
  };

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally {
  await rm(benchmarkRoot, { recursive: true, force: true });
}

async function measureDirectAgent(root: string) {
  const startedAt = performance.now();
  const child = spawn(
    tetherdPath,
    ["--stdio-rpc", "--allow", root],
    {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  const linePromise = firstStdoutLine(child);
  await onceSpawn(child);
  child.stdin.write(
    JSON.stringify(invocation("device.status", {})) + "\n",
  );

  const line = await withTimeout(
    linePromise,
    5_000,
    "timed out waiting for first device.status response",
  );
  const coldStartMs = performance.now() - startedAt;
  const response = JSON.parse(line) as Json;
  assert.equal(response.status, "success");

  await sleep(10_000);
  assert.ok(child.pid, "tetherd child has no PID");
  const idleRssBytes = readRssBytes(child.pid);

  child.stdin.end();
  await withTimeout(
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    3_000,
    "tetherd did not exit after stdin closed",
  );

  return {
    cold_start_to_first_device_status_ms: round(coldStartMs),
    idle_rss_bytes_after_10s: idleRssBytes,
    idle_rss_mib_after_10s: round(
      idleRssBytes / (1024 * 1024),
    ),
  };
}

async function measureCompactMcp(root: string) {
  const local = await startLocalCompact({ tetherdPath });
  try {
    const tools = await local.client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      "batch",
      "browser",
      "desktop",
      "device",
      "files",
      "process",
    ]);

    const fixture = Array.from(
      { length: 1000 },
      (_, index) =>
        `${String(index + 1).padStart(4, "0")} ${"x".repeat(76)}`,
    ).join("\n") + "\n";
    const fixturePath = path.join(local.root, "thousand-lines.txt");
    await writeFile(fixturePath, fixture, "utf8");

    const resultSizes: Record<string, unknown> = {};
    for (const mode of ["compact", "normal", "debug"] as const) {
      const result = await local.client.callTool({
        name: "files",
        arguments: {
          op: "read",
          response_mode: mode,
          args: { path: fixturePath },
        },
      });
      assert.ok(result.structuredContent);
      const structured = result.structuredContent as Json;
      const content =
        typeof structured.content === "string"
          ? structured.content
          : "";
      resultSizes[mode] = {
        structured_json_bytes: Buffer.byteLength(
          JSON.stringify(structured),
          "utf8",
        ),
        delivered_content_bytes: Buffer.byteLength(
          content,
          "utf8",
        ),
        truncated: structured.truncated === true,
        continuation:
          structured.continuation === null ||
          structured.continuation === undefined
            ? null
            : structured.continuation,
      };
    }

    let processRoundTrips = 0;
    const processResult = await local.client.callTool({
      name: "process",
      arguments: {
        op: "run",
        args:
          process.platform === "win32"
            ? {
                program: "cmd.exe",
                args: ["/C", "echo tetherplane-benchmark"],
                wait_ms: 1_000,
                pty: false,
              }
            : {
                program: "/bin/sh",
                args: ["-c", "printf 'tetherplane-benchmark\\n'"],
                wait_ms: 1_000,
                pty: false,
              },
      },
    });
    processRoundTrips += 1;
    assert.ok(processResult.structuredContent);
    assert.match(
      String(
        (processResult.structuredContent as Json).stdout ?? "",
      ),
      /tetherplane-benchmark/,
    );

    const batchFiles = ["a.txt", "b.txt", "c.txt"];
    await Promise.all(
      batchFiles.map((name, index) =>
        writeFile(
          path.join(local.root, name),
          `file-${index + 1}\n`,
          "utf8",
        ),
      ),
    );
    let batchRoundTrips = 0;
    const batch = await local.client.callTool({
      name: "batch",
      arguments: {
        op: "execute",
        args: {
          mode: "parallel",
          operations: batchFiles.map((name) => ({
            capability: "filesystem.read",
            arguments: { path: path.join(local.root, name) },
          })),
        },
      },
    });
    batchRoundTrips += 1;
    assert.ok(batch.structuredContent);
    const batchResults = (
      batch.structuredContent as Json
    ).results as Array<Json>;
    assert.equal(batchResults.length, 3);

    return {
      visible_tool_count: toolNames.length,
      visible_tools: toolNames,
      thousand_line_file_result_sizes: resultSizes,
      shell_command_ai_visible_round_trips: processRoundTrips,
      three_file_batch_ai_visible_round_trips: batchRoundTrips,
    };
  } finally {
    await local.close();
  }
}

function invocation(
  capability: string,
  argumentsValue: Json,
): Json {
  return {
    protocol_version: "1.0",
    request_id: randomUUID(),
    device_id: null,
    principal_id: null,
    job_id: null,
    capability,
    arguments: argumentsValue,
    actor: { id: "local-benchmark", kind: "ai_client" },
    session_id: null,
    response_mode: "compact",
    idempotency_key: null,
    preconditions: [],
    expectations: [],
  };
}

function firstStdoutLine(
  child: ReturnType<typeof spawn>,
): Promise<string> {
  assert.ok(child.stdout);
  const reader = createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    reader.once("line", (line) => {
      reader.close();
      resolve(line);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(
        new Error(
          `tetherd exited before responding (code=${String(code)})`,
        ),
      );
    });
  });
}

function onceSpawn(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.pid) {
      resolve();
      return;
    }
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

function readRssBytes(pid: number): number {
  if (process.platform === "win32") {
    const output = commandOutput(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${pid}).WorkingSet64`,
      ],
      repoRoot,
    );
    const bytes = Number(output);
    assert.ok(Number.isFinite(bytes) && bytes > 0);
    return bytes;
  }

  const output = commandOutput(
    "ps",
    ["-o", "rss=", "-p", String(pid)],
    repoRoot,
  );
  const kib = Number(output.trim());
  assert.ok(Number.isFinite(kib) && kib > 0);
  return kib * 1024;
}

function commandOutput(
  command: string,
  args: string[],
  cwd: string,
): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(message)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
