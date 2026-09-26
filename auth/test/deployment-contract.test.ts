import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(
  process.cwd(),
  "..",
);

test("production auth container runs non-root with persistent state and no baked secrets", async () => {
  const dockerfile = await readFile(
    path.join(ROOT, "Dockerfile.auth"),
    "utf8",
  );

  assert.match(
    dockerfile,
    /^FROM node:22-bookworm-slim AS build/m,
  );
  assert.match(
    dockerfile,
    /USER tetherplane/,
  );
  assert.match(
    dockerfile,
    /VOLUME \["\/var\/lib\/tetherplane-auth"\]/,
  );
  assert.match(
    dockerfile,
    /EXPOSE 8790/,
  );
  assert.match(
    dockerfile,
    /ENTRYPOINT \["node", "auth\/dist\/cli\.js"\]/,
  );

  for (const forbidden of [
    "TETHERPLANE_AUTH_BRIDGE_TOKEN=",
    "BEGIN PRIVATE KEY",
    "client_secret",
    "bridgeToken:",
  ]) {
    assert.equal(
      dockerfile.includes(forbidden),
      false,
      `Dockerfile.auth must not bake ${forbidden}`,
    );
  }
});

test("self-host auth guide covers persistence security and acceptance operations", async () => {
  const guide = await readFile(
    path.join(
      ROOT,
      "docs",
      "remote",
      "self-host-auth.md",
    ),
    "utf8",
  );

  for (const heading of [
    "## Production container",
    "## Sensitive files and volumes",
    "## Backup and restore",
    "## Signing-key rotation",
    "## Health and observability",
    "## Stable domain and TLS",
    "## ChatGPT and MCP acceptance proof",
  ]) {
    assert.match(
      guide,
      new RegExp(
        heading.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&"),
      ),
    );
  }

  assert.match(
    guide,
    /local .*Policy Broker.*final authority/i,
  );
  assert.match(
    guide,
    /do not.*copy.*SQLite.*while.*running/i,
  );
  assert.match(
    guide,
    /temporary tunnel/i,
  );
});
