import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { startLocalCompact } from "./helpers/start-local.ts";

type DesktopNode = {
  reference: string;
  role?: string;
  name: string;
  automation_id?: string | null;
  class_name?: string | null;
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
  let lastState: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const state = await readState(statePath);
      lastState = state;
      lastError = undefined;
      if (predicate(state)) return state;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "fixture state did not reach expected condition; last_state=" +
      JSON.stringify(lastState ?? null) +
      "; last_read_error=" + String(lastError ?? "none"),
  );
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

async function stopSpawnedFixture(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;

  const waitForExit = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, 5_000);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
  // Windows child.kill() requests process termination, but the event is
  // asynchronous. Never delete fixture state until its writer exits.
  child.kill();
  return await waitForExit;
}

async function runDesktopCoexistenceTest(framework: "WinForms" | "Wpf") {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixturePath = path.join(here, "fixtures", "windows-desktop-fixture.ps1");
  const temp = await mkdtemp(
    path.join(os.tmpdir(), `tetherplane-desktop-e2e-${framework.toLowerCase()}-`),
  );
  const ownedState = path.join(temp, "owned.json");
  const humanState = path.join(temp, "human.json");

  const local = await startLocalCompact();
  let ownedHandle: string | undefined;
  let humanProcess: ChildProcess | undefined;
  let originalFailure: unknown;
  let selectionEvidence: Record<string, unknown> | undefined;

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
            `Tetherplane Owned ${framework} Fixture`,
            "-Prefix",
            "Owned",
            "-Framework",
            framework,
          ],
          wait_ms: 0,
          pty: false,
        },
      }),
    );
    ownedHandle = owned.handle as string;
    const ownedPid = owned.pid as number;
    await waitForState(
      ownedState,
      (state) => state.ready === true && state.framework === framework,
    );

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
        `Tetherplane Human ${framework} Fixture`,
        "-Prefix",
        "Human",
        "-Framework",
        framework,
      ],
      { stdio: "ignore", windowsHide: false },
    );
    assert.ok(humanProcess.pid);
    const humanPid = humanProcess.pid as number;
    await waitForState(
      humanState,
      (state) =>
        state.ready === true &&
        state.focused === true &&
        state.framework === framework,
    );
    const ownedBefore = await waitForState(
      ownedState,
      (state) => state.ready === true && state.focused === false,
    );
    assert.equal(ownedBefore.focused, false);

    const snapshot = structured(
      await call(local.client, "desktop", {
        op: "snapshot",
        args: { max_nodes: 1000 },
      }),
    );
    const nodes = snapshot.nodes as DesktopNode[];
    const ownedNodes = nodes.filter((node) => node.process_id === ownedPid);
    const humanNodes = nodes.filter((node) => node.process_id === humanPid);
    assert.ok(ownedNodes.length > 0, `${framework} owned fixture was not observed`);
    assert.ok(humanNodes.length > 0, `${framework} human fixture was not observed`);
    assert.ok(ownedNodes.every((node) => node.origin === "tetherplane"));
    assert.ok(humanNodes.every((node) => node.origin === "human_or_external"));

    const valueNode = findPattern(ownedNodes, "value");
    const invokeNode = findPattern(ownedNodes, "invoke");
    const selectionNode =
      ownedNodes.find(
        (node) =>
          node.patterns.includes("selection") && node.name.includes("Beta"),
      ) ?? ownedNodes.find((node) => node.patterns.includes("selection"));
    const listBoxNode = ownedNodes.find(
      (node) =>
        node.automation_id === "OwnedSelection" ||
        node.name.includes("Owned Selection") ||
        (node.class_name ?? "").toLowerCase().includes("listbox"),
    );

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
      `${framework} human fixture lost focus after semantic set_value`,
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
      `${framework} human fixture lost focus after semantic invoke`,
    );

    if (framework === "Wpf" || selectionNode !== undefined) {
      assert.ok(
        selectionNode,
        `${framework} expected desktop node with selection pattern`,
      );
      const selectionResult = await call(local.client, "desktop", {
        op: "act",
        args: {
          reference: selectionNode.reference,
          action: "select",
        },
      });
      selectionEvidence = {
        node: selectionNode,
        result: selectionResult,
      };
      assert.equal(selectionResult.isError, undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(
        (await readState(humanState)).focused,
        true,
        `${framework} human fixture lost focus after semantic select`,
      );
    } else {
      assert.ok(
        listBoxNode,
        "expected WinForms selection node or listbox container",
      );
      const degradedSelect = await call(local.client, "desktop", {
        op: "act",
        args: {
          reference: listBoxNode.reference,
          action: "select",
        },
      });
      assert.equal(degradedSelect.isError, true);
      assert.equal(
        (structured(degradedSelect).error as Record<string, unknown>).code,
        "capability_unavailable",
      );
    }

    const expectSelectedBeta =
      framework === "Wpf" ||
      Boolean(selectionNode && selectionNode.name.includes("Beta"));
    const ownedAfter = await waitForState(
      ownedState,
      (state) =>
        state.text === "owned-semantic-value" &&
        state.status === "invoked" &&
        (!expectSelectedBeta || state.selected === "Owned Beta"),
    );
    assert.equal(ownedAfter.text, "owned-semantic-value");
    assert.equal(ownedAfter.status, "invoked");
    assert.equal(ownedAfter.focused, false);
    if (expectSelectedBeta) {
      assert.equal(ownedAfter.selected, "Owned Beta");
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(cursorPosition(), cursorBefore);
    assert.equal(clipboardTextBase64(), clipboardBefore);
    const humanAfter = await readState(humanState);
    assert.equal(humanAfter.focused, true);
    assert.equal(humanAfter.text, "Human-initial");

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
  } catch (error) {
    originalFailure = error;
    // The interactive failure may happen before the test harness can assert
    // on a fixture's state. Capture only this disposable fixture's state
    // and the owned child's stderr before teardown; do not change policy.
    const detail: Record<string, unknown> = {
      framework,
      error: String(error),
      selection_evidence: selectionEvidence ?? null,
    };
    for (const [label, statePath] of [
      ["owned_state", ownedState],
      ["human_state", humanState],
    ] as const) {
      try {
        detail[label] = await readState(statePath);
      } catch (readError) {
        detail[label + "_error"] = String(readError);
      }
    }
    try {
      detail.owned_startup_stage = await readFile(ownedState + ".startup.txt", "utf8");
    } catch (readError) {
      detail.owned_startup_stage_error = String(readError);
    }
    if (ownedHandle) {
      try {
        const processResult = await call(local.client, "process", {
          op: "read",
          args: { handle: ownedHandle, mode: "tail", tail_bytes: 4096 },
        });
        detail.owned_process = structured(processResult);
      } catch (processError) {
        detail.owned_process_error = String(processError);
      }
    }
    console.error("G4_FIXTURE_FAILURE_CONTEXT=" + JSON.stringify(detail));
    throw error;
  } finally {
    const cleanupErrors: string[] = [];
    let ownedStopped = ownedHandle === undefined;
    if (ownedHandle !== undefined) {
      // This child is a fixture we started, not a general system process.
      // Ask the fixture to close itself, rather than bypass process.terminate's
      // intentional approval_required policy. Never erase its directory first.
      try {
        await writeFile(ownedState + ".stop", "close\n", "utf8");
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const read = await call(local.client, "process", {
            op: "read",
            args: { handle: ownedHandle, mode: "tail", tail_bytes: 1024 },
          });
          if (read.isError) {
            throw new Error("owned fixture status read rejected: " +
              JSON.stringify(structured(read)));
          }
          const status = structured(read);
          if (status.running === false) {
            ownedStopped = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (!ownedStopped) {
          cleanupErrors.push("owned fixture did not observe cooperative stop signal");
        }
      } catch (error) {
        cleanupErrors.push("owned fixture: " + String(error));
      }
    }

    let humanStopped = !humanProcess?.pid;
    if (humanProcess?.pid) {
      try {
        humanStopped = await stopSpawnedFixture(humanProcess);
        if (!humanStopped) cleanupErrors.push("human fixture exit timed out");
      } catch (error) {
        cleanupErrors.push("human fixture: " + String(error));
      }
    }

    await local.close().catch((error: unknown) => {
      cleanupErrors.push("local MCP close: " + String(error));
    });
    if (ownedStopped && humanStopped) {
      await rm(temp, { recursive: true, force: true });
    } else {
      cleanupErrors.push("fixture processes not confirmed stopped; retained state directory " + temp);
    }
    if (cleanupErrors.length > 0) {
      const message = "G4 fixture teardown incomplete: " + cleanupErrors.join("; ");
      console.error(message);
      // Preserve the original assertion failure if one led to teardown.
      if (originalFailure === undefined) throw new Error(message);
    }
  }
}

// A noninteractive process-launch check, distinct from the full G4 UIA gate.
// It constructs and exits GUI fixtures without showing windows, moving a
// cursor, accessing the clipboard, or taking any foreground focus.
test(
  "Windows Compact MCP launches nonvisible WinForms and WPF fixture constructors",
  // GitHub-hosted Windows CI runs without an interactive desktop; GUI-backed
  // PowerShell may remain alive without entering its script under that host.
  // Direct constructor preflight runs in CI; MCP child GUI launches require
  // an interactive disposable Windows Sandbox or staging desktop.
  {
    skip: process.platform !== "win32" || process.env.GITHUB_ACTIONS === "true",
    timeout: 80_000,
  },
  async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fixturePath = path.join(here, "fixtures", "windows-desktop-fixture.ps1");
    const local = await startLocalCompact();
    try {
      for (const framework of ["WinForms", "Wpf"] as const) {
        const statePath = path.join(local.root, "nonvisible-" + framework + ".json");
        const result = await call(local.client, "process", {
          op: "run",
          args: {
            program: "powershell.exe",
            args: [
              "-NoProfile", "-NonInteractive", "-Sta",
              "-ExecutionPolicy", "Bypass", "-File", fixturePath,
              "-StatePath", statePath, "-Title", "Nonvisible G4 MCP preflight",
              "-Prefix", "Owned", "-Framework", framework, "-InitializeOnly",
            ],
            wait_ms: 10000,
            pty: false,
          },
        });
        assert.equal(result.isError, undefined,
          framework + ": nonvisible process.run was denied");
        const processInfo = structured(result);
        assert.ok(typeof processInfo.handle === "string",
          framework + ": no owned process handle returned");

        // Establish that the same allowed process provider can launch a
        // non-GUI PowerShell command before attributing any stall to WPF.
        const canaryPath = path.join(local.root, "launch-canary-" + framework + ".txt");
        const canary = await call(local.client, "process", {
          op: "run",
          args: {
            program: "powershell.exe",
            args: [
              "-NoProfile", "-NonInteractive", "-Command",
              "[IO.File]::WriteAllText('" + canaryPath.replace(/'/g, "''") + "', 'canary-ok')",
            ],
            wait_ms: 5000,
            pty: false,
          },
        });
        const canaryResult = structured(canary);
        const canaryRead = await readFile(canaryPath, "utf8").catch(
          (err: unknown) => "READ_ERROR: " + String(err),
        );
        assert.equal(canaryRead, "canary-ok", framework +
          ": Tetherplane process.run PowerShell canary failed: " +
          JSON.stringify({
            launch: { pid: canaryResult.pid, running: canaryResult.running,
              exit_code: canaryResult.exit_code, stderr: canaryResult.stderr },
            canaryFile: canaryRead,
          }));
        let lastStage = "missing";
        let stageReached = false;
        let latestProcess: Record<string, unknown> = processInfo;
        const expected =
          framework === "WinForms"
            ? "stage=winforms-controls-created"
            : "stage=controls-created";
        for (let i = 0; i < 120; i += 1) {
          try {
            lastStage = await readFile(statePath + ".startup.txt", "utf8");
            if (lastStage.includes(expected)) {
              stageReached = true;
              break;
            }
          } catch {
            // Bootstrap may not have created its stage file yet.
          }
          if (i % 10 === 0) {
            const read = await call(local.client, "process", {
              op: "read",
              args: { handle: processInfo.handle, mode: "tail", tail_bytes: 2048 },
            });
            latestProcess = structured(read);
            if (latestProcess.running === false) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const launchedProcessDiagnostic = !stageReached ? powershell(
          "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " +
            String(processInfo.pid) + "' -ErrorAction SilentlyContinue;" +
          " if ($p) { $p | Select-Object ProcessId,ParentProcessId,Name," +
          "@{N='Executable';E={$_.ExecutablePath}} | ConvertTo-Json -Compress }" +
          " else { 'missing' }",
        ) : "not-needed";
        assert.equal(stageReached, true,
          framework + ": owned process did not initialize; last_stage=" + lastStage +
          "; process_cim=" + launchedProcessDiagnostic +
          "; child_status=" + JSON.stringify({
            pid: latestProcess.pid ?? processInfo.pid,
            running: latestProcess.running,
            exit_code: latestProcess.exit_code,
            stdout: latestProcess.stdout,
            stderr: latestProcess.stderr,
            terminal_reason: latestProcess.terminal_reason,
          }));
        assert.equal(await readFile(statePath, "utf8").then(
          () => true, () => false),
          false, framework + ": nonvisible fixture created a live window state");

        let stopped = processInfo.running === false;
        for (let i = 0; i < 60 && !stopped; i += 1) {
          const statusResult = await call(local.client, "process", {
            op: "read",
            args: { handle: processInfo.handle, mode: "tail", tail_bytes: 1024 },
          });
          assert.equal(statusResult.isError, undefined);
          stopped = structured(statusResult).running === false;
          if (!stopped) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(stopped, true,
          framework + ": nonvisible fixture did not exit on its own");
        console.log("G4_" + framework.toUpperCase() + "_MCP_NONVISIBLE_STARTUP=PASS");
      }
    } finally {
      await local.close();
    }
  },
);

const skipInteractiveWindowsDesktop =
  // GitHub-hosted Windows runners do not provide the interactive desktop
  // required to certify UI Automation coexistence. This proof runs on
  // interactive non-production Windows hosts or Windows Sandbox.
  process.platform !== "win32" || process.env.GITHUB_ACTIONS === "true";

test(
  "Windows WinForms desktop coexists with a human window through Compact MCP",
  { skip: skipInteractiveWindowsDesktop },
  async () => {
    await runDesktopCoexistenceTest("WinForms");
  },
);

test(
  "Windows WPF desktop coexists with an unfocused owned window and human window through Compact MCP",
  { skip: skipInteractiveWindowsDesktop },
  async () => {
    await runDesktopCoexistenceTest("Wpf");
  },
);
