import assert from "node:assert/strict";
import test from "node:test";

import {
  closeBrowserTransportWithDeadline,
} from "../src/cdp-close.ts";

test("unresponsive Chromium close command cannot block transport shutdown", async () => {
  let closed = false;
  const sent: string[] = [];
  const transport = {
    send(method: string): Promise<unknown> {
      sent.push(method);
      return new Promise(() => undefined);
    },
    close(): void { closed = true; },
  };
  const started = performance.now();
  await closeBrowserTransportWithDeadline(transport, 25);
  assert.deepEqual(sent, ["Browser.close"]);
  assert.equal(closed, true);
  assert.ok(performance.now() - started < 500);
});

test("failed Chromium close command still closes the control transport", async () => {
  let closed = 0;
  const transport = {
    send(): Promise<unknown> { return Promise.reject(new Error("disconnected")); },
    close(): void { closed++; },
  };
  await closeBrowserTransportWithDeadline(transport, 25);
  assert.equal(closed, 1);
});
