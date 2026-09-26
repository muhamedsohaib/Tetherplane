import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {
  startLocalCompact,
} from "./helpers/start-local.ts";

test(
  "explicit unavailable browser bridge fails local startup instead of silently dropping the provider",
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

    await assert.rejects(
      startLocalCompact({
        browserBridge: {
          address: bridgeAddress,
          token: "bootstrap-test-token",
        },
      }),
    );
  },
);
