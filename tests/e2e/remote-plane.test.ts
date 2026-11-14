import { generateKeyPairSync, sign } from "node:crypto";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  RelayServer,
  StaticClientAuthenticator,
  OidcClientAuthenticator,
  hashDeviceCredential,
} from "@tetherplane/relay";

for (const authMode of ["static", "oidc"] as const) test(`${authMode} black-box remote plane preserves local authority across pairing routing reconnect idempotency and revocation`, async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "tetherplane-remote-e2e-"),
  );
  const allowedRoot = path.join(temp, "allowed");
  const outsideRoot = path.join(temp, "outside");
  const stateDir = path.join(temp, "agent-state");
  const relayState = path.join(temp, "relay-devices.json");
  const credentialFile = path.join(temp, "device-credential.txt");
  const principalFile = path.join(temp, "principal.json");
  const executable =
    process.platform === "win32" ? "tetherd.exe" : "tetherd";
  const tetherdPath = path.join(
    repoRoot,
    "target",
    "debug",
    executable,
  );
  const deviceSecret =
    "remote-e2e-device-secret-32-characters-minimum";

  await mkdir(allowedRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const outsideFile = path.join(outsideRoot, "outside.txt");
  await writeFile(outsideFile, "outside-secret", "utf8");
  await writeFile(credentialFile, deviceSecret, "utf8");
  await writeFile(
    principalFile,
    JSON.stringify(
      {
        principal_id: "service:remote-device",
        authentication: "local_process_binding",
        allowed_devices: ["Leno"],
        allowed_capabilities: [
          "device.status",
          "device.capabilities",
          "process.run",
          "operation.get",
          "filesystem.read",
          "filesystem.write",
          "filesystem.append",
          "filesystem.info",
          "audit.read",
        ],
        allowed_roots: [allowedRoot],
      },
      null,
      2,
    ),
    "utf8",
  );

  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const issuer = "https://identity.example/";
  const audience = "https://relay.example/mcp";
  const accessToken = (subject: string, clientId: string, scope = "tetherplane:access") => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, sub: subject, azp: clientId, exp: Math.floor(Date.now()/1000)+300, scope })).toString("base64url");
    const input = `${header}.${claims}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
  };
  const tokenA = authMode === "oidc" ? accessToken("owner-a", "client-a") : "remote-client-token-a";
  const tokenB = authMode === "oidc" ? accessToken("owner-b", "client-b") : "remote-client-token-b";
  const createRelay = () => RelayServer.create({
    stateFile: relayState,
    ...(authMode === "oidc" ? { oauth: { resource: audience, issuer, scopes: ["tetherplane:access"] } } : {}),
    authenticator: authMode === "oidc" ? new OidcClientAuthenticator({
      issuer, audience, jwksUri: "https://identity.example/jwks", scopes: ["tetherplane:access"],
      bindings: [
        { subject: "owner-a", clientId: "client-a", accountId: "account-a", principalId: "human:account-a" },
        { subject: "owner-b", clientId: "client-b", accountId: "account-b", principalId: "human:account-b" },
      ],
    }, async () => keys.publicKey) : new StaticClientAuthenticator([
      {
        token: tokenA,
        accountId: "account-a",
        clientId: "client-a",
        principalId: "human:account-a",
      },
      {
        token: tokenB,
        accountId: "account-b",
        clientId: "client-b",
        principalId: "human:account-b",
      },
    ]),
    allowInsecureLocalhost: true,
    routeTimeoutMs: 3_000,
  });
  let relay = await createRelay();
  let address = await relay.listen({
    host: "127.0.0.1",
    port: 0,
  });

  let child: ChildProcess | null = null;
  let clientA: Client | null = null;
  let clientB: Client | null = null;
  let statusClient: Client | null = null;

  try {
    const started = await jsonRequest(
      address.httpUrl,
      "/pair/start",
      {
        method: "POST",
        body: {
          deviceId: "Leno",
          credentialHash: hashDeviceCredential(deviceSecret),
        },
      },
    );
    assert.equal(started.status, 200);
    assert.equal(
      await relay.registry.authenticateDevice(
        "Leno",
        deviceSecret,
      ),
      null,
    );

    const approved = await jsonRequest(
      address.httpUrl,
      "/pair/approve",
      {
        method: "POST",
        token: tokenA,
        body: { userCode: started.body.userCode },
      },
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.body.accountId, "account-a");

    const stderr: string[] = [];
    child = spawn(
      tetherdPath,
      [
        "--relay-url",
        address.deviceWsUrl,
        "--relay-allow-insecure-localhost",
        "--device-id",
        "Leno",
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
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

    await until(
      () => relay.router.isOnline("Leno"),
      6_000,
      () => childStateError(child, stderr),
    );

    clientA = await connectRemoteClient(
      address.mcpUrl,
      tokenA,
      "remote-account-a",
      authMode === "oidc",
      authMode === "oidc" ? accessToken("owner-a", "client-a", "") : undefined,
    );
    clientB = await connectRemoteClient(
      address.mcpUrl,
      tokenB,
      "remote-account-b",
    );

    const remoteFile = path.join(allowedRoot, "remote.txt");
    const writeResult = await clientA.callTool({
      name: "files",
      arguments: {
        op: "write",
        device: "Leno",
        args: {
          path: remoteFile,
          content: "base\n",
        },
      },
    });
    assert.equal(writeResult.isError, undefined);

    const readResult = await clientA.callTool({
      name: "files",
      arguments: {
        op: "read",
        device: "Leno",
        args: { path: remoteFile },
      },
    });
    assert.equal(readResult.isError, undefined);
    assert.equal(
      String(structured(readResult).content),
      "base\n",
    );

    const deniedOutside = await clientA.callTool({
      name: "files",
      arguments: {
        op: "read",
        device: "Leno",
        args: { path: outsideFile },
      },
    });
    assert.equal(deniedOutside.isError, true);
    assert.equal(
      errorCode(deniedOutside),
      "permission_denied",
    );

    const crossAccount = await clientB.callTool({
      name: "device",
      arguments: {
        op: "status",
        device: "Leno",
      },
    });
    assert.equal(crossAccount.isError, true);
    assert.equal(errorCode(crossAccount), "permission_denied");

    const wrongDevice = await clientA.callTool({
      name: "device",
      arguments: {
        op: "status",
        device: "Surface",
      },
    });
    assert.equal(wrongDevice.isError, true);
    assert.equal(
      errorCode(wrongDevice),
      "capability_unavailable",
    );

    const appendArguments = {
      name: "files",
      arguments: {
        op: "append",
        device: "Leno",
        idempotency_key: "remote-e2e-append-once",
        args: {
          path: remoteFile,
          content: "once\n",
        },
      },
    } as const;
    const firstAppend = await clientA.callTool(appendArguments);
    assert.equal(firstAppend.isError, undefined);
    assert.equal(
      await readFile(remoteFile, "utf8"),
      "base\nonce\n",
    );

    const auditPath = path.join(
      stateDir,
      "audit",
      "events.jsonl",
    );
    await until(async () => {
      try {
        return (await readFile(auditPath, "utf8")).includes(
          '"capability":"filesystem.write"',
        );
      } catch {
        return false;
      }
    });
    const events = (await readFile(auditPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            principal_id: string | null;
            actor: { id: string };
            capability: string;
          },
      );
    const writeAudit = events.find(
      (event) => event.capability === "filesystem.write",
    );
    assert.ok(writeAudit);
    assert.equal(
      writeAudit.principal_id,
      "service:remote-device",
    );
    assert.equal(writeAudit.actor.id, "client-a");

    // Start an authorized operation that holds the ordinary execution lane.
    // The independent client must still be able to invoke device.status while
    // that operation is running, not merely after it finishes.
    statusClient = await connectRemoteClient(
      address.mcpUrl,
      tokenA,
      "remote-account-a-status-priority",
    );
    const workMarker = path.join(allowedRoot, "slow-work-started.txt");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(workMarker)}, "started"); setTimeout(() => {}, 3500);`;
    let ordinaryFinished = false;
    const slowWork = clientA.callTool({
      name: "process",
      arguments: {
        op: "run",
        device: "Leno",
        args: {
          program: process.execPath,
          args: ["-e", script],
          wait_ms: 2500,
        },
      },
    }).then((result) => {
      ordinaryFinished = true;
      return result;
    });
    await until(async () => {
      try {
        return (await readFile(workMarker, "utf8")) === "started";
      } catch {
        return false;
      }
    }, 2_000, () => childStateError(child, stderr));
    assert.equal(ordinaryFinished, false, "long-running operation must still be pending");
    const statusStart = Date.now();
    const priorityStatus = await statusClient.callTool({
      name: "device",
      arguments: { op: "status", device: "Leno" },
    });
    const statusMs = Date.now() - statusStart;
    assert.equal(priorityStatus.isError, undefined, "status remains authorized");
    assert.ok(statusMs < 1_000, `device.status took ${statusMs}ms under load`);
    assert.equal(ordinaryFinished, false, "status must complete before ordinary work");
    const slowResult = await slowWork;
    assert.equal(slowResult.isError, undefined, "long-running command still completes");
    console.log(`device.status priority under active process.run: ${statusMs}ms`);
    await statusClient.close();
    statusClient = null;

    // Supervised process.run survives WebSocket loss and writes its durable
    // completion receipt without automatically replaying the mutation.
    const interruptedMarker = path.join(allowedRoot, "interrupted-run.txt");
    const interruptedScript = `require("node:fs").appendFileSync(${JSON.stringify(interruptedMarker)}, "once\\n"); setTimeout(() => {}, 3000);`;
    const interruptedArguments = {
      name: "process",
      arguments: {
        op: "run",
        device: "Leno",
        idempotency_key: "remote-e2e-interrupted-process-once",
        args: {
          program: process.execPath,
          args: ["-e", interruptedScript],
          wait_ms: 5000,
        },
      },
    } as const;
    const operationGet = {
      name: "process",
      arguments: {
        op: "operation_get",
        device: "Leno",
        args: { idempotency_key: "remote-e2e-interrupted-process-once" },
      },
    } as const;
    const interruptedCall = clientA.callTool(interruptedArguments);
    await until(async () => {
      try {
        return (await readFile(interruptedMarker, "utf8")) === "once\n";
      } catch {
        return false;
      }
    }, 2_000, () => childStateError(child, stderr));
    statusClient = await connectRemoteClient(
      address.mcpUrl,
      tokenA,
      "remote-account-a-live-operation-inspection",
    );
    const pendingReceipt = await statusClient.callTool(operationGet);
    assert.equal(pendingReceipt.isError, undefined);
    assert.equal(
      structured(pendingReceipt).state,
      "unverified_or_in_flight",
      "receipt lookup must stay responsive during the running mutation",
    );
    await statusClient.close();
    statusClient = null;

    relay.deviceGateway.disconnectDevice("Leno");
    await until(() => !relay.router.isOnline("Leno"));
    const disconnectedCall = await interruptedCall;
    assert.equal(disconnectedCall.isError, true);
    assert.equal(errorCode(disconnectedCall), "disconnected");
    await until(
      () => relay.router.isOnline("Leno"),
      7_000,
      () => childStateError(child, stderr),
    );
    statusClient = await connectRemoteClient(
      address.mcpUrl,
      tokenA,
      "remote-account-a-operation-reconcile",
    );

    const deniedOperation = await clientB.callTool(operationGet);
    assert.equal(deniedOperation.isError, true);
    assert.equal(errorCode(deniedOperation), "permission_denied");

    // The same idempotency key is inspectable without spawning a new command.
    // The process may still be executing when the connection is restored.
    const initialReceipt = await statusClient.callTool(operationGet);
    assert.equal(initialReceipt.isError, undefined);
    assert.ok(
      ["unverified_or_in_flight", "invocation_completed"].includes(
        String(structured(initialReceipt).state),
      ),
      "operation.get must expose the durable receipt state",
    );

    await until(async () => {
      const receipt = await statusClient!.callTool(operationGet);
      if (receipt.isError) return false;
      return structured(receipt).state === "invocation_completed";
    }, 10_000, () => childStateError(child, stderr));
    const completedReceipt = await statusClient.callTool(operationGet);
    assert.equal(completedReceipt.isError, undefined);
    assert.equal(structured(completedReceipt).state, "invocation_completed");
    assert.equal(
      (structured(completedReceipt).result as { data?: { running?: boolean } }).data?.running,
      false,
      "receipt must report the terminated test subprocess",
    );
    const interruptedReplay = await clientA.callTool(interruptedArguments);
    assert.equal(interruptedReplay.isError, undefined, "completed receipt must replay without execution");
    assert.equal(
      await readFile(interruptedMarker, "utf8"),
      "once\n",
      "replay must not spawn a duplicate external process",
    );
    console.log("in-flight process.run disconnect: durable completion reconciled without replay");
    await statusClient.close();
    statusClient = null;

    const replayedAppend =
      await clientA.callTool(appendArguments);
    assert.equal(replayedAppend.isError, undefined);
    assert.equal(
      await readFile(remoteFile, "utf8"),
      "base\nonce\n",
      "same idempotency key after reconnect must not duplicate append",
    );

    // A full relay restart must not require restarting or re-pairing tetherd.
    // Rebind the same port and restore the registry from disk.
    const initialAgentPid = child.pid;
    const previousPort = address.port;
    await clientB?.close();
    clientB = null;
    await clientA?.close();
    clientA = null;
    await relay.close();

    relay = await createRelay();
    address = await relay.listen({ host: "127.0.0.1", port: previousPort });
    await until(
      () => relay.router.isOnline("Leno"),
      30_000,
      () => childStateError(child, stderr),
    );
    assert.equal(child.pid, initialAgentPid, "device process must survive relay restart");
    assert.equal(child.exitCode, null, "device process remains alive");
    clientA = await connectRemoteClient(address.mcpUrl, tokenA, "remote-account-a-restarted");
    const postRestartStatus = await clientA.callTool({
      name: "device",
      arguments: { op: "status", device: "Leno" },
    });
    assert.equal(postRestartStatus.isError, undefined);
    const postRestartAppend = await clientA.callTool(appendArguments);
    assert.equal(postRestartAppend.isError, undefined);
    assert.equal(
      await readFile(remoteFile, "utf8"),
      "base\nonce\n",
      "relay restart must not duplicate an idempotent mutation",
    );

    // Restart the agent process itself with the same owned state directory.
    // Completed receipts must remain available and cannot spawn a duplicate.
    const previousAgent = child;
    previousAgent.kill();
    await waitForExit(previousAgent, 7_000);
    await until(() => !relay.router.isOnline("Leno"));
    child = spawn(tetherdPath, previousAgent.spawnargs.slice(1), {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    await until(
      () => relay.router.isOnline("Leno"),
      10_000,
      () => childStateError(child, stderr),
    );
    const afterAgentRestart = await clientA.callTool({
      name: "process",
      arguments: {
        op: "operation_get",
        device: "Leno",
        args: { idempotency_key: "remote-e2e-interrupted-process-once" },
      },
    });
    assert.equal(afterAgentRestart.isError, undefined);
    assert.equal(structured(afterAgentRestart).state, "invocation_completed");
    const replayAfterAgentRestart = await clientA.callTool(interruptedArguments);
    assert.equal(replayAfterAgentRestart.isError, undefined);
    assert.equal(await readFile(interruptedMarker, "utf8"), "once\n");
    console.log("completed process receipt survived agent restart without duplicate execution");

    const revoked = await jsonRequest(
      address.httpUrl,
      "/devices/Leno/revoke",
      {
        method: "POST",
        token: tokenA,
        body: {},
      },
    );
    assert.equal(revoked.status, 200);
    await until(() => !relay.router.isOnline("Leno"));
    assert.equal(
      await relay.registry.authenticateDevice(
        "Leno",
        deviceSecret,
      ),
      null,
    );

    await waitForExit(child, 7_000);
    assert.notEqual(
      child.exitCode,
      0,
      "revoked tetherd must fail future relay authentication",
    );
  } finally {
    await statusClient?.close().catch(() => undefined);
    await clientB?.close().catch(() => undefined);
    await clientA?.close().catch(() => undefined);
    if (child && child.exitCode === null) {
      child.kill();
      await once(child, "exit").catch(() => undefined);
    }
    await relay.close();
    await rm(temp, { recursive: true, force: true });
  }
});

async function connectRemoteClient(
  mcpUrl: string,
  token: string,
  name: string,
  discoverBeforeLinking = false,
  staleToken?: string,
): Promise<Client> {
  let linked = !discoverBeforeLinking;
  const transport = new StreamableHTTPClientTransport(
    new URL(mcpUrl),
    {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        if (linked) headers.set("authorization", `Bearer ${token}`);
        else if (staleToken) headers.set("authorization", `Bearer ${staleToken}`);
        return fetch(url, { ...init, headers });
      },
    },
  );
  const client = new Client(
    { name, version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport as never);
  if (discoverBeforeLinking) {
    try {
      const session = transport.sessionId;
      assert.ok(session);
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["batch", "browser", "desktop", "device", "files", "process"]);
      for (const tool of listed.tools) assert.deepEqual(tool._meta?.securitySchemes, [{ type: "oauth2", scopes: ["tetherplane:access"] }]);
      const denied = await client.callTool({ name: "device", arguments: { op: "status", device: "Leno" } });
      assert.equal(denied.isError, true);
      assert.ok(denied._meta?.["mcp/www_authenticate"]);
      linked = true;
      const authorized = await client.callTool({ name: "device", arguments: { op: "status", device: "Leno" } });
      assert.equal(authorized.isError, undefined);
      assert.equal(transport.sessionId, session);
    } catch (error) {
      await client.close();
      throw error;
    }
  }
  return client;
}

function structured(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, any> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, any>;
}

function errorCode(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string {
  const body = structured(result);
  return String(
    (
      body.error as {
        code?: unknown;
      }
    )?.code ?? "",
  );
}

async function jsonRequest(
  base: string,
  pathname: string,
  options: {
    method: "POST";
    token?: string;
    body: Record<string, unknown>;
  },
): Promise<{
  status: number;
  body: Record<string, any>;
}> {
  const response = await fetch(base + pathname, {
    method: options.method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.token
        ? { authorization: `Bearer ${options.token}` }
        : {}),
    },
    body: JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text
      ? (JSON.parse(text) as Record<string, any>)
      : {},
  };
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
  onWait?: () => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    onWait?.();
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for remote-plane state");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function childStateError(
  child: ChildProcess | null,
  stderr: string[],
): void {
  if (!child || child.exitCode === null) return;
  throw new Error(
    `tetherd exited early with ${child.exitCode}: ${stderr.join("")}`,
  );
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("timed out waiting for tetherd exit")),
        timeoutMs,
      );
    }),
  ]);
}
