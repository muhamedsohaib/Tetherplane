#!/usr/bin/env node
// Source-pinned Store-only cosmetic/state-path overlay.
// --check is read-only; --stage may write only to a new builder-created scratch
// directory named tetherplane-store-private-<uuid>/payload/app.
// It never reads credentials, runs the agent, or changes existing installations.
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const changes = new Map([
  ["runtime-app.mjs", [
    ['join(process.env.LOCALAPPDATA || "", "TetherplaneStoreDevOnly")',
     'join(process.env.LOCALAPPDATA || "", "TetherplaneStore")'],
  ]],
  ["setup.html", [
    ["<title>Tetherplane — private setup preview</title>",
     "<title>Tetherplane — connect this Windows device</title>"],
    ["TETHERPLANE · DEVELOPMENT PREVIEW",
     "TETHERPLANE · OWNER-APPROVED SETUP"],
    ["This development build is not Microsoft Store-certified. Do not use it to replace an existing Tetherplane installation.",
     "This app does not automatically replace existing Tetherplane agents or credentials. Pair only an owner-authorized device, then independently verify the connection."],
    ["Existing Store-preview credentials will be preserved.",
     "Existing Tetherplane Store credentials will be preserved."],
  ]],
]);

export function transformStoreRuntime(sourceName, text) {
  const replacements = changes.get(sourceName);
  if (!replacements) throw new Error("STORE_UI_UNKNOWN_SOURCE_NAME");
  let value = text;
  for (const [from, to] of replacements) {
    const first = value.indexOf(from);
    if (first < 0 || value.indexOf(from, first + from.length) !== -1) {
      throw new Error("STORE_UI_SOURCE_CONTRACT_DRIFT");
    }
    value = value.slice(0, first) + to + value.slice(first + from.length);
  }
  if (/DEVELOPMENT PREVIEW|Store-preview|not Microsoft Store-certified|TetherplaneStoreDevOnly/i.test(value)) {
    throw new Error("STORE_UI_DEVELOPMENT_SOURCE_LEAK");
  }
  return value;
}

export function assertApprovedScratchPath(directory) {
  const parts = resolve(directory).split(sep).filter(Boolean);
  const idx = parts.findIndex((item) => /^tetherplane-store-private-[0-9a-f]{32}$/i.test(item));
  if (idx < 0 || parts.length !== idx + 3 || parts[idx + 1] !== "payload" || parts[idx + 2] !== "app") {
    throw new Error("STORE_UI_STAGE_DENIED_OUTSIDE_PRIVATE_SCRATCH");
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const mode = process.argv[2];
  const folder = process.argv[3];
  if (!["--check", "--stage"].includes(mode) || !folder || process.argv.length !== 4) {
    throw new Error("STORE_UI_USAGE_CHECK_OR_STAGE_REQUIRED");
  }
  if (mode === "--stage") assertApprovedScratchPath(folder);
  const output = [];
  for (const [name] of changes) {
    const path = resolve(folder, name);
    const data = await readFile(path, "utf8");
    output.push([path, transformStoreRuntime(name, data)]);
  }
  if (mode === "--stage") {
    for (const [path, text] of output) await writeFile(path, text, "utf8");
  }
  console.log(mode === "--stage" ? "STORE_UI_SCRATCH_TRANSFORM_PASS" : "STORE_UI_SOURCE_CONTRACT_PASS");
}
