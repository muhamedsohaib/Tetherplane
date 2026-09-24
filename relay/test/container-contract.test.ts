import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("relay production container contract is explicit and secret-safe", async () => {
  const dockerfile = await readFile(
    path.join(root, "Dockerfile.relay"),
    "utf8",
  );
  const dockerignore = await readFile(
    path.join(root, ".dockerignore"),
    "utf8",
  );

  assert.match(dockerfile, /FROM node:22[^\n]* AS build/);
  assert.match(dockerfile, /FROM node:22[^\n]* AS runtime/);
  assert.match(dockerfile, /ENV NODE_ENV=production/);
  assert.match(dockerfile, /USER tetherplane/);
  assert.match(dockerfile, /EXPOSE 8788/);
  assert.match(
    dockerfile,
    /ENTRYPOINT \["node",\s*"relay\/dist\/cli\.js"\]/,
  );

  for (const required of [
    ".git",
    "node_modules",
    "target",
    ".env",
    "*.pem",
    "*.key",
  ]) {
    assert.match(
      dockerignore,
      new RegExp(
        `^${required.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&")}$`,
        "m",
      ),
      `.dockerignore must exclude ${required}`,
    );
  }
});
