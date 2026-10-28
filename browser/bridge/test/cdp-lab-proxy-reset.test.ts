import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { rejectCdpLabSocket } from "../src/cdp-lab-proxy.ts";

test("denied proxy tunnel absorbs late ECONNRESET without crashing the broker", () => {
  const socket = new PassThrough();
  rejectCdpLabSocket(socket);

  assert.equal(
    socket.read()?.toString("utf8"),
    "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n",
  );
  const reset = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
  });
  assert.doesNotThrow(() => socket.emit("error", reset));
  assert.equal(socket.destroyed, true);
  assert.doesNotThrow(() => socket.emit("error", reset));
});

test("denied proxy tunnel handles an already closed raw socket", () => {
  const socket = new PassThrough();
  socket.destroy();
  assert.doesNotThrow(() => rejectCdpLabSocket(socket));
  assert.doesNotThrow(() => socket.emit("error", new Error("late reset")));
});
