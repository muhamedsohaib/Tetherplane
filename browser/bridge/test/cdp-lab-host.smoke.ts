import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startBrowserLab } from "@tetherplane/browser-lab";

type RpcResponse = {
  status: "success" | "error";
  data?: Record<string, unknown>;
  error?: { code: string };
};

function rpc(
  address: string,
  token: string,
  capability: string,
  args: Record<string, unknown>,
): Promise<RpcResponse> {
  const port = Number(address.split(":").at(-1));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, "127.0.0.1");
    socket.setTimeout(8_000);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.once("connect", () => {
      socket.write(
        JSON.stringify({
          type: capability === "handshake" ? "handshake" : "invoke",
          request_id: randomBytes(8).toString("hex"),
          token,
          ...(capability !== "handshake" ? { capability, arguments: args } : {}),
        }) + "\n",
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) return;
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, boundary)) as RpcResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("timeout", () => socket.destroy(new Error("RPC_TIMEOUT")));
    socket.once("error", reject);
  });
}

function waitForReady(
  child: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => fail(new Error("CDP_LAB_START_TIMEOUT")), timeoutMs);
    function fail(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /CDP_LAB_RPC_READY=(127\.0\.0\.1:[0-9]+)/.exec(output);
      if (match?.[1] && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("error", (error) => fail(error));
    child.once("exit", () => fail(new Error("CDP_LAB_EXITED_BEFORE_READY")));
  });
}

async function stopHost(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const complete = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("CDP_LAB_SHUTDOWN_TIMEOUT")),
      20_000,
    );
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error("CDP_LAB_EXIT_CODE_" + String(code)));
    });
  });
  child.stdin?.write("STOP_CDP_LAB\n");
  await complete;
}

for (const privatePipe of [false, true] as const) {
test(
  privatePipe
    ? "private-pipe CDP lab host authenticates and enforces site grants through RPC"
    : "extension-free CDP lab host authenticates, performs verified actions and denies unrelated sites",
  { timeout: 100_000 },
  async () => {
    const lab = await startBrowserLab();
    const root = await mkdtemp(path.join(os.tmpdir(), "tetherplane-cdp-lab-smoke-"));
    const tokenPath = path.join(root, "agent.token");
    const token = randomBytes(32).toString("hex");
    await writeFile(tokenPath, token + "\n", { mode: 0o600 });

    const scriptPath = fileURLToPath(
      new URL("../../../scripts/browser-cdp-lab-host.ts", import.meta.url),
    );
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const child = spawn(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TETHERPLANE_CDP_LAB_MODE: "1",
        TETHERPLANE_CDP_LAB_ORIGIN: lab.origin,
        TETHERPLANE_CDP_LAB_TOKEN_FILE: tokenPath,
        TETHERPLANE_CDP_LAB_TEST_STDIN_STOP: "1",
        ...(privatePipe
          ? {
              TETHERPLANE_CDP_LAB_PRIVATE_PIPE: "1",
              ...(process.platform === "win32"
                ? { TETHERPLANE_CHROMIUM:
                    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }
                : {}),
            }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    try {
      const address = await waitForReady(child, 40_000);
      const unauthorized = await rpc(address, "incorrect-local-token", "handshake", {});
      assert.equal(unauthorized.status, "error");
      assert.equal(unauthorized.error?.code, "permission_denied");

      const handshake = await rpc(address, token, "handshake", {});
      assert.equal(handshake.status, "success");
      assert.ok((handshake.data?.operations as string[]).includes("act"));
      assert.ok(!(handshake.data?.operations as string[]).includes("upload"));

      const denied = await rpc(address, token, "browser.create_tab", {
        url: "https://example.com/private",
      });
      assert.equal(denied.status, "error");
      assert.equal(denied.error?.code, "permission_denied");

      const created = await rpc(address, token, "browser.create_tab", {
        url: lab.origin,
      });
      assert.equal(created.status, "success");
      const pageId = created.data?.page_id;
      assert.equal(typeof pageId, "string");

      // A model can embed a navigation inside browser.act. It must be
      // rejected before any Chromium/CDP action, not only after redirect.
      const nested = await rpc(address, token, "browser.act", {
        page_id: pageId,
        mode: "background_only",
        actions: [
          { kind: "navigate", url: "https://unapproved.example/outbound" },
        ],
      });
      assert.equal(nested.status, "error");
      assert.equal(nested.error?.code, "permission_denied");

      const forgedGrant = await rpc(address, token, "browser.grant", {
        origin: "https://unapproved.example",
        operations: ["navigate", "act"],
      });
      assert.equal(forgedGrant.status, "error");
      assert.equal(forgedGrant.error?.code, "permission_denied");

      const snapshot = await rpc(address, token, "browser.snapshot", {
        page_id: pageId,
      });
      assert.equal(snapshot.status, "success");
      const nodes = snapshot.data?.nodes as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(nodes));
      const textbox = nodes.find(
        (node) => node.role === "textbox" && node.accessible_name === "Project value",
      );
      const save = nodes.find(
        (node) => node.role === "button" && node.accessible_name === "Save",
      );
      assert.ok(textbox?.ref);
      assert.ok(save?.ref);

      const action = await rpc(address, token, "browser.act", {
        page_id: pageId,
        mode: "background_only",
        actions: [
          { kind: "fill", target: textbox.ref, value: "cdp-lab-smoke-saved" },
          { kind: "click", target: save.ref },
        ],
        expectations: [{ kind: "toast", includes: "Saved" }],
        timeout_ms: 8_000,
      });
      assert.equal(action.status, "success");
      assert.equal(action.data?.state, "verified");

      const saved = await fetch(new URL("/api/state", lab.origin));
      const state = (await saved.json()) as { value: string };
      assert.equal(state.value, "cdp-lab-smoke-saved");

      const unrelated = await rpc(address, token, "browser.navigate", {
        page_id: pageId,
        url: "https://unapproved.example/",
      });
      assert.equal(unrelated.status, "error");
      assert.equal(unrelated.error?.code, "permission_denied");

      const upload = await rpc(address, token, "browser.upload", {
        page_id: pageId,
        file_path: tokenPath,
      });
      assert.equal(upload.status, "error");
      assert.equal(upload.error?.code, "permission_denied");

      const pages = await rpc(address, token, "browser.pages", {});
      assert.equal(pages.status, "success");
      assert.equal((pages.data?.pages as unknown[]).length, 1);
      await stopHost(child);

      assert.ok(stdout.includes("CDP_LAB_SHUTDOWN=COMPLETE"));
      if (privatePipe) {
        assert.ok(
          stdout.includes("CDP_LAB_TRANSPORT=PRIVATE_PIPE"),
          "test requires proof the authenticated bridge used private CDP",
        );
      }
      assert.equal(stdout.includes(token), false);
      assert.equal(stderr.includes(token), false);
    } finally {
      if (child.exitCode === null) child.kill();
      await lab.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
}
