import assert from "node:assert/strict";
import test from "node:test";

import {
  connectCurrentTab,
  type OwnerBrowserStatus,
  type OneClickDependencies,
} from "../src/one-click.ts";

type Scenario = {
  paired?: boolean;
  connected?: boolean;
  afterResume?: boolean;
  afterPair?: boolean;
  shareReply?: unknown;
  confirmGrant?: boolean;
};

function fixture(settings: Scenario = {}) {
  const calls: string[] = [];
  let status: OwnerBrowserStatus = {
    paired: settings.paired ?? false,
    connected: settings.connected ?? false,
    shared: false,
  };
  const deps: OneClickDependencies = {
    status: async () => ({ ...status }),
    resume: async () => {
      calls.push("resume");
      if (settings.afterResume) status.connected = true;
    },
    pair: async () => {
      calls.push("pair");
      status.paired = true;
      if (settings.afterPair) status.connected = true;
    },
    share: async (options) => {
      calls.push("share:" + JSON.stringify(options));
      if (settings.confirmGrant !== false) status.shared = true;
      return settings.shareReply ?? { ok: true };
    },
    sleep: async () => undefined,
  };
  return { deps, calls };
}

const options = {
  ttl_ms: 300_000,
  allow_navigate: false,
  allow_upload: false,
};

test("one click shares only the chosen tab when extension is already connected", async () => {
  const { deps, calls } = fixture({ paired: true, connected: true });
  const actual = await connectCurrentTab(deps, options);
  assert.equal(actual.shared, true);
  assert.equal(actual.connected, true);
  assert.deepEqual(calls, ["share:" + JSON.stringify(options)]);
});

test("one click resumes cached owner pairing without making another pairing request", async () => {
  const { deps, calls } = fixture({ paired: true, afterResume: true });
  await connectCurrentTab(deps, options);
  assert.deepEqual(calls, ["resume", "share:" + JSON.stringify(options)]);
});

test("one click pairs an unpaired extension and grants this tab only after connection", async () => {
  const { deps, calls } = fixture({ afterPair: true });
  await connectCurrentTab(deps, options);
  assert.deepEqual(calls, ["pair", "share:" + JSON.stringify(options)]);
});

test("one click falls back to owner pairing after a cached connection cannot recover", async () => {
  const { deps, calls } = fixture({ paired: true, afterPair: true });
  await connectCurrentTab(deps, options);
  assert.deepEqual(calls, ["resume", "pair", "share:" + JSON.stringify(options)]);
});

test("one click never issues a tab grant while local authenticated host is unavailable", async () => {
  const { deps, calls } = fixture({ paired: true });
  await assert.rejects(
    () => connectCurrentTab(deps, options),
    /local browser host is not connected/,
  );
  assert.deepEqual(calls, ["resume", "pair"]);
});

test("one click rejects a local approval denial without pretending to be connected", async () => {
  const { deps } = fixture({
    paired: true,
    connected: true,
    shareReply: { ok: false, error: "Owner denied this tab" },
  });
  await assert.rejects(
    () => connectCurrentTab(deps, options),
    /Owner denied this tab/,
  );
});

test("one click fails closed when local grant confirmation is missing", async () => {
  const { deps } = fixture({
    paired: true,
    connected: true,
    confirmGrant: false,
  });
  await assert.rejects(
    () => connectCurrentTab(deps, options),
    /tab grant was not confirmed/,
  );
});

test("one click rejects invalid grant duration before contacting browser session", async () => {
  const { deps, calls } = fixture({ paired: true, connected: true });
  for (const ttl of [0, -1, 3_600_001, 123.5]) {
    await assert.rejects(
      () => connectCurrentTab(deps, { ...options, ttl_ms: ttl }),
      /Choose a share duration/,
    );
  }
  assert.deepEqual(calls, []);
});
