import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

// Experimental private CDP stream, not a process isolation sandbox.
// Chromium uses zero-terminated JSON messages, unlike CDP WebSockets.
// A missing, malformed or overlong frame fails closed.
const MAX_CDP_MESSAGE_BYTES = 8 * 1024 * 1024;

export class CdpPipeSocket extends EventEmitter {
  readyState = 1; // WebSocket.OPEN; the existing CdpWire checks this value.
  readonly #input: Writable;
  readonly #output: Readable;
  #pending = Buffer.alloc(0);
  #closed = false;

  constructor(child: ChildProcess) {
    super();
    const input = child.stdio[3];
    const output = child.stdio[4];
    if (
      !input ||
      !output ||
      typeof (input as Writable).write !== "function" ||
      typeof (output as Readable).on !== "function"
    ) {
      throw new TypeError("private CDP requires inherited streams 3 and 4");
    }
    this.#input = input as Writable;
    this.#output = output as Readable;

    this.#output.on("data", (chunk: Buffer) => {
      if (this.#closed) return;
      this.#pending = Buffer.concat([this.#pending, chunk]);
      if (this.#pending.byteLength > MAX_CDP_MESSAGE_BYTES) {
        this.emit("error", new Error("private CDP frame exceeds bound"));
        this.close();
        return;
      }
      let boundary = this.#pending.indexOf(0);
      while (boundary >= 0) {
        const frame = this.#pending.subarray(0, boundary);
        this.#pending = this.#pending.subarray(boundary + 1);
        if (frame.byteLength > 0) this.emit("message", frame);
        boundary = this.#pending.indexOf(0);
      }
    });
    this.#output.once("end", () => this.#markClosed());
    this.#output.once("error", (error) => {
      this.emit("error", error);
      this.#markClosed();
    });
    this.#input.once("error", (error) => {
      this.emit("error", error);
      this.#markClosed();
    });
    child.once("exit", () => this.#markClosed());
  }

  send(value: string): void {
    if (this.#closed) throw new Error("private CDP pipe closed");
    this.#input.write(value + "\0");
  }

  close(): void {
    if (this.#closed) return;
    this.#input.destroy();
    this.#output.destroy();
    this.#markClosed();
  }

  #markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.readyState = 3; // WebSocket.CLOSED
    this.emit("close");
  }
}
