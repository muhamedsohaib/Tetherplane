import assert from "node:assert/strict";
import test from "node:test";

import { startBrowserLab } from "../src/index.ts";

test("browser lab exposes deterministic revision and optimistic conflict behavior", async () => {
  const lab = await startBrowserLab();

  try {
    const initial = await fetch(new URL("/api/state", lab.origin));
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), {
      value: "initial",
      revision: 1,
      last_saved_at: null,
      validation_error: null,
    });

    const saved = await fetch(new URL("/api/save", lab.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        value: "first change",
        expected_revision: 1,
      }),
    });
    assert.equal(saved.status, 200);
    const savedState = (await saved.json()) as Record<string, unknown>;
    assert.equal(savedState.value, "first change");
    assert.equal(savedState.revision, 2);

    const conflict = await fetch(new URL("/api/save", lab.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        value: "stale change",
        expected_revision: 1,
      }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      code: "resource_conflict",
      current_revision: 2,
    });
  } finally {
    await lab.close();
  }
});

test("browser lab exposes deterministic validation and failure fixtures", async () => {
  const lab = await startBrowserLab();

  try {
    const validation = await fetch(new URL("/api/save", lab.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        value: "",
        expected_revision: 1,
      }),
    });
    assert.equal(validation.status, 422);
    assert.deepEqual(await validation.json(), {
      code: "validation_failed",
      field: "value",
      message: "Value is required",
    });

    const failed = await fetch(new URL("/api/fail", lab.origin));
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), {
      code: "synthetic_failure",
    });
  } finally {
    await lab.close();
  }
});

test("browser lab exposes frame upload download and slow-request fixtures", async () => {
  const lab = await startBrowserLab();

  try {
    const page = await fetch(new URL("/", lab.origin));
    const pageHtml = await page.text();
    assert.equal(page.status, 200);
    assert.match(pageHtml, /Project value/);
    assert.match(pageHtml, /Nested fixture/);
    assert.match(pageHtml, /Fixture upload/);
    assert.match(pageHtml, /Download fixture/);
    assert.match(pageHtml, /Fail request/);

    const frame = await fetch(new URL("/frame", lab.origin));
    assert.equal(frame.status, 200);
    assert.match(await frame.text(), /Frame action/);

    const upload = await fetch(new URL("/api/upload", lab.origin), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "fixture-upload",
    });
    assert.equal(upload.status, 200);
    assert.deepEqual(await upload.json(), {
      received_bytes: 14,
      revision: 1,
    });

    const uploadState = await fetch(
      new URL("/api/upload-state", lab.origin),
    );
    assert.equal(uploadState.status, 200);
    assert.deepEqual(await uploadState.json(), {
      last_upload: "fixture-upload",
    });

    const download = await fetch(new URL("/download.txt", lab.origin));
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "browser-lab-download\n");
    assert.match(
      download.headers.get("content-disposition") ?? "",
      /browser-lab-download\.txt/,
    );

    const slow = await fetch(new URL("/api/slow?delay_ms=5", lab.origin));
    assert.equal(slow.status, 200);
    assert.deepEqual(await slow.json(), {
      code: "slow_complete",
      delay_ms: 5,
    });
  } finally {
    await lab.close();
  }
});
