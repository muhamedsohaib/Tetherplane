import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  RelayServer,
  StaticClientAuthenticator,
  hashDeviceCredential,
} from "@tetherplane/relay";

// OpenCode mobility acceptance: one MCP session (the same connection an
// OpenCode remote MCP server holds) traverses RTX, Leno, Surface, and
// VAULTER through the existing six-tool surface without reconnecting,
// reconfiguring, or human relaying. Each node enforces its own local
// policy; reachability never implies permission.
const NODES = ["RTX", "Leno", "Surface", "VAULTER"] as const;
type NodeId = (typeof NODES)[number];

const NODE_CAPABILITIES: Record<NodeId, string[]> = {
  RTX: [
    "device.status",
    "device.capabilities",
    "filesystem.read",
    "filesystem.write",
    "process.run",
    "audit.read",
  ],
  Leno: [
    "device.status",
    "device.capabilities",
    "filesystem.read",
    "filesystem.write",
    "process.run",
    "audit.read",
  ],
  Surface: [
    "device.status",
    "device.capabilities",
    "filesystem.read",
    "filesystem.write",
    "process.run",
    "audit.read",
  ],
  // VAULTER is durable truth, not an execution node: reads and writes are
  // permitted, process execution is denied by its local profile.
  VAULTER: [
    "device.status",
    "device.capabilities",
    "filesystem.read",
    "filesystem.write",
    "audit.read",
  ],
};

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

function structured(
  result: Awaited<ReturnType<typeof call>>,
): Record<string, unknown> {
  assert.ok(result.structuredContent, "expected structuredContent");
  return result.structuredContent as Record<string, unknown>;
}

function errorCode(result: Awaited<ReturnType<typeof call>>): string {
  return String(
    (structured(result).error as { code?: unknown })?.code ?? "",
  );
}

function resolveTetherdPath(): string {
  const override = process.env.TETHERPLANE_TETHERD_PATH;
  if (override && override.trim()) {
    return override;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  const executable = process.platform === "win32" ? "tetherd.exe" : "tetherd";
  return path.join(repoRoot, "target", "debug", executable);
}

test(
  "opencode mobility: one session discovers, targets, and executes across RTX, Leno, Surface, VAULTER",
  { timeout: 180_000 },
  async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "..", "..");
    const temp = await mkdtemp(
      path.join(os.tmpdir(), "tetherplane-opencode-mobility-"),
    );
    const tetherdPath = resolveTetherdPath();
    const relayState = path.join(temp, "relay-devices.json");
    const token = "opencode-mobility-token";

    const relay = await RelayServer.create({
      stateFile: relayState,
      authenticator: new StaticClientAuthenticator([
        {
          token,
          accountId: "account-owner",
          clientId: "opencode",
          principalId: "human:owner",
        },
      ]),
      allowInsecureLocalhost: true,
      routeTimeoutMs: 5_000,
    });
    const address = await relay.listen({ host: "127.0.0.1", port: 0 });

    const roots = {} as Record<NodeId, string>;
    const children: Array<{ node: NodeId; child: ChildProcess }> = [];
    let client: Client | null = null;
    try {
      for (const node of NODES) {
        const nodeDir = path.join(temp, node);
        const allowedRoot = path.join(nodeDir, "allowed");
        const stateDir = path.join(nodeDir, "agent-state");
        const credentialFile = path.join(nodeDir, "device-credential.txt");
        const principalFile = path.join(nodeDir, "principal.json");
        roots[node] = allowedRoot;
        await mkdir(allowedRoot, { recursive: true });
        await mkdir(stateDir, { recursive: true });

        const secret = `opencode-mobility-${node}-secret-32-chars-min!!`;
        await writeFile(credentialFile, secret, "utf8");
        await writeFile(
          principalFile,
          JSON.stringify(
            {
              principal_id: `service:${node.toLowerCase()}-device`,
              authentication: "local_process_binding",
              allowed_devices: [node],
              allowed_capabilities: NODE_CAPABILITIES[node],
              allowed_roots: [allowedRoot],
            },
            null,
            2,
          ),
          "utf8",
        );

        const started = await jsonRequest(address.httpUrl, "/pair/start", {
          method: "POST",
          body: {
            deviceId: node,
            credentialHash: hashDeviceCredential(secret),
          },
        });
        assert.equal(started.status, 200, `pair/start failed for ${node}`);
        const approved = await jsonRequest(
          address.httpUrl,
          "/pair/approve",
          {
            method: "POST",
            token,
            body: { userCode: started.body.userCode },
          },
        );
        assert.equal(approved.status, 200, `pair/approve failed for ${node}`);

        const child = spawn(
          tetherdPath,
          [
            "--relay-url",
            address.deviceWsUrl,
            "--relay-allow-insecure-localhost",
            "--device-id",
            node,
            "--device-credential-file",
            credentialFile,
            "--allow",
            allowedRoot,
            "--principal-profile",
            principalFile,
            "--state-dir",
            stateDir,
          ],
          {
            cwd: repoRoot,
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
          },
        );
        children.push({ node, child });
      }

      for (const node of NODES) {
        await until(() => relay.router.isOnline(node), 10_000);
      }

      // Registry discovery: all four logical nodes resolve for this account.
      const listed = await jsonRequest(address.httpUrl, "/devices", {
        method: "GET",
        token,
      });
      assert.equal(listed.status, 200);
      const devices = (listed.body.devices ?? listed.body) as Array<{
        deviceId?: string;
        device_id?: string;
      }>;
      const ids = devices
        .map((device) => device.deviceId ?? device.device_id)
        .filter(Boolean);
      for (const node of NODES) {
        assert.ok(ids.includes(node), `registry must list ${node}: ${ids}`);
      }

      // One OpenCode-equivalent session for the whole traversal.
      client = await connectRemoteClient(address.mcpUrl, token, "opencode-mobility");
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name).sort(),
        ["batch", "browser", "desktop", "device", "files", "process"],
      );

      // DISCOVER: online state per node through the MCP surface itself.
      for (const node of NODES) {
        const status = structured(
          await call(client, "device", {
            op: "status",
            device: node,
            args: {},
          }),
        );
        assert.equal(status.policy_mode, "background_only", node);
      }

      // TARGET + EXECUTE + RETURN on Leno: seed the cross-node workflow.
      const seedPath = path.join(roots.Leno, "workflow-seed.txt");
      assert.equal(
        (
          await call(client, "files", {
            op: "write",
            device: "Leno",
            args: { path: seedPath, content: "seed:7\n" },
          })
        ).isError,
        undefined,
      );

      // CHANGE NODE to RTX: read Leno's seed, derive a result on RTX.
      const seed = structured(
        await call(client, "files", {
          op: "read",
          device: "Leno",
          args: { path: seedPath },
        }),
      );
      assert.equal(seed.content, "seed:7\n");
      const derived = `derived:${String(seed.content).trim()}:rtx\n`;
      const rtxPath = path.join(roots.RTX, "rtx-result.txt");
      assert.equal(
        (
          await call(client, "files", {
            op: "write",
            device: "RTX",
            args: { path: rtxPath, content: derived },
          })
        ).isError,
        undefined,
      );
      assert.equal(
        structured(
          await call(client, "files", {
            op: "read",
            device: "RTX",
            args: { path: rtxPath },
          }),
        ).content,
        derived,
      );

      // CHANGE NODE to VAULTER: persist RTX's result as durable truth.
      const vaultPath = path.join(roots.VAULTER, "durable-result.txt");
      assert.equal(
        (
          await call(client, "files", {
            op: "write",
            device: "VAULTER",
            args: {
              path: vaultPath,
              content: `durable:${derived}`,
            },
          })
        ).isError,
        undefined,
      );

      // CHANGE NODE to Surface: agent-owned browser-adjacent check is out of
      // scope for headless traversal; a process execution proves targeting.
      const surfaceRun = structured(
        await call(client, "process", {
          op: "run",
          device: "Surface",
          args:
            process.platform === "win32"
              ? {
                  program: "cmd.exe",
                  args: ["/C", "echo surface-ok"],
                  wait_ms: 5_000,
                }
              : {
                  program: "/bin/sh",
                  args: ["-c", "echo surface-ok"],
                  wait_ms: 5_000,
                },
        }),
      );
      assert.match(String(surfaceRun.stdout ?? ""), /surface-ok/);

      // CONTINUE TASK back on Leno: aggregate every node's evidence.
      const vaulted = structured(
        await call(client, "files", {
          op: "read",
          device: "VAULTER",
          args: { path: vaultPath },
        }),
      );
      const aggregatePath = path.join(roots.Leno, "aggregate.txt");
      const aggregate = `leno-seen:${String(seed.content).trim()}|${String(structured(await call(client, "files", { op: "read", device: "RTX", args: { path: rtxPath } })).content).trim()}|${String(vaulted.content).trim()}\n`;
      assert.equal(
        (
          await call(client, "files", {
            op: "write",
            device: "Leno",
            args: { path: aggregatePath, content: aggregate },
          })
        ).isError,
        undefined,
      );
      assert.equal(
        structured(
          await call(client, "files", {
            op: "read",
            device: "Leno",
            args: { path: aggregatePath },
          }),
        ).content,
        aggregate,
      );

      // POLICY: VAULTER denies process execution locally. Reachability is
      // not permission; the denial comes from the target node.
      const vaultDenied = await call(client, "process", {
        op: "run",
        device: "VAULTER",
        args:
          process.platform === "win32"
            ? { program: "cmd.exe", args: ["/C", "echo must-not-run"] }
            : { program: "/bin/sh", args: ["-c", "echo must-not-run"] },
      });
      assert.equal(vaultDenied.isError, true);
      assert.equal(errorCode(vaultDenied), "permission_denied");

      // OFFLINE: Surface is revoked through the relay's authenticated
      // management API. Revocation is permanent until re-pairing, so the
      // offline window is deterministic; the revoked agent also exits on
      // its own rather than being killed. The same session must report
      // `disconnected` for Surface while RTX, Leno, and VAULTER keep
      // working. A movable task is retargeted to Leno instead.
      const surface = children.find((entry) => entry.node === "Surface");
      assert.ok(surface);
      const revoked = await jsonRequest(
        address.httpUrl,
        "/devices/Surface/revoke",
        { method: "POST", token, body: {} },
      );
      assert.equal(revoked.status, 200);
      await until(() => surface.child.exitCode !== null, 10_000);
      await until(() => !relay.router.isOnline("Surface"), 10_000);

      const surfaceOffline = await call(client, "device", {
        op: "status",
        device: "Surface",
        args: {},
      });
      assert.equal(surfaceOffline.isError, true);
      assert.equal(errorCode(surfaceOffline), "permission_denied");

      for (const node of ["RTX", "Leno", "VAULTER"] as const) {
        const stillThere = await call(client, "device", {
          op: "status",
          device: node,
          args: {},
        });
        assert.equal(stillThere.isError, undefined, node);
      }

      // RAW OFFLINE: RTX's agent process dies without revocation. The same
      // session must report `disconnected` (paired but unreachable) while
      // Leno and VAULTER keep serving.
      const rtx = children.find((entry) => entry.node === "RTX");
      assert.ok(rtx);
      if (rtx.child.exitCode === null) {
        rtx.child.kill();
      }
      await waitForExit(rtx.child, 10_000);
      await until(() => !relay.router.isOnline("RTX"), 10_000);
      const rtxOffline = await call(client, "device", {
        op: "status",
        device: "RTX",
        args: {},
      });
      assert.equal(rtxOffline.isError, true);
      assert.equal(errorCode(rtxOffline), "disconnected");

      for (const node of ["Leno", "VAULTER"] as const) {
        const stillThere = await call(client, "device", {
          op: "status",
          device: node,
          args: {},
        });
        assert.equal(stillThere.isError, undefined, node);
      }

      const movedPath = path.join(roots.Leno, "moved-from-surface.txt");
      assert.equal(
        (
          await call(client, "files", {
            op: "write",
            device: "Leno",
            args: { path: movedPath, content: "movable-task-completed-on-leno\n" },
          })
        ).isError,
        undefined,
      );
    } finally {
      await client?.close().catch(() => undefined);
      for (const { child } of children) {
        if (child.exitCode === null) {
          child.kill();
        }
      }
      const reapDeadline = Date.now() + 5_000;
      for (const { child } of children) {
        while (child.exitCode === null && Date.now() < reapDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      await relay.close();
      await rm(temp, { recursive: true, force: true });
    }
  },
);

async function connectRemoteClient(
  mcpUrl: string,
  token: string,
  name: string,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return fetch(url, { ...init, headers });
    },
  });
  const client = new Client({ name, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport as never);
  return client;
}

async function jsonRequest(
  base: string,
  pathname: string,
  options: { method: "GET" | "POST"; token?: string; body?: Record<string, unknown> },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(base + pathname, {
    method: options.method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for mobility state");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("timed out waiting for agent exit")),
        timeoutMs,
      );
    }),
  ]);
}
