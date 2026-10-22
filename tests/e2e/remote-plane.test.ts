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
  const relay = await RelayServer.create({
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
    routeTimeoutMs: 35_000,
  });
  const address = await relay.listen({
    host: "127.0.0.1",
    port: 0,
  });

  let child: ChildProcess | null = null;
  let clientA: Client | null = null;
  let clientB: Client | null = null;

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

    // End-to-end head-of-line test: real tetherd, real relay and MCP client.
    // A Tetherplane-owned child confirms the slow operation has actually
    // started before the independent control-plane request is sent.
    const slowMarker = path.join(allowedRoot, "stall-marker.txt");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(slowMarker)}, "started");setTimeout(() => {}, 4500)`;
    let slowFinished = false;
    const slowOperation = clientA.callTool({
      name: "process",
      arguments: {
        op: "run",
        device: "Leno",
        args: {
          program: process.execPath,
          args: ["-e", script],
          wait_ms: 2_200,
          pty: false,
        },
      },
    }).finally(() => { slowFinished = true; });
    await until(async () => {
      try {
        return await readFile(slowMarker, "utf8") === "started";
      } catch {
        return false;
      }
    }, 4_000, () => childStateError(child, stderr));
    assert.equal(slowFinished, false, "the work request must still be pending");

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const control = await Promise.race([
        clientA.callTool({
          name: "device",
          arguments: { op: "status", device: "Leno" },
        }),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("control-plane request blocked by slow operation")),
            1_500,
          );
        }),
      ]);
      assert.equal(control.isError, undefined);
      assert.equal(String(structured(control).policy_mode), "background_only");
      assert.equal(slowFinished, false, "status must complete before stalled work");
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    assert.equal((await slowOperation).isError, undefined);

    // Phase 2: saturate all 16 real agent work slots; require responsive
    // control calls and a prompt typed resource_conflict for the 17th.
    // No production device or external service is touched.
    const saturationLatenciesMs: number[] = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      const releaseFile = path.join(allowedRoot, `release-cycle-${cycle}`);
      const markers = Array.from({ length: 16 }, (_, i) =>
        path.join(allowedRoot, `work-${cycle}-${i}.marker`));
      const work = markers.map((workMarker) => {
        const script = `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(workMarker)},"start\\n");const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFile)})){clearInterval(t);process.exit(0)}},35);setTimeout(()=>process.exit(0),30000)`;
        return clientA!.callTool({
          name: "process",
          arguments: {
            op: "run", device: "Leno",
            args: { program: process.execPath, args: ["-e", script], wait_ms: 31_000, pty: false },
          },
        }).then(
          (result) => ({ result, error: null as string | null }),
          (error: unknown) => ({ result: null, error: String(error) }),
        );
      });
      try {
        await until(async () => {
          try {
            const values = await Promise.all(markers.map((p) => readFile(p, "utf8")));
            return values.every((x) => x === "start\n");
          } catch {
            return false;
          }
        }, 18_000, () => childStateError(child, stderr)).catch(async (error: unknown) => {
          const present = (await Promise.all(markers.map(async (p) =>
            readFile(p, "utf8").then(() => 1, () => 0)))).reduce((a, b) => a + b, 0);
          throw new Error(`saturation start: ${present}/16 markers observed; ${String(error)}`);
        });

        const overloadStart = performance.now();
        const overload: Awaited<ReturnType<Client["callTool"]>> = await Promise.race([
          clientA.callTool({ name: "files", arguments: {
            op: "info", device: "Leno", args: { path: allowedRoot },
          } }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("overload response exceeded 2s")), 1900)),
        ]);
        assert.equal(overload.isError, true, "the 17th work request must be rejected");
        assert.equal(errorCode(overload), "resource_conflict");
        assert.ok(performance.now() - overloadStart < 2_000, "work overload must fail promptly");

        // Keep <=2 control calls concurrently so this measures work-lane
        // isolation rather than intentional control-lane rejection.
        for (let batch = 0; batch < 6; batch++) {
          const calls = (["status", "capabilities"] as const).map(async (op) => {
            const startedAt = performance.now();
            const result = await clientA!.callTool({
              name: "device", arguments: { op, device: "Leno" },
            });
            const elapsedMs = performance.now() - startedAt;
            assert.equal(result.isError, undefined, `control ${op} failed in saturation`);
            if (op === "status") {
              const liveness = structured(result).agent_liveness as Record<string, unknown>;
              assert.equal(liveness?.process, "alive");
              assert.equal(liveness?.transport, "authenticated");
              assert.equal(liveness?.responsiveness, "responsive");
              assert.equal(liveness?.state, "saturated");
              assert.equal(liveness?.work_in_flight, 16);
              assert.equal(liveness?.work_capacity, 16);
              assert.equal(liveness?.control_capacity, 4);
            }
            assert.ok(elapsedMs < 2_000, `control ${op} exceeded 2s: ${elapsedMs}`);
            saturationLatenciesMs.push(elapsedMs);
          });
          await Promise.all(calls);
        }

        if (cycle === 1) {
          // Synthetic orderly WebSocket close, not a live TLS injection:
          // old provider tasks remain active, but their uncertain results
          // must not transfer to the new authenticated connection generation.
          relay.deviceGateway.disconnectDevice("Leno");
          await until(() => !relay.router.isOnline("Leno"), 2_000);
          await until(() => relay.router.isOnline("Leno"), 8_000,
            () => childStateError(child, stderr));

          const startedAt = performance.now();
          const reconnectedStatus = await clientA.callTool({
            name: "device", arguments: { op: "status", device: "Leno" },
          });
          const elapsedMs = performance.now() - startedAt;
          assert.equal(reconnectedStatus.isError, undefined);
          assert.ok(elapsedMs < 2_000, `reconnected control exceeded 2s: ${elapsedMs}`);
          saturationLatenciesMs.push(elapsedMs);

          const stillBusy = await clientA.callTool({
            name: "files", arguments: {
              op: "info", device: "Leno", args: { path: allowedRoot },
            },
          });
          assert.equal(errorCode(stillBusy), "resource_conflict",
            "reconnect must not reset work budget while old tasks remain active");

          const denied: Awaited<ReturnType<Client["callTool"]>> = await clientB.callTool({
            name: "device", arguments: { op: "status", device: "Leno" },
          });
          assert.equal(errorCode(denied), "permission_denied",
            "saturation and reconnect must not broaden account authority");
        }
      } finally {
        await writeFile(releaseFile, "release", "utf8");
      }
      const completed = await Promise.all(work);
      for (const outcome of completed) {
        assert.equal(outcome.error, null, `saturated MCP request transport: ${outcome.error}`);
        if (cycle === 1) {
          assert.equal(errorCode(outcome.result!), "disconnected",
            "an in-flight result lost across reconnect must remain uncertain");
        } else {
          assert.equal(outcome.result?.isError, undefined,
            "a released saturated operation must finish");
        }
      }
      await until(async () => {
        const recovered = await clientA!.callTool({
          name: "files",
          arguments: { op: "info", device: "Leno", args: { path: allowedRoot } },
        });
        return recovered.isError === undefined;
      }, 8_000, () => childStateError(child, stderr));
      for (const mark of markers) {
        assert.equal(await readFile(mark, "utf8"), "start\n", "no worker or mutation replay");
      }
    }
    const ordered = [...saturationLatenciesMs].sort((a: number, b: number) => a - b);
    const pct = (p: number) => Number(ordered[Math.ceil(p * ordered.length) - 1]!.toFixed(2));
    console.log(`SATURATION_E2E=${JSON.stringify({authMode, samples: ordered.length, p50_ms: pct(.50), p95_ms: pct(.95), max_ms: pct(1), cycles: 2, work_slots: 16})}`);

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

    relay.deviceGateway.disconnectDevice("Leno");
    await until(() => !relay.router.isOnline("Leno"));
    await until(
      () => relay.router.isOnline("Leno"),
      7_000,
      () => childStateError(child, stderr),
    );

    const replayedAppend =
      await clientA.callTool(appendArguments);
    assert.equal(replayedAppend.isError, undefined);
    assert.equal(
      await readFile(remoteFile, "utf8"),
      "base\nonce\n",
      "same idempotency key after reconnect must not duplicate append",
    );

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
