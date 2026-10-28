import assert from "node:assert/strict";
import test from "node:test";

import { startExtensionPairingBroker } from "../src/pairing.ts";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const extensionOrigin = `chrome-extension://${extensionId}`;

test("pairing broker rejects ordinary web origins without disclosing token", async () => {
  const broker = await startExtensionPairingBroker({
    expectedExtensionId: extensionId,
    launchToken: "test-launch-token",
    bridgeUrl: "ws://127.0.0.1:8123",
    port: 0,
  });

  try {
    const response = await fetch(broker.url + "/pair", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        extension_id: extensionId,
      }),
    });

    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /test-launch-token/);
  } finally {
    await broker.close();
  }
});

test("pairing broker returns launch config once to matching extension origin", async () => {
  const paired: string[] = [];
  const broker = await startExtensionPairingBroker({
    expectedExtensionId: extensionId,
    launchToken: "test-launch-token",
    bridgeUrl: "ws://127.0.0.1:8123",
    port: 0,
    onPaired: (id) => {
      paired.push(id);
    },
  });

  try {
    const first = await fetch(broker.url + "/pair", {
      method: "POST",
      headers: {
        origin: extensionOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        extension_id: extensionId,
      }),
    });

    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      bridge_url: "ws://127.0.0.1:8123",
      launch_token: "test-launch-token",
    });
    assert.deepEqual(paired, [extensionId]);

    const second = await fetch(broker.url + "/pair", {
      method: "POST",
      headers: {
        origin: extensionOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        extension_id: extensionId,
      }),
    });

    assert.equal(second.status, 410);
    assert.doesNotMatch(await second.text(), /test-launch-token/);
  } finally {
    await broker.close();
  }
});

test("pairing broker rejects mismatched extension id", async () => {
  const broker = await startExtensionPairingBroker({
    expectedExtensionId: extensionId,
    launchToken: "test-launch-token",
    bridgeUrl: "ws://127.0.0.1:8123",
    port: 0,
  });

  try {
    const response = await fetch(broker.url + "/pair", {
      method: "POST",
      headers: {
        origin: extensionOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        extension_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    });

    assert.equal(response.status, 403);
  } finally {
    await broker.close();
  }
});

test("new browser pairing cannot start without an owner-pinned extension identity", async () => {
  // An unrelated extension can otherwise claim its own legitimate
  // chrome-extension:// origin and take the first pairing token.
  let broker: Awaited<ReturnType<typeof startExtensionPairingBroker>> | undefined;
  let failure: unknown;
  try {
    broker = await startExtensionPairingBroker({
      launchToken: "private-test-only-launch-token",
      bridgeUrl: "ws://127.0.0.1:8123",
      port: 0,
    });
  } catch (error) {
    failure = error;
  } finally {
    await broker?.close();
  }
  assert.match(String(failure), /owner-pinned extension ID is required/i);
});
