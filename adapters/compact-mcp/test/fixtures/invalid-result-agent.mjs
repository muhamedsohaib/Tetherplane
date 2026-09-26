#!/usr/bin/env node
import { createInterface } from "node:readline";

process.stderr.write("TETHERPLANE_STDIO_READY_V1\n");

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of lines) {
  const request = JSON.parse(line);
  process.stdout.write(
    JSON.stringify({
      protocol_version: "1.0",
      request_id: request.request_id,
      data: {},
      delta: null,
      error: null,
      verification: "not_applicable",
      continuation: null,
      policy: null,
      timing: { duration_ms: 0 },
    }) + "\n",
  );
}
