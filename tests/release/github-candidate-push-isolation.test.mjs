import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const branch = 'work/github-release-readiness-20261030';
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('repository-root and Control Center Vercel configurations deny this review branch', () => {
  for (const path of ['vercel.json', 'adapters/control-center/vercel.json']) {
    const config = JSON.parse(read(path));
    assert.equal(config.git.deploymentEnabled[branch], false,
      'unspecified Vercel branches deploy by default; require an exact review-branch denial');
    assert.ok(Object.values(config.git.deploymentEnabled).every(value => value === false),
      'do not add an enabling rule that can override a branch denial');
  }
});

test('push CI verifies source without binary upload or release permission', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /^on:\n  push:\s*\n  pull_request:\s*$/m);
  assert.match(ci, /^permissions:\n  contents: read\s*$/m,
    'all jobs must have explicit read-only defaults rather than inheriting repository token permissions');
  const quality = ci.split(/^  quality:\n/m)[1];
  assert.ok(quality);
  assert.match(quality, /ref: \$\{\{ github.sha \}\}/, 'quality must test the immutable event revision');
  assert.match(quality, /persist-credentials: false/, 'checkout credentials must not remain in the quality workspace');
  for (const use of ci.matchAll(/uses: ([^\n]+)/g)) assert.match(use[1], /@[0-9a-f]{40}(?:\s|$)/);
  assert.doesNotMatch(ci, /actions\/upload-artifact|contents: write|attestations: write|id-token: write|secrets\.|gh release|vercel (?:deploy|--prod)/);
  for (const gate of ['cargo clippy --workspace --all-targets', 'cargo test --workspace',
    'pnpm -r typecheck', 'pnpm -r test', 'pnpm -r build', 'windows-package-smoke.ps1']) assert.ok(ci.includes(gate));
  const candidate = read('.github/workflows/github-windows-candidate.yml');
  assert.match(candidate, /^on:\n  workflow_dispatch:\s*\npermissions:/m);
  assert.doesNotMatch(candidate, /^  (?:push|pull_request|workflow_run):/m);
});
