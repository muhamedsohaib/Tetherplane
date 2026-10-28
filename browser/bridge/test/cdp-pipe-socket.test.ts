import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import test from "node:test";

import { CdpPipeSocket } from "../src/cdp-pipe-socket.ts";

function fakeChild() {
  const input = new PassThrough();
  const output = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, input, output],
  }) as unknown as ChildProcess;
  return { child, input, output };
}

test("private CDP frames multiple messages split across stream reads", () => {
  const { child, input, output } = fakeChild();
  const socket = new CdpPipeSocket(child);
  const messages: string[] = [];
  socket.on("message", (data: Buffer) => messages.push(String(data)));

  output.write('{"id":1');
  output.write('}\0{"id":2}\0');
  assert.deepEqual(messages, ['{"id":1}', '{"id":2}']);

  socket.send('{"id":3}');
  assert.equal(input.read()?.toString(), '{"id":3}\0');
  socket.close();
  assert.equal(socket.readyState, 3);
});

test("late pipe errors after close cannot escape as unhandled error events", () => {
  const { child, input, output } = fakeChild();
  const socket = new CdpPipeSocket(child);
  let errorCount = 0;
  let closeCount = 0;
  socket.once("error", () => errorCount++);
  socket.once("close", () => closeCount++);

  input.emit("error", new Error("write failed"));
  assert.equal(socket.readyState, 3);
  assert.doesNotThrow(() => output.emit("error", new Error("late read failure")));
  assert.equal(errorCount, 1);
  assert.equal(closeCount, 1);
});
