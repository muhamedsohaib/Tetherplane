import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { startLocalCompact } from "./helpers/start-local.ts";

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  return client.callTool({
    name,
    arguments: args,
  });
}

function structured(
  result: Awaited<ReturnType<typeof call>>,
): Record<string, unknown> {
  assert.ok(result.structuredContent, "expected structuredContent");
  return result.structuredContent as Record<string, unknown>;
}

test("local compact MCP proves the complete local-core workflow", async () => {
  const local = await startLocalCompact();

  try {
    const listed = await local.client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["batch", "browser", "desktop", "device", "files", "process"],
    );

    await proveFileLifecycle(local.client, local.root);
    await proveProgressiveSearch(local.client, local.root);
    await provePersistentProcess(local.client);
    await proveBatch(local.client, local.root);
    await proveUnavailableProviders(local.client);
  } finally {
    await local.close();
  }
});

async function proveFileLifecycle(client: Client, root: string) {
  const source = path.join(root, "alpha.txt");
  const moved = path.join(root, "moved.txt");

  const write = await call(client, "files", {
    op: "write",
    args: { path: source, content: "alpha\nbeta\n" },
  });
  assert.equal(write.isError, undefined);

  const read = structured(
    await call(client, "files", {
      op: "read",
      args: { path: source },
    }),
  );
  assert.equal(read.content, "alpha\nbeta\n");

  const patch = await call(client, "files", {
    op: "patch",
    args: {
      path: source,
      old: "beta",
      new: "gamma",
      expected_replacements: 1,
    },
  });
  assert.equal(patch.isError, undefined);

  const info = structured(
    await call(client, "files", {
      op: "info",
      args: { path: source },
    }),
  );
  assert.equal(info.type, "file");
  assert.equal(info.line_count, 2);

  const move = await call(client, "files", {
    op: "move",
    args: { source, destination: moved },
  });
  assert.equal(move.isError, undefined);

  const listed = structured(
    await call(client, "files", {
      op: "list",
      args: { path: root, depth: 1 },
    }),
  );
  assert.ok(
    (listed.entries as Array<Record<string, unknown>>).some(
      (entry) => entry.relative_path === "moved.txt",
    ),
  );

  const outside = `${root}${path.sep}..${path.sep}outside.txt`;
  const denied = await call(client, "files", {
    op: "read",
    args: { path: outside },
  });
  assert.equal(denied.isError, true);
  assert.equal(
    (structured(denied).error as Record<string, unknown>).code,
    "permission_denied",
  );
}

async function proveProgressiveSearch(client: Client, root: string) {
  for (const [name, content] of [
    ["search-a.txt", "needle first\n"],
    ["search-b.txt", "other\nneedle second\n"],
    ["search-c.txt", "needle third\n"],
  ] as const) {
    const result = await call(client, "files", {
      op: "write",
      args: { path: path.join(root, name), content },
    });
    assert.equal(result.isError, undefined);
  }

  const started = structured(
    await call(client, "files", {
      op: "search",
      args: {
        root,
        scope: "content",
        query: "needle",
        max_results: 10,
      },
    }),
  );
  const handle = started.handle as string;
  assert.match(handle, /^search_/);

  const matches: Array<Record<string, unknown>> = [];
  let done = false;
  for (let attempt = 0; attempt < 20 && !done; attempt += 1) {
    const read = structured(
      await call(client, "files", {
        op: "search_read",
        args: { handle, max_items: 10 },
      }),
    );
    matches.push(
      ...(read.matches as Array<Record<string, unknown>>),
    );
    done = read.done === true;
    if (!done) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  assert.equal(done, true, "search did not reach terminal state");
  assert.equal(matches.length, 3);
  assert.deepEqual(
    matches.map((match) => match.relative_path).sort(),
    ["search-a.txt", "search-b.txt", "search-c.txt"],
  );

  const unseenAgain = structured(
    await call(client, "files", {
      op: "search_read",
      args: { handle, max_items: 10 },
    }),
  );
  assert.deepEqual(unseenAgain.matches, []);

  const stopped = structured(
    await call(client, "files", {
      op: "search_stop",
      args: { handle },
    }),
  );
  assert.equal(stopped.handle, handle);

  const sessions = structured(
    await call(client, "files", {
      op: "search_list",
      args: {},
    }),
  );
  assert.ok(
    (sessions.sessions as Array<Record<string, unknown>>).some(
      (session) => session.handle === handle,
    ),
  );
}

async function provePersistentProcess(client: Client) {
  const processArgs =
    process.platform === "win32"
      ? {
          program: "cmd.exe",
          args: [
            "/C",
            "ping -n 2 127.0.0.1 >NUL & echo one & ping -n 2 127.0.0.1 >NUL & echo two",
          ],
          wait_ms: 0,
          pty: false,
        }
      : {
          program: "/bin/sh",
          args: [
            "-c",
            "sleep 1; printf 'one\\n'; sleep 1; printf 'two\\n'",
          ],
          wait_ms: 0,
          pty: false,
        };

  const started = structured(
    await call(client, "process", {
      op: "run",
      args: processArgs,
    }),
  );
  const handle = started.handle as string;
  assert.match(handle, /^proc_/);

  const first = structured(
    await call(client, "process", {
      op: "read",
      args: { handle, timeout_ms: 1_500 },
    }),
  );
  const firstStdout = first.stdout as string;
  assert.match(firstStdout, /one/);
  assert.doesNotMatch(firstStdout, /two/);

  const second = structured(
    await call(client, "process", {
      op: "read",
      args: { handle, timeout_ms: 2_000 },
    }),
  );
  const secondStdout = second.stdout as string;
  assert.doesNotMatch(secondStdout, /one/);
  assert.match(secondStdout, /two/);
  assert.equal(second.running, false);
}

async function proveBatch(client: Client, root: string) {
  const files = [
    ["batch-a.txt", "A\n"],
    ["batch-b.txt", "B\n"],
    ["batch-c.txt", "C\n"],
  ] as const;

  for (const [name, content] of files) {
    const result = await call(client, "files", {
      op: "write",
      args: { path: path.join(root, name), content },
    });
    assert.equal(result.isError, undefined);
  }

  const batch = structured(
    await call(client, "batch", {
      op: "execute",
      args: {
        mode: "parallel",
        operations: files.map(([name]) => ({
          capability: "filesystem.read",
          arguments: { path: path.join(root, name) },
        })),
      },
    }),
  );
  const results = batch.results as Array<Record<string, unknown>>;
  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((result) => {
      const data = result.data as Record<string, unknown>;
      return data.content;
    }),
    ["A\n", "B\n", "C\n"],
  );
}

async function proveUnavailableProviders(client: Client) {
  for (const name of ["browser", "desktop"] as const) {
    const result = await call(client, name, {
      op: "capabilities",
      args: {},
    });
    assert.equal(result.isError, true);
    const error = structured(result).error as Record<string, unknown>;
    assert.equal(error.code, "capability_unavailable");
    assert.match(String(error.message), /not installed|unavailable/i);
  }
}

test("launch-bound principal constrains the real MCP surface and execution", async () => {
  const local = await startLocalCompact({
    principalProfile: {
      principal_id: "model:deepseek-engineer",
      authentication: "local_process_binding",
      allowed_devices: ["Leno"],
      allowed_capabilities: [
        "device.capabilities",
        "filesystem.read",
        "filesystem.write",
      ],
    },
  });

  try {
    const capabilities = structured(
      await call(local.client, "device", {
        op: "capabilities",
        args: {},
        device: "Leno",
      }),
    );
    const providers = capabilities.providers as Array<Record<string, unknown>>;
    const filesystem = providers.find(
      (provider) => provider.namespace === "filesystem",
    );
    const processProvider = providers.find(
      (provider) => provider.namespace === "process",
    );
    assert.deepEqual(filesystem?.operations, ["read", "write"]);
    assert.deepEqual(processProvider?.operations, []);

    const target = path.join(local.root, "principal-proof.txt");
    const write = await call(local.client, "files", {
      op: "write",
      device: "Leno",
      args: { path: target, content: "principal-bound\n" },
    });
    assert.equal(write.isError, undefined);

    const read = structured(
      await call(local.client, "files", {
        op: "read",
        device: "Leno",
        args: { path: target },
      }),
    );
    assert.equal(read.content, "principal-bound\n");

    const outside = path.resolve(local.root, "..", "principal-outside.txt");
    const deniedOutside = await call(local.client, "files", {
      op: "read",
      device: "Leno",
      args: { path: outside },
    });
    assert.equal(deniedOutside.isError, true);
    assert.equal(
      (structured(deniedOutside).error as Record<string, unknown>).code,
      "permission_denied",
    );

    const deniedProcess = await call(local.client, "process", {
      op: "run",
      device: "Leno",
      args: { program: "cmd.exe", args: ["/C", "echo should-not-run"] },
    });
    assert.equal(deniedProcess.isError, true);
    assert.equal(
      (structured(deniedProcess).error as Record<string, unknown>).code,
      "permission_denied",
    );
  } finally {
    await local.close();
  }
});
