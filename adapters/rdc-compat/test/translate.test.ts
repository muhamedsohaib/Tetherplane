import assert from "node:assert/strict";
import test from "node:test";

import { translateRdcCall } from "../src/translate.ts";

test("legacy file names translate only to canonical filesystem capabilities", () => {
  const read = translateRdcCall("read_file", {
    path: "C:\\sandbox\\a.txt",
    offset: 4,
    length: 10,
    deviceId: "Leno",
  });
  assert.equal(read.kind, "invoke");
  if (read.kind !== "invoke") return;
  assert.equal(read.invocation.capability, "filesystem.read");
  assert.deepEqual(read.invocation.arguments, {
    path: "C:\\sandbox\\a.txt",
    offset: 4,
    length: 10,
  });
  assert.equal(read.invocation.device_id, "Leno");
  assert.equal(read.invocation.actor.id, "rdc-compat");
});

test("legacy search arguments map to canonical progressive search semantics", () => {
  const translated = translateRdcCall("start_search", {
    path: "C:\\sandbox",
    pattern: "Needle",
    searchType: "content",
    literalSearch: true,
    ignoreCase: false,
    includeHidden: true,
    maxResults: 25,
    contextLines: 3,
    filePattern: "*.ts",
  });
  assert.equal(translated.kind, "invoke");
  if (translated.kind !== "invoke") return;
  assert.equal(translated.invocation.capability, "search.start");
  assert.deepEqual(translated.invocation.arguments, {
    root: "C:\\sandbox",
    scope: "content",
    query: "Needle",
    regex: false,
    case_sensitive: true,
    include_hidden: true,
    max_results: 25,
    context_lines: 3,
    globs: ["*.ts"],
  });
});

test("service-specific RDC operations are explicit local compatibility errors", () => {
  const translated = translateRdcCall("write_pdf", {
    path: "x.pdf",
    content: "x",
  });
  assert.equal(translated.kind, "unsupported");
  if (translated.kind !== "unsupported") return;
  assert.equal(translated.error.code, "capability_unavailable");
  assert.match(translated.error.message, /document provider/i);
});
