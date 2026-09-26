#!/usr/bin/env node
import { createInterface } from "node:readline";

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function success(request, data = {}) {
  process.stdout.write(
    JSON.stringify({
      protocol_version: "1.0",
      request_id: request.request_id,
      status: "success",
      data,
      delta: null,
      error: null,
      verification: "not_applicable",
      continuation: null,
      policy: null,
      timing: { duration_ms: 0 },
    }) + "\n",
  );
}

for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.actor?.id === "compact-mcp-bootstrap") {
    success(request, { ready: true });
    continue;
  }
  process.exit(7);
}
