import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startLocalCompact } from "./helpers/start-local.ts";

type State = {
  ready: boolean; focused: boolean; selected: string | null;
  selected_index: number; selection_events: number; pid: number;
};
type Node = {
  reference: string; name: string; patterns: string[];
  process_id: number; origin: string;
};
async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}
function structured(result: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent as Record<string, unknown>;
  const text = (result.content as Array<{ type?: unknown; text?: unknown }>).find(
    (part) => part.type === "text" && typeof part.text === "string",
  )?.text;
  assert.equal(typeof text, "string", "expected structured MCP result");
  return JSON.parse(text as string) as Record<string, unknown>;
}
function desktopMetadata() {
  // Read only foreground HWND, cursor position and clipboard sequence, not user data.
  const script = [
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class TetherplaneSelectionProbe {",
    "  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] public static extern bool GetCursorPos(out Point point);",
    "  [DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber();",
    "  public static string Read() {",
    "    Point p; if (!GetCursorPos(out p)) throw new InvalidOperationException(\"cursor probe unavailable\");",
    "    return string.Format(\"{0},{1},{2},{3}\", GetForegroundWindow().ToInt64(), p.X, p.Y, GetClipboardSequenceNumber());",
    "  }",
    "}",
    "'@",
    "[TetherplaneSelectionProbe]::Read()",
  ].join("\n");
  const raw = execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", script,
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true }).trim();
  const values = raw.split(",").map(Number);
  assert.equal(values.length, 4);
  assert.ok(values.every(Number.isSafeInteger));
  return { foreground: values[0]!, x: values[1]!, y: values[2]!, clipboardSequence: values[3]! };
}
async function waitForState(pathToState: string, predicate: (state: State) => boolean) {
  let last: State | undefined;
  for (let i = 0; i < 120; i++) {
    try {
      last = JSON.parse(await readFile(pathToState, "utf8")) as State;
      if (predicate(last)) return last;
    } catch {
      // The test-owned form writes its state every 100ms.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("WinForms app state did not converge: " + JSON.stringify(last));
}

test("Windows background-only UIA selection reconciles managed state without focus", {
  skip: process.platform !== "win32" || process.env.GITHUB_ACTIONS === "true",
  timeout: 75_000,
}, async (t) => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "windows-desktop-fixture.ps1");
  const temp = await mkdtemp(path.join(os.tmpdir(), "tetherplane-selection-background-"));
  const statePath = path.join(temp, "state.json");
  const stopPath = path.join(temp, "stop");
  const local = await startLocalCompact();
  let fixtureHandle: string | undefined;
  let fixtureExited = false;
  try {
    const listed = await local.client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(),
      ["batch", "browser", "desktop", "device", "files", "process"]);
    const before = desktopMetadata();
    const processResult = await call(local.client, "process", {
      op: "run",
      args: {
        program: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass",
          "-File", fixture, "-StatePath", statePath, "-Title", "Tetherplane Offscreen Fixture",
          "-Prefix", "Background", "-BackgroundOnly", "-LifetimeMs", "45000",
          "-StopPath", stopPath],
        wait_ms: 0, pty: false,
      },
    });
    assert.equal(processResult.isError, undefined, "fixture failed to start");
    const started = structured(processResult);
    assert.equal(typeof started.pid, "number");
    assert.equal(typeof started.handle, "string");
    fixtureHandle = started.handle as string;
    const initial = await waitForState(statePath,
      (s) => s.ready && s.selected === "Background Alpha");
    assert.equal(initial.focused, false);
    assert.equal(initial.selected_index, 0);
    assert.equal(initial.pid, started.pid);
    assert.deepEqual(desktopMetadata(), before, "offscreen fixture took human foreground");

    const snapshotResult = await call(local.client, "desktop",
      { op: "snapshot", args: { max_nodes: 1000 } });
    assert.equal(snapshotResult.isError, undefined);
    const nodes = (structured(snapshotResult).nodes as Node[])
      .filter((node) => node.process_id === started.pid);
    const beta = nodes.find((node) =>
      node.patterns.includes("selection") && node.name.includes("Beta"));
    assert.ok(beta, "owned offscreen WinForms Beta item absent from UIA snapshot");
    assert.equal(beta.origin, "tetherplane", "candidate must authorize selection from trusted ownership");

    const result = await call(local.client, "desktop", {
      op: "act", args: { reference: beta.reference, action: "select" },
    });
    assert.equal(result.isError, undefined, "background select was rejected");
    const outcome = structured(result);
    const after = await waitForState(statePath, (s) =>
      s.selected === "Background Beta" && s.selected_index === 1 &&
      s.selection_events > initial.selection_events);
    assert.equal(after.selection_events, initial.selection_events + 1);
    assert.equal(after.focused, false);
    assert.equal(outcome.verified, true);
    assert.deepEqual(desktopMetadata(), before, "selection altered foreground/cursor/clipboard");
    t.diagnostic("UIA_SELECTION " + JSON.stringify({
      before: initial.selected, after: after.selected,
      eventDelta: after.selection_events - initial.selection_events,
      verified: outcome.verified,
    }));
  } finally {
    await writeFile(stopPath, "stop", "utf8").catch(() => undefined);
    if (fixtureHandle) {
      for (let i = 0; i < 30; i++) {
        const result = await call(local.client, "process", {
          op: "read", args: { handle: fixtureHandle, timeout_ms: 100 },
        }).catch(() => undefined);
        if (result && !result.isError && structured(result).running === false) {
          fixtureExited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await local.close().catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  }
  assert.equal(fixtureExited, true, "test-owned WinForms process did not exit after stop signal");
});
