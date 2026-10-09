import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const runner = resolve('scripts/ci-docker-build.sh');

function exercise(mode, shouldSucceed, expectedCalls, expectedWaits) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-docker-retry-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const counter = join(dir, 'calls');
    const waits = join(dir, 'waits');
    const docker = join(bin, 'docker');
    const sleep = join(bin, 'sleep');
    writeFileSync(docker, [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$TP_RETRY_CALLS"',
      'case "$TP_RETRY_MODE" in',
      '  fail-once)',
      '    if [ "$(wc -l < "$TP_RETRY_CALLS")" -eq 1 ]; then',
      '      echo "registry-1.docker.io 429 Too Many Requests" >&2',
      '      exit 1',
      '    fi',
      '    ;;',
      '  always-504)',
      '    echo "failed to fetch oauth token: 504 Gateway Timeout" >&2',
      '    exit 1',
      '    ;;',
      '  compile-error)',
      '    echo "Dockerfile compilation failed: invalid command" >&2',
      '    exit 1',
      '    ;;',
      'esac',
      'echo "build done"',
    ].join('\n') + '\n');
    writeFileSync(sleep, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TP_RETRY_WAITS"\n');
    chmodSync(docker, 0o755);
    chmodSync(sleep, 0o755);
    const result = spawnSync('bash', [runner, 'Dockerfile.relay', 'tetherplane-relay:ci'], {
      cwd: resolve('.'),
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        TP_RETRY_MODE: mode,
        TP_RETRY_CALLS: counter,
        TP_RETRY_WAITS: waits,
      },
    });
    if (result.error) throw result.error;
    assert.equal(result.status === 0, shouldSucceed, 'unexpected exit: ' + result.stderr);
    const calls = existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n') : [];
    const delays = existsSync(waits) ? readFileSync(waits, 'utf8').trim().split('\n') : [];
    assert.equal(calls.length, expectedCalls);
    assert.equal(delays.length, expectedWaits);
    for (const call of calls) {
      assert.equal(call, 'build --file Dockerfile.relay --tag tetherplane-relay:ci .');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test('transient registry 429 retries and then passes', () => {
  assert.equal(existsSync(runner), true, 'Missing bounded Docker registry retry helper');
  exercise('fail-once', true, 2, 1);
});
test('persistent registry 504 fails after three attempts', () => {
  exercise('always-504', false, 3, 2);
});
test('non-registry Docker build failure is not retried', () => {
  exercise('compile-error', false, 1, 0);
});


test('CI uses an explicit Node mirror and preserves the default official production base', () => {
  for (const file of ['Dockerfile.relay', 'Dockerfile.auth']) {
    const dockerfile = readFileSync(resolve(file), 'utf8');
    assert.match(dockerfile, /^ARG NODE_BASE_IMAGE=node:22-bookworm-slim$/m, file);
    assert.equal([...dockerfile.matchAll(/^FROM \$\{NODE_BASE_IMAGE\} AS (?:build|runtime)$/gm)].length, 2, file);
  }
  const script = readFileSync(runner, 'utf8');
  assert.match(script, /--build-arg NODE_BASE_IMAGE=mirror\.gcr\.io\/library\/node:22-bookworm-slim/);
});
