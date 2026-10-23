// Verification only: real portal -> HTTP MCP -> relay router -> WebSocket.
// The device peer and accounts are synthetic; no live issuer, device or owner HTML.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';

import { ExactPortal } from '../../adapters/control-center-exact/server.mjs';
import { StaticClientAuthenticator } from '../src/auth/static-auth.ts';
import { hashDeviceCredential } from '../src/devices/registry.ts';
import { RelayServer } from '../src/server.ts';

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'disposable relay did not reach expected state');
    await delay(10);
  }
}

function deviceResult(invocation, { data = { synthetic: true }, error = null, policy = null } = {}) {
  return {
    protocol_version: '1.0', request_id: invocation.request_id,
    status: error ? 'error' : 'success', data: error ? null : data,
    delta: null, error, policy, verification: error ? 'failed' : 'not_applicable',
    continuation: null, timing: { duration_ms: 1 },
  };
}

async function harness(t, { routeTimeoutMs = 2000 } = {}) {
  const token = 'synthetic-portal-mcp-token';
  const secret = 'synthetic-portal-websocket-credential';
  const relay = await RelayServer.create({
    authenticator: new StaticClientAuthenticator([{
      token, accountId: 'test-account', clientId: 'test-portal-client', principalId: 'human:test-owner',
    }]),
    allowInsecureLocalhost: true, routeTimeoutMs,
  });
  const sockets = [];
  let portal;
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (portal) await portal.close();
    await relay.close();
  });
  const address = await relay.listen({ host: '127.0.0.1', port: 0 });
  const pending = await relay.registry.startPairing({
    deviceId: 'SyntheticDevice', credentialHash: hashDeviceCredential(secret),
  });
  await relay.registry.approvePairing({ accountId: 'test-account', userCode: pending.userCode });
  const observed = [];
  const transport = [];
  portal = new ExactPortal({
    relayUrl: address.httpUrl,
    htmlPath: fileURLToPath(new URL('../../adapters/control-center-exact/test/fixture.html', import.meta.url)),
    fetchImpl: async (url, options) => {
      // Observe the actual transport, retaining no authorization or cookie values.
      const response = await fetch(url, options);
      if (new URL(url).pathname === '/mcp') transport.push({
        method: options.method, status: response.status,
        sessionId: response.headers.get('mcp-session-id') || options.headers['mcp-session-id'],
        rpc: options.body ? JSON.parse(options.body).method : null,
      });
      return response;
    },
  });
  const origin = await portal.listen(0);
  const login = await fetch(origin + '/api/session', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await login.json();

  async function connect(answer = invocation => deviceResult(invocation)) {
    const socket = new WebSocket(address.deviceWsUrl, {
      headers: { authorization: `Device ${secret}`, 'x-tetherplane-device-id': 'SyntheticDevice' },
    });
    sockets.push(socket);
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      observed.push(message);
      const result = answer(message.invocation);
      if (result) socket.send(JSON.stringify({ type: 'result', routeId: message.routeId, result }));
    });
    await once(socket, 'open');
    await until(() => relay.router.isOnline('SyntheticDevice'));
    return socket;
  }
  async function call(tool = 'device', op = 'status', args = {}) {
    const response = await fetch(origin + '/api/mcp/call', {
      method: 'POST', headers: { origin, cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ tool, op, device: 'SyntheticDevice', args }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function assertSessionsClosed(count) {
    const initialized = transport.filter(x => x.rpc === 'initialize');
    const deleted = transport.filter(x => x.method === 'DELETE');
    assert.equal(initialized.length, count);
    assert.equal(deleted.length, count);
    for (const entry of initialized) {
      assert.ok(entry.sessionId);
      assert.ok(deleted.some(x => x.sessionId === entry.sessionId && [200, 202, 204].includes(x.status)));
      const stale = await fetch(address.mcpUrl, {
        method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'mcp-session-id': entry.sessionId },
      });
      assert.equal(stale.status, 404, 'completed portal operation must not retain relay session authority');
      await stale.body?.cancel();
    }
  }
  return { relay, connect, call, observed, assertSessionsClosed };
}

test('portal and real MCP/WS bind the account identity and return a device result', async t => {
  const h = await harness(t);
  await h.connect();
  const response = await h.call();
  assert.equal(response.status, 200);
  assert.equal(response.body.result.isError, undefined);
  assert.deepEqual(response.body.result.structuredContent, { synthetic: true });
  assert.equal(h.observed.length, 1);
  const invocation = h.observed[0].invocation;
  assert.equal(invocation.device_id, 'SyntheticDevice');
  assert.equal(invocation.capability, 'device.status');
  assert.equal(invocation.principal_id, 'human:test-owner');
  assert.deepEqual(invocation.actor, { id: 'test-portal-client', kind: 'ai_client' });
  await h.assertSessionsClosed(1);
});

test('portal preserves actual MCP policy denial and offline/reconnected results', async t => {
  const h = await harness(t);
  const socket = await h.connect(invocation => deviceResult(invocation, {
    error: { code: 'permission_denied', message: 'Synthetic local policy denial', recovery_hint: null, details: {} },
    policy: { decision: 'deny', source: 'synthetic-device' },
  }));
  const denied = await h.call('files', 'read', { path: 'test-only.txt' });
  assert.equal(denied.status, 200);
  assert.equal(denied.body.result.isError, true);
  assert.equal(denied.body.result.structuredContent.error.code, 'permission_denied');
  assert.equal(denied.body.result.structuredContent.policy.decision, 'deny');
  assert.equal(h.observed[0].invocation.capability, 'filesystem.read');
  const closed = once(socket, 'close');
  socket.close();
  await closed;
  await until(() => !h.relay.router.isOnline('SyntheticDevice'));
  const offline = await h.call();
  assert.equal(offline.body.result.isError, true);
  assert.equal(offline.body.result.structuredContent.error.code, 'disconnected');
  assert.equal(h.observed.length, 1, 'offline call must not be delivered to a stale peer');
  await h.connect();
  const recovered = await h.call();
  assert.equal(recovered.body.result.isError, undefined);
  assert.deepEqual(recovered.body.result.structuredContent, { synthetic: true });
  assert.equal(h.observed.length, 2);
  await h.assertSessionsClosed(3);
});

test('portal returns a real route timeout without replaying an uncertain mutation', async t => {
  const h = await harness(t, { routeTimeoutMs: 150 });
  await h.connect(invocation => invocation.capability === 'process.run' ? null : deviceResult(invocation));
  const uncertain = await h.call('process', 'run', { program: 'synthetic-no-execution' });
  assert.equal(uncertain.status, 200);
  assert.equal(uncertain.body.result.isError, true);
  assert.equal(uncertain.body.result.structuredContent.error.code, 'timeout');
  const recovered = await h.call();
  assert.equal(recovered.body.result.isError, undefined);
  assert.equal(h.observed.filter(x => x.invocation.capability === 'process.run').length, 1);
  assert.equal(h.observed.length, 2, 'later successful read must not replay the timed-out mutation');
  await h.assertSessionsClosed(2);
});
