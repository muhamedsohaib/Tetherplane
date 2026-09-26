import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  BrowserBridgeService,
  startBrowserRpcServer,
  type BrowserObservedState,
  type BrowserServiceBackend,
  type BrowserServicePage,
  type RawBrowserDiagnosticEvent,
  type RawBrowserDownload,
  type ResolvedBrowserAction,
} from "@tetherplane/browser-bridge";
import {
  LocalAgentClient,
  ModelActionError,
  ModelController,
  OpenAICompatibleModelClient,
} from "@tetherplane/model-client";
import {
  RelayServer,
  StaticClientAuthenticator,
  hashDeviceCredential,
} from "@tetherplane/relay";

import { startLocalCompact } from "./helpers/start-local.ts";

const SIX_TOOLS = ["batch", "browser", "desktop", "device", "files", "process"];

// Application Control on some Windows hosts blocks execution under the
// repository target/ directory. An explicit binary path keeps the contract
// runnable there without changing what is tested.
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
  const body = structured(result);
  return String((body.error as { code?: unknown })?.code ?? "");
}

test("opencode local client contract: six tools, discovery, safe execution, denials", async () => {
  const local = await startLocalCompact({ tetherdPath: resolveTetherdPath() });
  try {
    const listed = await local.client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      SIX_TOOLS,
    );

    const status = structured(
      await call(local.client, "device", { op: "status", args: {} }),
    );
    assert.equal(status.policy_mode, "background_only");

    const target = path.join(local.root, "opencode-proof.txt");
    const write = await call(local.client, "files", {
      op: "write",
      args: { path: target, content: "opencode-local\n" },
    });
    assert.equal(write.isError, undefined);

    const read = structured(
      await call(local.client, "files", {
        op: "read",
        args: { path: target },
      }),
    );
    assert.equal(read.content, "opencode-local\n");

    const runArgs =
      process.platform === "win32"
        ? { program: "cmd.exe", args: ["/C", "echo opencode-ok"], wait_ms: 5_000 }
        : { program: "/bin/sh", args: ["-c", "echo opencode-ok"], wait_ms: 5_000 };
    const ran = structured(
      await call(local.client, "process", { op: "run", args: runArgs }),
    );
    assert.match(String((ran.stdout as string) ?? ""), /opencode-ok/);

    const outside = path.resolve(local.root, "..", "opencode-outside.txt");
    const denied = await call(local.client, "files", {
      op: "read",
      args: { path: outside },
    });
    assert.equal(denied.isError, true);
    assert.equal(errorCode(denied), "permission_denied");

    const capabilities = structured(
      await call(local.client, "device", { op: "capabilities", args: {} }),
    );
    const providers = capabilities.providers as Array<
      Record<string, unknown>
    >;
    const desktopProvider = providers.find(
      (provider) => provider.namespace === "desktop",
    );
    assert.ok(
      desktopProvider,
      "device capabilities must advertise a desktop provider record",
    );
    assert.equal(typeof desktopProvider.available, "boolean");
    assert.ok(Array.isArray(desktopProvider.operations));

    const leaseDenied = await call(local.client, "desktop", {
      op: "foreground_lease_acquire",
      args: {
        for_principal_id: "model:opencode",
        target_resource: "pointer",
        capabilities: ["desktop.physical_pointer_move"],
        reason: "opencode contract proof",
      },
    });
    assert.equal(leaseDenied.isError, true);

    const pointerDenied = await call(local.client, "desktop", {
      op: "physical_pointer_move",
      args: {
        lease_id: "lease_does_not_exist",
        target_resource: "pointer",
        x: 10,
        y: 10,
      },
    });
    assert.equal(pointerDenied.isError, true);

    if (desktopProvider.available === true) {
      assert.ok(
        (desktopProvider.operations as unknown[]).length > 0,
        "an available desktop provider must advertise operations",
      );
      assert.equal(errorCode(leaseDenied), "permission_denied");
      assert.equal(errorCode(pointerDenied), "foreground_lease_required");
    } else {
      assert.deepEqual(desktopProvider.operations, []);
      assert.equal(errorCode(leaseDenied), "capability_unavailable");
      assert.equal(errorCode(pointerDenied), "capability_unavailable");
    }
  } finally {
    await local.close();
  }
});

class OpencodeFakeBrowserBackend implements BrowserServiceBackend {
  readonly human: BrowserServicePage = {
    page_id: "human:1",
    ownership: "human",
    active: true,
    url: "https://human.example/work",
  };
  readonly #agent = new Map<string, BrowserServicePage>();

  capabilities(): Record<string, unknown> {
    return { opencode_contract_fixture: true };
  }

  async pages(): Promise<BrowserServicePage[]> {
    return [structuredClone(this.human), ...this.#agent.values()];
  }

  async createTab(url: string): Promise<BrowserServicePage> {
    const page: BrowserServicePage = {
      page_id: `agent:${this.#agent.size + 1}`,
      ownership: "tetherplane",
      active: false,
      url,
    };
    this.#agent.set(page.page_id, page);
    return structuredClone(page);
  }

  async navigate(pageId: string, url: string): Promise<BrowserServicePage> {
    const page = this.#agent.get(pageId);
    assert.ok(page, `fake backend must not receive human navigation: ${pageId}`);
    page.url = url;
    return structuredClone(page);
  }

  async close(pageId: string): Promise<void> {
    this.#agent.delete(pageId);
  }

  async observe(pageId: string): Promise<BrowserObservedState> {
    return {
      page_id: pageId,
      url: "https://agent.example/",
      semantic_revision: 1,
      resource_revision: null,
      nodes: [],
      validation_messages: [],
      toasts: [],
    };
  }

  async perform(_pageId: string, _action: ResolvedBrowserAction): Promise<void> {
    // No-op: contract proves observation and ownership, not actuation.
  }

  async waitForSettled(
    pageId: string,
    _afterRevision: number,
    _timeoutMs: number,
  ): Promise<BrowserObservedState> {
    return this.observe(pageId);
  }

  async uploadFile(
    _pageId: string,
    _backendId: string,
    _filePath: string,
  ): Promise<void> {
    throw new Error("upload is not part of the opencode contract fixture");
  }

  async downloads(_pageId?: string): Promise<RawBrowserDownload[]> {
    return [];
  }

  async diagnostics(
    _pageId: string,
    _limit: number,
  ): Promise<RawBrowserDiagnosticEvent[]> {
    return [];
  }
}

test("opencode browser contract: agent-owned page succeeds, human-owned mutation is denied", async () => {
  const backend = new OpencodeFakeBrowserBackend();
  const bridge = await startBrowserRpcServer({
    host: "127.0.0.1",
    port: 0,
    token: "opencode-contract-token",
    service: new BrowserBridgeService({ backend }),
  });
  const local = await startLocalCompact({
    tetherdPath: resolveTetherdPath(),
    browserBridge: {
      address: bridge.address,
      token: "opencode-contract-token",
    },
  });
  try {
    const pages = structured(
      await call(local.client, "browser", { op: "pages", args: {} }),
    );
    const listed = pages.pages as Array<Record<string, unknown>>;
    const human = listed.find((page) => page.page_id === "human:1");
    assert.equal(human?.ownership, "human");

    const humanSnapshot = await call(local.client, "browser", {
      op: "snapshot",
      args: { page_id: "human:1" },
    });
    assert.equal(humanSnapshot.isError, undefined);

    const humanMutation = await call(local.client, "browser", {
      op: "navigate",
      args: {
        page_id: "human:1",
        url: "https://blocked.example/",
        ownership: "tetherplane",
      },
    });
    assert.equal(humanMutation.isError, true);
    assert.equal(errorCode(humanMutation), "permission_denied");

    const created = structured(
      await call(local.client, "browser", {
        op: "create_tab",
        args: { url: "https://agent.example/" },
      }),
    );
    assert.equal(created.ownership, "tetherplane");
    const pageId = created.page_id as string;

    const agentSnapshot = await call(local.client, "browser", {
      op: "snapshot",
      args: { page_id: pageId },
    });
    assert.equal(agentSnapshot.isError, undefined);
  } finally {
    await local.close();
    await bridge.close();
  }
});

test("opencode remote client contract: bearer auth, routing, offline, isolation", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  const temp = await mkdtemp(path.join(os.tmpdir(), "tetherplane-opencode-remote-"));
  const allowedRoot = path.join(temp, "allowed");
  const stateDir = path.join(temp, "agent-state");
  const relayState = path.join(temp, "relay-devices.json");
  const credentialFile = path.join(temp, "device-credential.txt");
  const principalFile = path.join(temp, "principal.json");
  const tetherdPath = resolveTetherdPath();
  const deviceSecret = "opencode-contract-device-secret-32-chars-min";

  await mkdir(allowedRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(credentialFile, deviceSecret, "utf8");
  await writeFile(
    principalFile,
    JSON.stringify(
      {
        principal_id: "service:opencode-device",
        authentication: "local_process_binding",
        allowed_devices: ["Leno"],
        allowed_capabilities: [
          "device.status",
          "device.capabilities",
          "filesystem.read",
          "filesystem.write",
        ],
        allowed_roots: [allowedRoot],
      },
      null,
      2,
    ),
    "utf8",
  );

  const tokenA = "opencode-contract-token-a";
  const tokenB = "opencode-contract-token-b";
  const relay = await RelayServer.create({
    stateFile: relayState,
    authenticator: new StaticClientAuthenticator([
      { token: tokenA, accountId: "account-a", clientId: "opencode-a", principalId: "human:account-a" },
      { token: tokenB, accountId: "account-b", clientId: "opencode-b", principalId: "human:account-b" },
    ]),
    allowInsecureLocalhost: true,
    routeTimeoutMs: 3_000,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });

  let child: ChildProcess | null = null;
  let client: Client | null = null;
  try {
    const started = await jsonRequest(address.httpUrl, "/pair/start", {
      method: "POST",
      body: { deviceId: "Leno", credentialHash: hashDeviceCredential(deviceSecret) },
    });
    assert.equal(started.status, 200);

    const approved = await jsonRequest(address.httpUrl, "/pair/approve", {
      method: "POST",
      token: tokenA,
      body: { userCode: started.body.userCode },
    });
    assert.equal(approved.status, 200);

    child = spawn(
      tetherdPath,
      [
        "--relay-url", address.deviceWsUrl,
        "--relay-allow-insecure-localhost",
        "--device-id", "Leno",
        "--device-credential-file", credentialFile,
        "--allow", allowedRoot,
        "--principal-profile", principalFile,
        "--state-dir", stateDir,
      ],
      { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    await until(() => relay.router.isOnline("Leno"), 6_000);

    client = await connectRemoteClient(address.mcpUrl, tokenA, "opencode-contract");
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      SIX_TOOLS,
    );

    const status = structured(
      await call(client, "device", { op: "status", device: "Leno", args: {} }),
    );
    assert.equal(status.policy_mode, "background_only");

    const remoteFile = path.join(allowedRoot, "opencode-remote.txt");
    assert.equal(
      (await call(client, "files", {
        op: "write", device: "Leno", args: { path: remoteFile, content: "via-relay\n" },
      })).isError,
      undefined,
    );
    const read = structured(
      await call(client, "files", {
        op: "read", device: "Leno", args: { path: remoteFile },
      }),
    );
    assert.equal(read.content, "via-relay\n");

    const outsider = await connectRemoteClient(address.mcpUrl, tokenB, "opencode-outsider");
    try {
      const crossAccount = await call(outsider, "device", {
        op: "status", device: "Leno", args: {},
      });
      assert.equal(crossAccount.isError, true);
      assert.equal(errorCode(crossAccount), "permission_denied");
    } finally {
      await outsider.close();
    }

    await assert.rejects(() => connectRemoteClient(address.mcpUrl, "wrong-token", "opencode-bad-auth"));

    child.kill();
    await waitForExit(child, 10_000);
    child = null;
    await until(() => !relay.router.isOnline("Leno"), 6_000);
    const offline = await call(client, "files", {
      op: "read", device: "Leno", args: { path: remoteFile },
    });
    assert.equal(offline.isError, true);
    assert.equal(errorCode(offline), "disconnected");
  } finally {
    await client?.close().catch(() => undefined);
    if (child && child.exitCode === null) {
      child.kill();
      await waitForExit(child, 5_000).catch(() => undefined);
    }
    await relay.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("opencode model routing contract: RTX-style OpenAI-compatible model proposes, Tetherplane authorizes", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "tetherplane-opencode-model-sandbox-"));
  const controlRoot = await mkdtemp(path.join(os.tmpdir(), "tetherplane-opencode-model-control-"));
  const stateDir = path.join(controlRoot, "state");
  const profilePath = path.join(controlRoot, "principal.json");
  const target = path.join(sandbox, "rtx-decision.txt");
  const tetherdPath = resolveTetherdPath();

  await writeFile(
    profilePath,
    JSON.stringify(
      {
        principal_id: "model:rtx-coding",
        authentication: "local_process_binding",
        allowed_devices: ["Leno"],
        allowed_capabilities: ["filesystem.write", "filesystem.read"],
        allowed_roots: [sandbox],
      },
      null,
      2,
    ),
    "utf8",
  );

  const seenModels: string[] = [];
  const fakeModel = await startFakeModel(
    [
      { capability: "filesystem.write", arguments: { path: target, content: "rtx-chose-this\n" }, device: "Leno" },
      { capability: "filesystem.read", arguments: { path: target }, device: "Leno" },
    ],
    seenModels,
  );

  // The model id is configuration, not control-layer code: swapping it
  // must not change Tetherplane itself.
  const modelId = "rtx-coding-local";
  const agent = await LocalAgentClient.spawn({
    tetherdPath,
    tetherdArgs: ["--principal-profile", profilePath, "--allow", sandbox, "--state-dir", stateDir],
  });
  const model = new OpenAICompatibleModelClient({ endpoint: fakeModel.endpoint, model: modelId });
  const controller = new ModelController({ model, agent });

  try {
    const write = await controller.executeNext({ objective: "record the routing decision" });
    assert.equal(write.status, "success");

    const read = await controller.executeNext({ objective: "read the routing decision back" });
    assert.equal(read.status, "success");
    assert.equal((read.data as Record<string, unknown>).content, "rtx-chose-this\n");
    assert.deepEqual(seenModels, [modelId, modelId]);

    const smuggledServer = await startFakeModelWithAction({
      capability: "filesystem.read",
      arguments: { path: target },
      device: "Leno",
      principal_id: "human:owner",
    });
    const smuggled = new OpenAICompatibleModelClient({
      endpoint: smuggledServer.endpoint,
      model: modelId,
    });
    try {
      await assert.rejects(
        () => smuggled.nextAction({ objective: "escalate principal" }),
        ModelActionError,
      );
    } finally {
      await smuggledServer.close();
    }
  } finally {
    await agent.close().catch(() => undefined);
    await fakeModel.close();
    await rm(sandbox, { recursive: true, force: true });
    await rm(controlRoot, { recursive: true, force: true });
  }
});

async function startFakeModel(
  actions: Array<Record<string, unknown>>,
  seenModels: string[],
): Promise<{ endpoint: string; close(): Promise<void> }> {
  const queue = [...actions];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
    }
    const payload = JSON.parse(body) as Record<string, unknown>;
    seenModels.push(String(payload.model));
    const action = queue.shift();
    if (!action) {
      response.statusCode = 500;
      response.end("no queued action");
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(action) } }] }),
    );
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function startFakeModelWithAction(
  action: Record<string, unknown>,
): Promise<{ endpoint: string; close(): Promise<void> }> {
  const seen: string[] = [];
  const handle = await startFakeModel([action], seen);
  const originalClose = handle.close;
  return {
    endpoint: handle.endpoint,
    async close() {
      await originalClose();
    },
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

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
  options: { method: "POST"; token?: string; body: Record<string, unknown> },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(base + pathname, {
    method: options.method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for opencode contract state");
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
