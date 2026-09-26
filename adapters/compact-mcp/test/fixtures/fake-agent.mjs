#!/usr/bin/env node
import { createInterface } from "node:readline";

process.stderr.write("TETHERPLANE_STDIO_READY_V1\n");

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const pending = [];

for await (const line of lines) {
  const invocation = JSON.parse(line);
  pending.push(invocation);

  if (pending.length === 2) {
    for (const request of pending.reverse()) {
      process.stdout.write(
        JSON.stringify({
          protocol_version: "1.0",
          request_id: request.request_id,
          status: "success",
          data: { echoed: request.capability },
          delta: null,
          error: null,
          verification: "not_applicable",
          continuation: null,
          policy: null,
          timing: { duration_ms: 0 },
        }) + "\n",
      );
    }
    pending.length = 0;
  }
}
