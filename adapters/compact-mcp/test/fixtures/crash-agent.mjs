#!/usr/bin/env node
import { createInterface } from "node:readline";

process.stderr.write("TETHERPLANE_STDIO_READY_V1\n");

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const _line of lines) {
  process.exit(7);
}
