import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("CLI explains local startup without requiring secrets or opening a browser", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--relay-url/);
  assert.match(result.stdout, /127\.0\.0\.1/);
  assert.equal(result.stderr, "");
});
test("CLI rejects unknown flags and unsafe relay URLs without echoing supplied arguments", () => {
  for (const args of [
    [],
    ["--relay-url", "http://example.com"],
    ["--relay-url", "https://u:private-value@example.com"],
    ["--host", "0.0.0.0"],
    ["--relay-url", "https://example.com", "--port", "-1"],
  ]) {
    const result = spawnSync(process.execPath, ["src/cli.ts", ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes("private-value"), false);
  }
});
