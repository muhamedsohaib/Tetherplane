import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { startRdcCompat } from "./helpers/start-rdc-compat.ts";

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  return client.callTool({ name, arguments: args });
}

function data(
  result: Awaited<ReturnType<typeof call>>,
): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

test(
  "Plan C black-box RDC compatibility preserves core workflows and stricter safety",
  { timeout: 45_000 },
  async () => {
    const harness = await startRdcCompat();
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "tetherplane-rdc-outside-"),
    );

    try {
      const tools = await harness.client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      for (const required of [
        "read_file",
        "write_file",
        "start_search",
        "start_process",
        "list_devices",
        "get_config",
      ]) {
        assert.ok(names.includes(required), `missing ${required}`);
      }
      assert.equal(names.includes("files"), false);

      const devices = await call(
        harness.client,
        "list_devices",
        {},
      );
      assert.equal(devices.isError, undefined);
      assert.equal(
        (
          data(devices).devices as Array<Record<string, unknown>>
        )[0]?.status,
        "online",
      );

      const ping = await call(harness.client, "ping", {
        deviceId: "Leno",
      });
      assert.equal(data(ping).pong, true);

      const config = await call(
        harness.client,
        "get_config",
        {},
      );
      assert.equal(data(config).policyMode, "background_only");
      assert.equal(data(config).runtimeConfigMutation, false);

      const source = path.join(harness.root, "compat.txt");
      const moved = path.join(harness.root, "moved.txt");
      const second = path.join(harness.root, "second.txt");

      assert.equal(
        (
          await call(harness.client, "write_file", {
            path: source,
            content: "alpha\n",
          })
        ).isError,
        undefined,
      );
      await call(harness.client, "write_file", {
        path: source,
        content: "beta\n",
        mode: "append",
      });
      await call(harness.client, "write_file", {
        path: second,
        content: "second\n",
      });

      const read = data(
        await call(harness.client, "read_file", {
          path: source,
          offset: 0,
          length: 10,
        }),
      );
      assert.equal(read.content, "alpha\nbeta\n");

      const info = data(
        await call(harness.client, "get_file_info", {
          path: source,
        }),
      );
      assert.equal(info.type, "file");
      assert.equal(info.line_count, 2);

      const listed = data(
        await call(harness.client, "list_directory", {
          path: harness.root,
          depth: 1,
        }),
      );
      assert.ok(
        (
          listed.entries as Array<Record<string, unknown>>
        ).some((entry) => entry.relative_path === "compat.txt"),
      );

      const patched = await call(harness.client, "edit_block", {
        file_path: source,
        old_string: "beta",
        new_string: "gamma",
        expected_replacements: 1,
      });
      assert.equal(patched.isError, undefined);

      const movedResult = await call(
        harness.client,
        "move_file",
        {
          source,
          destination: moved,
        },
      );
      assert.equal(movedResult.isError, undefined);

      const many = data(
        await call(harness.client, "read_multiple_files", {
          paths: [moved, second],
        }),
      );
      const entries =
        many.entries as Array<Record<string, unknown>>;
      assert.equal(entries.length, 2);
      assert.equal(entries[0]?.status, "success");
      assert.match(String(entries[0]?.content), /gamma/);

      const search = data(
        await call(harness.client, "start_search", {
          path: harness.root,
          pattern: "gamma",
          searchType: "content",
          literalSearch: true,
          maxResults: 10,
          contextLines: 1,
        }),
      );
      const sessionId = String(search.sessionId);
      const results = await waitFor(async () => {
        const page = data(
          await call(
            harness.client,
            "get_more_search_results",
            {
              sessionId,
              offset: 0,
              length: 10,
            },
          ),
        );
        const items =
          page.results as Array<Record<string, unknown>>;
        return items.length > 0 || page.isComplete === true
          ? page
          : null;
      });
      assert.ok(
        (
          results.results as Array<Record<string, unknown>>
        ).some((entry) => String(entry.line).includes("gamma")),
      );

      const searchList = data(
        await call(harness.client, "list_searches", {}),
      );
      assert.ok(
        (
          searchList.searches as Array<Record<string, unknown>>
        ).some((entry) => entry.sessionId === sessionId),
      );

      const started = data(
        await call(harness.client, "start_process", {
          command: "node -i",
          timeout_ms: 0,
        }),
      );
      const compatPid = started.pid;
      assert.equal(typeof compatPid, "number");

      const interacted = await call(
        harness.client,
        "interact_with_process",
        {
          pid: compatPid,
          input: 'console.log("GOT:hello")',
          timeout_ms: 2_000,
        },
      );
      assert.equal(interacted.isError, undefined);
      let interactiveOutput = String(
        data(interacted).stdout ?? "",
      );
      for (
        let attempt = 0;
        attempt < 6 && !/GOT:hello/i.test(interactiveOutput);
        attempt += 1
      ) {
        const next = data(
          await call(
            harness.client,
            "read_process_output",
            {
              pid: compatPid,
              offset: 0,
              timeout_ms: 500,
            },
          ),
        );
        interactiveOutput += String(next.stdout ?? "");
      }
      assert.match(interactiveOutput, /GOT:hello/i);

      const sessions = data(
        await call(harness.client, "list_sessions", {}),
      );
      assert.ok(
        (
          sessions.sessions as Array<Record<string, unknown>>
        ).some((entry) => entry.pid === compatPid),
      );

      const arbitraryKill = await call(
        harness.client,
        "kill_process",
        { pid: 90 },
      );
      assert.equal(arbitraryKill.isError, true);
      assert.ok(
        ["permission_denied", "approval_required"].includes(
          String(
            (
              data(arbitraryKill).error as Record<
                string,
                unknown
              >
            ).code,
          ),
        ),
      );

      const outsideFile = path.join(outside, "secret.txt");
      await writeFile(outsideFile, "outside", "utf8");
      const deniedRead = await call(
        harness.client,
        "read_file",
        { path: outsideFile },
      );
      assert.equal(deniedRead.isError, true);
      assert.equal(
        (
          data(deniedRead).error as Record<string, unknown>
        ).code,
        "permission_denied",
      );

      const pdf = await call(harness.client, "write_pdf", {
        path: path.join(harness.root, "x.pdf"),
        content: "# x",
      });
      assert.equal(pdf.isError, true);
      assert.equal(
        (data(pdf).error as Record<string, unknown>).code,
        "capability_unavailable",
      );
    } finally {
      await harness.close();
      await rm(outside, { recursive: true, force: true });
    }
  },
);

async function waitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for RDC compatibility state");
}
