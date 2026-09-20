import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { startLocalCompact } from "./helpers/start-local.ts";

type DesktopNode = {
  reference: string;
  name: string;
  process_id: number;
  origin: string;
  patterns: string[];
};

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
  if (result.structuredContent) {
    return result.structuredContent as Record<string, unknown>;
  }

  const content = result.content as Array<{
    type?: unknown;
    text?: unknown;
  }>;
  const text = content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  assert.ok(
    text && typeof text.text === "string",
    "expected structuredContent or JSON text content",
  );
  return JSON.parse(text.text) as Record<string, unknown>;
}

function powershell(command: string): string {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Sta", "-Command", command],
    { encoding: "utf8" },
  ).trim();
}

function cursorPosition(): { x: number; y: number } {
  const value = powershell(
    "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output ($p.X.ToString()+','+$p.Y.ToString())",
  );
  const [x, y] = value.split(",").map(Number);
  assert.ok(Number.isInteger(x) && Number.isInteger(y));
  return { x: x as number, y: y as number };
}

function clipboardTextBase64(): string {
  return powershell(
    "Add-Type -AssemblyName System.Windows.Forms; $t=[System.Windows.Forms.Clipboard]::GetText(); Write-Output ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)))",
  );
}

async function readState(statePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
}

async function waitForState(
  statePath: string,
  predicate: (state: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const state = await readState(statePath);
      if (predicate(state)) return state;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("fixture state did not reach expected condition: " + String(lastError ?? ""));
}

function findPattern(
  nodes: DesktopNode[],
  pattern: string,
  nameIncludes?: string,
): DesktopNode {
  const node = nodes.find(
    (candidate) =>
      candidate.patterns.includes(pattern) &&
      (nameIncludes === undefined || candidate.name.includes(nameIncludes)),
  );
  assert.ok(node, "expected desktop node with pattern " + pattern);
  return node;
}

test(
  "Windows desktop coexists with a human window through Compact MCP",
  {
    // GitHub-hosted Windows runners do not provide the interactive desktop
    // required to certify UI Automation coexistence. This proof runs on
    // interactive Windows machines such as Leno.
    skip:
      process.platform !== "win32" ||
      process.env.GITHUB_ACTIONS === "true",
  },
  async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fixturePath = path.join(here, "fixtures", "windows-desktop-fixture.ps1");
    const temp = await mkdtemp(path.join(os.tmpdir(), "tetherplane-desktop-e2e-"));
    const ownedState = path.join(temp, "owned.json");
    const humanState = path.join(temp, "human.json");

    const local = await startLocalCompact();
    let ownedHandle: string | undefined;
    let humanProcess: ChildProcess | undefined;

    try {
      const listed = await local.client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name).sort(),
        ["batch", "browser", "desktop", "device", "files", "process"],
      );

      const capabilities = structured(
        await call(local.client, "device", {
          op: "capabilities",
          args: {},
          device: "Leno",
        }),
      );
      const providers = capabilities.providers as Array<Record<string, unknown>>;
      const desktop = providers.find((provider) => provider.namespace === "desktop");
      assert.equal(desktop?.available, true);

      const owned = structured(
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
              ownedState,
              "-Title",
              "Tetherplane Owned Desktop Fixture",
              "-Prefix",
              "Owned",
            ],
            wait_ms: 0,
            pty: false,
          },
        }),
      );
      ownedHandle = owned.handle as string;
      const ownedPid = owned.pid as number;
      await waitForState(ownedState, (state) => state.ready === true);

      humanProcess = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-Sta",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          fixturePath,
          "-StatePath",
          humanState,
          "-Title",
          "Tetherplane Human Desktop Fixture",
          "-Prefix",
          "Human",
        ],
        { stdio: "ignore", windowsHide: false },
      );
      assert.ok(humanProcess.pid);
      const humanPid = humanProcess.pid as number;
      await waitForState(
        humanState,
        (state) => state.ready === true && state.focused === true,
      );

      const snapshot = structured(
        await call(local.client, "desktop", {
          op: "snapshot",
          args: { max_nodes: 1000 },
        }),
      );
      const nodes = snapshot.nodes as DesktopNode[];
      const ownedNodes = nodes.filter((node) => node.process_id === ownedPid);
      const humanNodes = nodes.filter((node) => node.process_id === humanPid);
      assert.ok(ownedNodes.length > 0, "owned fixture was not observed");
      assert.ok(humanNodes.length > 0, "human fixture was not observed");
      assert.ok(ownedNodes.every((node) => node.origin === "tetherplane"));
      assert.ok(humanNodes.every((node) => node.origin === "human_or_external"));

      const valueNode = findPattern(ownedNodes, "value");
      const invokeNode = findPattern(ownedNodes, "invoke");
      const selectionNode =
        ownedNodes.find(
          (node) =>
            node.patterns.includes("selection") && node.name.includes("Beta"),
        ) ?? findPattern(ownedNodes, "selection");

      const cursorBefore = cursorPosition();
      const clipboardBefore = clipboardTextBase64();
      const humanBefore = await readState(humanState);
      assert.equal(humanBefore.focused, true);

      const valueResult = await call(local.client, "desktop", {
        op: "act",
        args: {
          reference: valueNode.reference,
          action: "set_value",
          value: "owned-semantic-value",
        },
      });
      assert.equal(valueResult.isError, undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(
        (await readState(humanState)).focused,
        true,
        "human fixture lost focus after semantic set_value",
      );

      const invokeResult = await call(local.client, "desktop", {
        op: "act",
        args: {
          reference: invokeNode.reference,
          action: "invoke",
        },
      });
      assert.equal(invokeResult.isError, undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(
        (await readState(humanState)).focused,
        true,
        "human fixture lost focus after semantic invoke",
      );

      const selectionResult = await call(local.client, "desktop", {
        op: "act",
        args: {
          reference: selectionNode.reference,
          action: "select",
        },
      });
      assert.equal(selectionResult.isError, undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(
        (await readState(humanState)).focused,
        true,
        "human fixture lost focus after semantic select",
      );

      const ownedAfter = await waitForState(
        ownedState,
        (state) =>
          state.text === "owned-semantic-value" &&
          state.status === "invoked" &&
          typeof state.selected === "string",
      );
      assert.equal(ownedAfter.text, "owned-semantic-value");
      assert.equal(ownedAfter.status, "invoked");

      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(cursorPosition(), cursorBefore);
      assert.equal(clipboardTextBase64(), clipboardBefore);
      assert.equal((await readState(humanState)).focused, true);

      const humanInvoke = findPattern(humanNodes, "invoke");
      const deniedHuman = await call(local.client, "desktop", {
        op: "act",
        args: {
          reference: humanInvoke.reference,
          action: "invoke",
          origin: "tetherplane",
        },
      });
      assert.equal(deniedHuman.isError, true);
      assert.equal(
        (structured(deniedHuman).error as Record<string, unknown>).code,
        "permission_denied",
      );

      const stale = await call(local.client, "desktop", {
        op: "act",
        args: {
          reference: "desk_ffffffffffffffff",
          action: "invoke",
        },
      });
      assert.equal(stale.isError, true);
      assert.equal(
        (structured(stale).error as Record<string, unknown>).code,
        "stale_reference",
      );

      const privateSet = await call(local.client, "desktop", {
        op: "private_clipboard_set",
        args: {
          text: "private-e2e-value",
          files: [path.join(temp, "artifact.txt")],
        },
      });
      assert.equal(privateSet.isError, undefined);
      const privateGet = structured(
        await call(local.client, "desktop", {
          op: "private_clipboard_get",
          args: {},
        }),
      );
      assert.equal(privateGet.text, "private-e2e-value");
      assert.equal(clipboardTextBase64(), clipboardBefore);

      const noLease = await call(local.client, "desktop", {
        op: "physical_pointer_move",
        args: {
          lease_id: "00000000-0000-4000-8000-000000000000",
          target_resource: "pointer",
          x: cursorBefore.x,
          y: cursorBefore.y,
        },
      });
      assert.equal(noLease.isError, true);
      assert.equal(
        (structured(noLease).error as Record<string, unknown>).code,
        "foreground_lease_required",
      );
      assert.deepEqual(cursorPosition(), cursorBefore);

      const selfMint = await call(local.client, "desktop", {
        op: "foreground_lease_acquire",
        args: {
          for_principal_id: "compact-mcp",
          target_resource: "pointer",
          capabilities: ["desktop.physical_pointer_move"],
          ttl_ms: 5000,
          reason: "AI must not self-mint foreground authority",
        },
      });
      assert.equal(selfMint.isError, true);
      assert.equal(
        (structured(selfMint).error as Record<string, unknown>).code,
        "permission_denied",
      );
    } finally {
      if (ownedHandle !== undefined) {
        await call(local.client, "process", {
          op: "terminate",
          args: { handle: ownedHandle, grace_ms: 100, force: true },
        }).catch(() => undefined);
      }
      if (humanProcess?.pid) {
        humanProcess.kill();
      }
      await local.close().catch(() => undefined);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
