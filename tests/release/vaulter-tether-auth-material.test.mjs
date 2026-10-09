import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../scripts/vaulter-tether-auth-material.mjs', import.meta.url));

async function tempRun(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tp-vaulter-auth-'));
  try { await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function execute(directory) {
  return spawnSync(process.execPath, [source, '--directory', directory], {
    encoding: 'utf8', timeout: 30000,
  });
}

test('generates protected key material compatible with RS256 and produces opaque bridge secret', async () => {
  await tempRun(async (directory) => {
    const proc = execute(directory);
    assert.equal(proc.status, 0, proc.stderr);
    assert.match(proc.stdout, /Key material staged/);
    const jwksPath = path.join(directory, 'tether-auth-jwks.json');
    const bridgePath = path.join(directory, 'bridge-token.secret');
    const jwks = JSON.parse(await readFile(jwksPath, 'utf8'));
    const bridge = (await readFile(bridgePath, 'utf8')).trim();
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0].kty, 'RSA');
    assert.equal(jwks.keys[0].alg, 'RS256');
    assert.equal(jwks.keys[0].use, 'sig');
    assert.match(jwks.keys[0].kid, /^[a-zA-Z0-9_-]+$/);
    assert.ok(typeof jwks.keys[0].d === 'string');
    assert.ok(typeof jwks.keys[0].n === 'string');
    const priv = createPrivateKey({ key: jwks.keys[0], format: 'jwk' });
    const pub = createPublicKey(priv);
    const payload = Buffer.from('tetherplane-stage-test');
    assert.equal(verify('sha256', payload, pub, sign('sha256', payload, priv)), true);
    assert.match(bridge, /^[A-Za-z0-9_-]{60,}$/);
    assert.ok(!proc.stdout.includes(bridge));
    assert.ok(!proc.stderr.includes(bridge));
    assert.ok(!proc.stdout.includes(jwks.keys[0].d));
    if (process.platform !== 'win32') {
      assert.equal((await stat(jwksPath)).mode & 0o077, 0);
      assert.equal((await stat(bridgePath)).mode & 0o077, 0);
    }
  });
});

test('never regenerates or replaces an existing signer and token', async () => {
  await tempRun(async (directory) => {
    assert.equal(execute(directory).status, 0);
    const keyPath = path.join(directory, 'tether-auth-jwks.json');
    const tokenPath = path.join(directory, 'bridge-token.secret');
    const originalKey = await readFile(keyPath);
    const originalToken = await readFile(tokenPath);
    const again = execute(directory);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already exists/);
    assert.deepEqual(await readFile(keyPath), originalKey);
    assert.deepEqual(await readFile(tokenPath), originalToken);
  });
});

test('rejects missing and unexpected CLI arguments', async () => {
  const noArgs = spawnSync(process.execPath, [source], { encoding: 'utf8' });
  assert.notEqual(noArgs.status, 0);
  const unknown = spawnSync(process.execPath, [source, '--unsafe-mode'], { encoding: 'utf8' });
  assert.notEqual(unknown.status, 0);
});
