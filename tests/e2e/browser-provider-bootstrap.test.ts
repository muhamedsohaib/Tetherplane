import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { startLocalCompact } from "./helpers/start-local.ts";

test(
  "an unavailable browser bridge does not prevent device startup and browser fails closed",
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
    assert.ok(address && typeof address !== "string");
    const bridgeAddress = `127.0.0.1:${address.port}`;
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
      assert.equal(status.isError, undefined, "core agent must remain online");

      const capabilities = await local.client.callTool({
        name: "device",
        arguments: { op: "capabilities", args: {} },
      });
      assert.equal(capabilities.isError, undefined);
      const data = capabilities.structuredContent as Record<string, unknown>;
      const providers = data.providers as Array<Record<string, unknown>>;
      const browser = providers.find((provider) => provider.namespace === "browser");
      assert.ok(browser);
      assert.equal(browser.available, false);
      assert.deepEqual(browser.operations, []);

      const denied = await local.client.callTool({
        name: "browser",
        arguments: { op: "pages", args: {} },
      });
      assert.equal(denied.isError, true);
      const denial = denied.structuredContent as Record<string, unknown>;
      const error = denial.error as Record<string, unknown>;
      assert.equal(error.code, "capability_unavailable");
    } finally {
      await local.close();
    }
  },
);
