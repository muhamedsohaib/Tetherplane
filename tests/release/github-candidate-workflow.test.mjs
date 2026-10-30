import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function check(w) {
  assert.match(w, /^on:\n  workflow_dispatch:\s*\npermissions:\n  contents: read/m);
  assert.doesNotMatch(w, /^  (?:push|pull_request|pull_request_target|workflow_run|schedule|release):/m);
  assert.doesNotMatch(w, /contents: write|packages: write|gh release|action-gh-release|continue-on-error|secrets\./);
  assert.match(w, /github.ref == 'refs\/heads\/work\/github-release-readiness-20261030'/);
  for (const use of w.matchAll(/uses: ([^\n]+)/g)) assert.match(use[1], /@[0-9a-f]{40}(?:\s|$)/);
  assert.match(w, /lane: \[first, second\]/);
  assert.match(w, /RUSTUP_TOOLCHAIN: '1\.99\.1'/);
  assert.match(w, /node-version: '22\.23\.4'/);
  assert.match(w, /pnpm@10\.34\.5/);
  assert.match(w, /retention-days: 1/);
  assert.match(w, /UNSIGNED-DO-NOT-INSTALL/);
  const verify = w.split('  independent-verify:\n')[1]?.split('  fresh-host:\n')[0];
  assert.ok(verify);
  assert.doesNotMatch(verify, /id-token: write|attestations: write/);
  for (const flag of ['--signer-workflow', '--source-ref', '--source-digest', '--deny-self-hosted-runners']) assert.ok(verify.includes(flag));
  assert.match(verify, /github_candidate\.py compare/);
  assert.match(w, /fresh-host:\n    needs: independent-verify/);
  assert.match(w, /github-candidate-cleanhost\.ps1/);
}
test('GitHub candidate workflow is manual, restricted, pinned, independently rebuilt and verified', () => {
  check(read('.github/workflows/github-windows-candidate.yml'));
});
test('workflow policy rejects broad triggers, mutable actions and omitted verification', () => {
  const w = read('.github/workflows/github-windows-candidate.yml');
  for (const mutate of [s => s.replace('workflow_dispatch:', 'push:'),
    s => s.replace('contents: read', 'contents: write'),
    s => s.replace(/actions\/checkout@[a-f0-9]{40}/, 'actions/checkout@v4'),
    s => s.replace('--source-digest', '--ignored-digest'),
    s => s.replace('lane: [first, second]', 'lane: [first]')]) assert.throws(() => check(mutate(w)));
});
