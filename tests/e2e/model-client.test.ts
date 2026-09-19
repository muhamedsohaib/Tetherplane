import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  LocalAgentClient,
  ModelController,
  OpenAICompatibleModelClient,
} from "@tetherplane/model-client";

type ModelAction = Record<string, unknown>;

async function startFakeModel(actions: ModelAction[]) {
  const queue = [...actions];
  const seenModels: string[] = [];
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
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(action),
            },
          },
        ],
      }),
    );
  });

  await listen(server);
  const address = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    seenModels,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
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

test("generic model client drives tetherd directly without MCP", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  const sandbox = await mkdtemp(
    path.join(os.tmpdir(), "tetherplane-model-client-sandbox-"),
  );
  const controlRoot = await mkdtemp(
    path.join(os.tmpdir(), "tetherplane-model-client-control-"),
  );
  const stateDir = path.join(controlRoot, "state");
  const profilePath = path.join(controlRoot, "principal.json");
  const target = path.join(sandbox, "artifact.txt");
  const executable = process.platform === "win32" ? "tetherd.exe" : "tetherd";
  const tetherdPath = path.join(repoRoot, "target", "debug", executable);

  await writeFile(
    profilePath,
    JSON.stringify(
      {
        principal_id: "model:deepseek-engineer",
        authentication: "local_process_binding",
        allowed_devices: ["Leno"],
        allowed_capabilities: [
          "filesystem.write",
          "filesystem.read",
          "audit.read",
        ],
        allowed_roots: [sandbox],
      },
      null,
      2,
    ),
    "utf8",
  );

  const fakeModel = await startFakeModel([
    {
      capability: "filesystem.write",
      arguments: {
        path: target,
        content: "model-neutral\n",
      },
      device: "Leno",
    },
    {
      capability: "filesystem.read",
      arguments: { path: target },
      device: "Leno",
    },
    {
      capability: "process.run",
      arguments: {
        program: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
        args:
          process.platform === "win32"
            ? ["/C", "echo should-not-run"]
            : ["-c", "echo should-not-run"],
      },
      device: "Leno",
    },
    {
      capability: "audit.read",
      arguments: { limit: 20 },
      device: "Leno",
    },
  ]);

  const agent = await LocalAgentClient.spawn({
    tetherdPath,
    tetherdArgs: [
      "--principal-profile",
      profilePath,
      "--allow",
      sandbox,
      "--state-dir",
      stateDir,
    ],
  });
  const model = new OpenAICompatibleModelClient({
    endpoint: fakeModel.endpoint,
    model: "deepseek-v4-local",
  });
  const controller = new ModelController({ model, agent });

  try {
    const write = await controller.executeNext({
      objective: "create the sandbox artifact",
    });
    assert.equal(write.status, "success");

    const read = await controller.executeNext({
      objective: "read the sandbox artifact",
    });
    assert.equal(read.status, "success");
    assert.equal(
      (read.data as Record<string, unknown>).content,
      "model-neutral\n",
    );

    const denied = await controller.executeNext({
      objective: "try an ungranted process execution",
    });
    assert.equal(denied.status, "error");
    assert.equal(denied.error?.code, "permission_denied");

    const audit = await controller.executeNext({
      objective: "read my audit lineage",
    });
    assert.equal(audit.status, "success");
    const events = (audit.data as Record<string, unknown>)
      .events as Array<Record<string, unknown>>;
    assert.ok(
      events.some(
        (event) =>
          event.capability === "filesystem.write" &&
          event.principal_id === "model:deepseek-engineer",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.capability === "process.run" &&
          event.result_status === "error",
      ),
    );

    assert.deepEqual(fakeModel.seenModels, [
      "deepseek-v4-local",
      "deepseek-v4-local",
      "deepseek-v4-local",
      "deepseek-v4-local",
    ]);
  } finally {
    await agent.close();
    await fakeModel.close();
    await rm(sandbox, { recursive: true, force: true });
    await rm(controlRoot, { recursive: true, force: true });
  }
});

test("read-only Contrarian principal cannot escalate through model output", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  const sandbox = await mkdtemp(
    path.join(os.tmpdir(), "tetherplane-contrarian-sandbox-"),
  );
  const controlRoot = await mkdtemp(
    path.join(os.tmpdir(), "tetherplane-contrarian-control-"),
  );
  const stateDir = path.join(controlRoot, "state");
  const profilePath = path.join(controlRoot, "principal.json");
  const target = path.join(sandbox, "observed.txt");
  const executable = process.platform === "win32" ? "tetherd.exe" : "tetherd";
  const tetherdPath = path.join(repoRoot, "target", "debug", executable);

  await writeFile(target, "seed\n", "utf8");
  await writeFile(
    profilePath,
    JSON.stringify(
      {
        principal_id: "model:arcus-contrarian",
        authentication: "local_process_binding",
        allowed_devices: ["Leno"],
        allowed_capabilities: ["filesystem.read"],
        allowed_roots: [sandbox],
      },
      null,
      2,
    ),
    "utf8",
  );

  const fakeModel = await startFakeModel([
    {
      capability: "filesystem.read",
      arguments: { path: target },
      device: "Leno",
    },
    {
      capability: "filesystem.write",
      arguments: { path: target, content: "mutated\n" },
      device: "Leno",
    },
    {
      capability: "process.run",
      arguments: {
        program: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
        args:
          process.platform === "win32"
            ? ["/C", "echo should-not-run"]
            : ["-c", "echo should-not-run"],
      },
      device: "Leno",
    },
  ]);

  const agent = await LocalAgentClient.spawn({
    tetherdPath,
    tetherdArgs: [
      "--principal-profile",
      profilePath,
      "--allow",
      sandbox,
      "--state-dir",
      stateDir,
    ],
  });
  const model = new OpenAICompatibleModelClient({
    endpoint: fakeModel.endpoint,
    model: "arcus-contrarian-abliterated-local",
  });
  const controller = new ModelController({ model, agent });

  try {
    const read = await controller.executeNext({
      objective: "inspect the seeded artifact",
    });
    assert.equal(read.status, "success");
    assert.equal(
      (read.data as Record<string, unknown>).content,
      "seed\n",
    );

    const deniedWrite = await controller.executeNext({
      objective: "attempt to mutate the artifact",
    });
    assert.equal(deniedWrite.status, "error");
    assert.equal(deniedWrite.error?.code, "permission_denied");
    assert.equal(await readFile(target, "utf8"), "seed\n");

    const deniedProcess = await controller.executeNext({
      objective: "attempt process execution",
    });
    assert.equal(deniedProcess.status, "error");
    assert.equal(deniedProcess.error?.code, "permission_denied");
  } finally {
    await agent.close();
    await fakeModel.close();
    await rm(sandbox, { recursive: true, force: true });
    await rm(controlRoot, { recursive: true, force: true });
  }
});
