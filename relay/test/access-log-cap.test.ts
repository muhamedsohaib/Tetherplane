import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AccessLog } from "../src/access-log.ts";

function response(): ServerResponse {
  return new ServerResponse(new IncomingMessage(new Socket()));
}

test("access event completion includes its on-disk write", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-access-completion-"));
  const file = path.join(dir, "access.jsonl");
  try {
    const completion = new AccessLog({ file }).requestStarted(response(), "GET", "/completed");
    assert.equal(typeof (completion as unknown as { then?: unknown } | undefined)?.then, "function",
      "event callers must be able to await the actual diagnostic write");
    await completion;
    assert.equal((JSON.parse(await readFile(file, "utf8")) as { path: string }).path, "/completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent access events cannot exceed the total UTF-8 file budget", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-access-cap-"));
  const file = path.join(dir, "access.jsonl");
  const prefix = '{"event":"existing","note":"' + "\u00e9".repeat(300) + '"}\n';
  const maxBytes = 1024;
  await writeFile(file, prefix);
  try {
    const log = new AccessLog({ file, maxBytes });
    await Promise.all(Array.from({ length: 32 }, (_, index) => {
      const res = response();
      return log.requestStarted(res, "GET", "/bounded/" + index);
    }));
    // All admitted events must finish before the owning caller removes its
    // temporary directory. The timer is a watchdog, not a quiet-period guess.
    const raw = await readFile(file, "utf8");
    assert.ok(Buffer.byteLength(raw, "utf8") > Buffer.byteLength(prefix));
    assert.ok(Buffer.byteLength(raw, "utf8") <= maxBytes,
      "concurrent events must share one total on-disk byte allowance");
    assert.ok(raw.startsWith(prefix), "existing records must be preserved");
    for (const line of raw.trimEnd().split("\n")) JSON.parse(line);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("access log refuses to queue content beyond its pending byte allowance", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-access-pending-"));
  const file = path.join(dir, "access.jsonl");
  try {
    const log = new AccessLog({ file, maxBytes: 256 });
    const first = log.requestStarted(response(), "GET", "/first");
    let skippedCompleted = false;
    const skipped = Promise.resolve(
      log.requestStarted(response(), "GET", "/" + "x".repeat(512)),
    ).then(() => { skippedCompleted = true; });
    // A microtask checkpoint cannot complete filesystem I/O. Refused work must
    // settle without joining the accepted disk-write chain.
    await Promise.resolve();
    assert.equal(skippedCompleted, true, "oversized pending work must be refused synchronously");
    await Promise.all([first, skipped]);
    const raw = await readFile(file, "utf8");
    assert.ok(Buffer.byteLength(raw, "utf8") <= 256);
    assert.equal(raw.trimEnd().split("\n").length, 1);
    assert.equal((JSON.parse(raw) as { path: string }).path, "/first");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("access log rejects non-finite or non-positive byte budgets", () => {
  for (const maxBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(() => new AccessLog({ file: "unused.jsonl", maxBytes }),
      /positive safe integer/);
  }
});

test("small concurrent entries share the pending admission budget", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-access-combined-"));
  const file = path.join(dir, "access.jsonl");
  try {
    const log = new AccessLog({ file, maxBytes: 256 });
    const first = log.requestStarted(response(), "GET", "/one");
    const second = log.requestStarted(response(), "GET", "/two");
    let refusedCompleted = false;
    const third = log.requestStarted(response(), "GET", "/three")
      .then(() => { refusedCompleted = true; });
    await Promise.resolve();
    assert.equal(refusedCompleted, true,
      "combined pending bytes must refuse a third otherwise-small entry before I/O");
    await Promise.all([first, second, third]);
    const raw = await readFile(file, "utf8");
    assert.ok(Buffer.byteLength(raw, "utf8") <= 256);
    assert.deepEqual(raw.trimEnd().split("\n").map(line => (JSON.parse(line) as { path: string }).path),
      ["/one", "/two"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("access log I/O failure settles safely and disables later writes", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-access-failure-"));
  const file = path.join(dir, "access.jsonl");
  await mkdir(file);
  try {
    const log = new AccessLog({ file });
    await log.requestStarted(response(), "GET", "/failed");
    await rm(file, { recursive: true });
    await log.requestStarted(response(), "GET", "/disabled");
    await assert.rejects(readFile(file), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
