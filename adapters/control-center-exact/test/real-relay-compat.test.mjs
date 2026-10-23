// Cross-source acceptance: the original exact Control Center adapter talks to
// the ACTUAL relay control HTTP implementation, not an invented relay mock.
// Uses disposable loopback listeners, two synthetic accounts and an in-memory
// device registry. It never connects to VAULTER, a real agent or a real issuer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { ExactPortal } from '../server.mjs';
import { StaticClientAuthenticator } from '../../../relay/src/auth/static-auth.ts';
import {
  DeviceRegistry,
  hashDeviceCredential,
} from '../../../relay/src/devices/registry.ts';
import { RelayControlHttpGateway } from '../../../relay/src/devices/control-http.ts';

async function createHarness(t) {
  const registry = await DeviceRegistry.open();
  const disconnected = [];
  const authenticator = new StaticClientAuthenticator([
    {
      token: 'test-owner-token',
      accountId: 'test-account-a',
      clientId: 'test-ui-client-a',
      principalId: 'human:test-owner',
    },
    {
      token: 'test-outsider-token',
      accountId: 'test-account-b',
      clientId: 'test-ui-client-b',
      principalId: 'human:test-outsider',
    },
  ]);
  const gateway = new RelayControlHttpGateway({
    registry,
    authenticator,
    disconnectDevice: (deviceId) => disconnected.push(deviceId),
  });
  const relay = createServer();
  gateway.attach(relay);
  await new Promise((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    gateway.close();
    await new Promise((resolve, reject) => relay.close(error => error ? reject(error) : resolve()));
  });
  const relayOrigin = 'http://127.0.0.1:' + relay.address().port;
  const portal = new ExactPortal({
    relayUrl: relayOrigin,
    htmlPath: fileURLToPath(new URL('./fixture.html', import.meta.url)),
  });
  const portalOrigin = await portal.listen(0);
  t.after(async () => { await portal.close(); });

  async function send(path, { method = 'GET', body, session, csrf = true } = {}) {
    const headers = {
      accept: 'application/json',
      ...(method === 'POST' ? { origin: portalOrigin, 'content-type': 'application/json' } : {}),
      ...(session ? { cookie: session.cookie } : {}),
      ...(session && csrf && method === 'POST' ? { 'x-csrf-token': session.csrf } : {}),
    };
    const response = await fetch(portalOrigin + path, {
      method, redirect: 'manual', headers,
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      data: text ? JSON.parse(text) : null,
      setCookie: response.headers.get('set-cookie'),
    };
  }
  async function signIn(token) {
    const response = await send('/api/session', {
      method: 'POST',
      body: { token },
    });
    if (response.status !== 200) return response;
    return {
      status: response.status,
      data: response.data,
      cookie: response.setCookie.split(';')[0],
      csrf: response.data.csrfToken,
    };
  }
  return { registry, gateway, relayOrigin, portalOrigin, disconnected, send, signIn };
}

test('real relay + exact portal: owner approval is required before a credential is paired', async t => {
  const h = await createHarness(t);
  const secret = 'synthetic-device-secret-owner-allowed';
  const pending = await h.registry.startPairing({
    deviceId: 'LenoTest',
    credentialHash: hashDeviceCredential(secret),
  });
  assert.equal(await h.registry.authenticateDevice('LenoTest', secret), null);
  assert.equal((await h.send('/api/devices')).status, 401);
  assert.equal((await h.signIn('unrecognized-credential')).status, 401);
  const owner = await h.signIn('test-owner-token');
  assert.equal(owner.status, 200);
  assert.match(owner.cookie, /^tetherplane_exact_[0-9]+=[A-Za-z0-9_-]+$/);
  assert.equal(owner.data.authenticated, true);
  assert.deepEqual(owner.data.devices, []);
  assert.equal(
    (await h.send('/api/pair/approve', {
      method: 'POST', session: owner,
      body: { userCode: pending.userCode, confirmOwnership: true }, csrf: false,
    })).status,
    403,
  );
  assert.equal(
    (await h.send('/api/pair/approve', {
      method: 'POST', session: owner,
      body: { userCode: pending.userCode, confirmOwnership: false },
    })).status,
    400,
  );
  assert.equal(await h.registry.authenticateDevice('LenoTest', secret), null);
  const result = await h.send('/api/pair/approve', {
    method: 'POST', session: owner,
    body: { userCode: pending.userCode, confirmOwnership: true },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { paired: true, deviceId: 'LenoTest' });
  assert.equal(await h.registry.authenticateDevice('LenoTest', secret), 'test-account-a');
  const directory = await h.send('/api/devices', { session: owner });
  assert.equal(directory.status, 200);
  assert.equal(directory.data.devices.length, 1);
  assert.equal(directory.data.devices[0].deviceId, 'LenoTest');
  assert.equal(directory.data.devices[0].connectivity, 'not_reported');
  assert.equal(directory.data.devices[0].revokedAt, null);
});

test('real relay + exact portal: account isolation, typed revocation and device denial', async t => {
  const h = await createHarness(t);
  const secret = 'synthetic-device-secret-revoke-check';
  const pending = await h.registry.startPairing({
    deviceId: 'LenoTest',
    credentialHash: hashDeviceCredential(secret),
  });
  await h.registry.approvePairing({ accountId: 'test-account-a', userCode: pending.userCode });
  const owner = await h.signIn('test-owner-token');
  const outsider = await h.signIn('test-outsider-token');
  assert.equal(owner.status, 200);
  assert.equal(outsider.status, 200);
  assert.equal(owner.data.devices.length, 1);
  assert.deepEqual(outsider.data.devices, []);
  assert.equal(
    (await h.send('/api/devices/LenoTest/revoke', {
      method: 'POST', session: outsider,
      body: { confirmDeviceId: 'LenoTest' },
    })).status,
    403,
  );
  assert.equal(
    (await h.send('/api/mcp/call', {
      method: 'POST', session: outsider,
      body: { tool: 'device', op: 'status', device: 'LenoTest', args: {} },
    })).status,
    403,
  );
  assert.equal(
    (await h.send('/api/devices/LenoTest/revoke', {
      method: 'POST', session: owner,
      body: { confirmDeviceId: 'lenotest' },
    })).status,
    400,
  );
  assert.equal(await h.registry.authenticateDevice('LenoTest', secret), 'test-account-a');
  const revoked = await h.send('/api/devices/LenoTest/revoke', {
    method: 'POST', session: owner,
    body: { confirmDeviceId: 'LenoTest' },
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.data, { revoked: true });
  assert.deepEqual(h.disconnected, ['LenoTest']);
  assert.equal(await h.registry.authenticateDevice('LenoTest', secret), null);
  const directory = await h.send('/api/devices', { session: owner });
  assert.equal(directory.status, 200);
  assert.equal(directory.data.devices.length, 1);
  assert.ok(directory.data.devices[0].revokedAt);
  assert.equal(
    (await h.send('/api/mcp/call', {
      method: 'POST', session: owner,
      body: { tool: 'device', op: 'status', device: 'LenoTest', args: {} },
    })).status,
    403,
  );
});
