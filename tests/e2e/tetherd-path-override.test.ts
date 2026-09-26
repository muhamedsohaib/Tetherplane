import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveTetherdPath } from "./helpers/resolve-tetherd-path.ts";

test("tetherd path override prefers explicit, then environment, then default", async () => {
  const repoRoot = path.resolve("repo-root-sentinel");
  const executable =
    process.platform === "win32" ? "tetherd.exe" : "tetherd";
  const previous = process.env.TETHERPLANE_TETHERD_PATH;
  try {
    delete process.env.TETHERPLANE_TETHERD_PATH;
    assert.equal(
      resolveTetherdPath(repoRoot),
      path.join(repoRoot, "target", "debug", executable),
    );

    process.env.TETHERPLANE_TETHERD_PATH = "  ";
    assert.equal(
      resolveTetherdPath(repoRoot),
      path.join(repoRoot, "target", "debug", executable),
    );

    process.env.TETHERPLANE_TETHERD_PATH = "C:\\allowed\\tetherd.exe";
    assert.equal(
      resolveTetherdPath(repoRoot),
      "C:\\allowed\\tetherd.exe",
    );
    assert.equal(
      resolveTetherdPath(repoRoot, "C:\\explicit\\tetherd.exe"),
      "C:\\explicit\\tetherd.exe",
    );

    delete process.env.TETHERPLANE_TETHERD_PATH;
    assert.equal(
      resolveTetherdPath(repoRoot, "  C:\\explicit\\tetherd.exe  "),
      "C:\\explicit\\tetherd.exe",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.TETHERPLANE_TETHERD_PATH;
    } else {
      process.env.TETHERPLANE_TETHERD_PATH = previous;
    }
  }
});
