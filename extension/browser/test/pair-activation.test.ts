import assert from "node:assert/strict";
import test from "node:test";

import {
  activatePairing,
  BROWSER_CONNECT_MESSAGE_TYPE,
} from "../src/pair-activation.ts";

test("pair activation saves ephemeral config before notifying background without forwarding token", async () => {
  const events: Array<unknown> = [];

  await activatePairing(
    {
      bridge_url: "ws://127.0.0.1:17658",
      launch_token: "opaque-test-token",
    },
    {
      save: async (config) => {
        events.push({
          kind: "save",
          config,
        });
      },
      sendMessage: async (message) => {
        events.push({
          kind: "message",
          message,
        });
        return { ok: true };
      },
    },
  );

  assert.equal(events.length, 2);

  assert.deepEqual(events[0], {
    kind: "save",
    config: {
      bridge_url: "ws://127.0.0.1:17658",
      launch_token: "opaque-test-token",
    },
  });

  assert.deepEqual(events[1], {
    kind: "message",
    message: {
      type: BROWSER_CONNECT_MESSAGE_TYPE,
    },
  });

  assert.equal(
    JSON.stringify(events[1]).includes("opaque-test-token"),
    false,
  );
});

test("pair activation fails closed when background refuses connection start", async () => {
  await assert.rejects(
    () =>
      activatePairing(
        {
          bridge_url: "ws://127.0.0.1:17658",
          launch_token: "opaque-test-token",
        },
        {
          save: async () => undefined,
          sendMessage: async () => ({
            ok: false,
            error: "bridge start refused",
          }),
        },
      ),
    /bridge start refused/,
  );
});