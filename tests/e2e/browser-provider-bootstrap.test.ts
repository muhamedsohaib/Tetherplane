import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {
  startLocalCompact,
} from "./helpers/start-local.ts";

test(
  "explicit unavailable browser bridge keeps core online but refuses browser access",
  { timeout: 20_000 },
  async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert.ok(
      address &&
        typeof address !== "string",
    );
    const bridgeAddress =
      `127.0.0.1:${address.port}`;
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error ? reject(error) : resolve(),
      ),
    );

    const local = await startLocalCompact({
      browserBridge: {
        address: bridgeAddress,
        token: "bootstrap-test-token",
      },
    });

    try {
      const status = await local.client.callTool({
        name: "device",
        arguments: { op: "status", args: {} },
      });
      assert.equal(status.isError, undefined);
      assert.equal(
        (status.structuredContent as Record<string, unknown>)
          .policy_mode,
        "background_only",
      );

      const caps = await local.client.callTool({
        name: "device",
        arguments: { op: "capabilities", args: {} },
      });
      assert.equal(caps.isError, undefined);
      const providers = (
        (caps.structuredContent as Record<string, unknown>)
          .providers as Array<Record<string, unknown>>
      );
      const browser = providers.find(
        (provider) => provider.namespace === "browser",
      );
      assert.ok(browser);
      assert.equal(browser.available, false);
      assert.deepEqual(browser.operations, []);

      const rejected = await local.client.callTool({
        name: "browser",
        arguments: { op: "status", args: {} },
      });
      assert.equal(
        rejected.isError,
        true,
        "unavailable bridge must not expose browser operations",
      );
      const error = (
        (rejected.structuredContent as Record<string, unknown>)
          .error as Record<string, unknown>
      );
      assert.ok(
        ["disconnected", "timeout"].includes(String(error.code)),
        "missing browser bridge must remain unavailable without bypass",
      );
    } finally {
      await local.close();
    }
  },
);
