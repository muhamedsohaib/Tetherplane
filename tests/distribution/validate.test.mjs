import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('distribution guardrails', () => {
 const r = spawnSync(process.execPath, [path.join(base,'scripts/distribution/validate.mjs')], {encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 assert.match(r.stdout,/PASS/);
});
