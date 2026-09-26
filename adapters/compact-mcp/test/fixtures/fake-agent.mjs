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

const pending = [];

for await (const line of lines) {
  const invocation = JSON.parse(line);

  if (invocation.actor?.id === "compact-mcp-bootstrap") {
    success(invocation, { ready: true });
    continue;
  }

  pending.push(invocation);
  if (pending.length === 2) {
    for (const request of pending.reverse()) {
      success(request, {
        echoed: request.capability,
      });
    }
    pending.length = 0;
  }
}
