// Executes the real behavior script with minimal page/transport doubles.
// No private artwork, browser, credential, live issuer or device is involved.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import vm from 'node:vm';
import test from 'node:test';

const script = await readFile(new URL('../public/tp-integration.js', import.meta.url), 'utf8');
const session = {
  devices: [{ deviceId: 'SyntheticDevice', pairedAt: '2026-10-23T00:00:00Z', revokedAt: null, connectivity: 'not_reported' }],
  csrfToken: 'synthetic-csrf', observedAt: '2026-10-23T00:00:00Z',
  expiresAt: '2026-10-23T00:15:00Z', relayOrigin: 'https://relay.invalid',
};
const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => 'application/json' }, json: async () => data,
});

async function page(firstResult) {
  const nodes = new Map([
    ['mini-cmd-input', { value: '' }], ['mini-console-log', { textContent: '' }],
    ['active-node-summary', { textContent: '' }],
  ]);
  const logs = [], requests = [], toasts = [];
  let load, failDirectory = false, failLogout = false;
  const context = {
    document: { getElementById: id => nodes.get(id) || null },
    tpDemo: { session: false }, tpPageInfo: {}, tpCurrentView: 'home', state: {},
    tpEsc: String, tpTime: String, tpGrid: cards => cards.join('\n'),
    tpCard: (...parts) => parts.join('\n'), tpButton: () => '',
    renderPortalPage: () => '', showPortalView: () => {},
    appendMiniLog: value => logs.push(value), toggleThemeMode: () => {}, showToast: value => toasts.push(value),
    renderActivePortalPage: () => {}, addEventListener: (name, callback) => { if (name === 'load') load = callback; },
    AbortController, setTimeout, clearTimeout,
    fetch: async (path, options) => {
      requests.push({ path, method: options.method });
      if (path === '/api/logout') {
        if (failLogout) throw Error('Synthetic sign-out transport failure');
        return response({ signedOut: true });
      }
      if (path === '/api/devices' && failDirectory) return response({ error: { code: 'relay_unavailable', message: 'Synthetic outage' } }, 502);
      if (path === '/api/session' || path === '/api/devices') return response(session);
      const calls = requests.filter(x => x.path === '/api/mcp/call').length;
      if (calls === 1) return firstResult();
      return response({ result: { structuredContent: { synthetic: true } } });
    },
  };
  context.window = context;
  vm.runInNewContext(script, context, { filename: 'tp-integration.js' });
  await load();
  async function submit() {
    nodes.get('mini-cmd-input').value = 'mcp process run SyntheticDevice {"program":"synthetic-no-execution"}';
    await context.submitMiniCommand({ preventDefault() {} });
  }
  async function refresh(fail = false) {
    failDirectory = fail;
    context.refreshPortalDirectory();
    // The UI callback returns void; drain its asynchronous fetch/json updates.
    await nextTurn();
  }
  return { context, nodes, logs, requests, toasts, submit, refresh, failLogout: () => { failLogout = true; }, mcpCount: () => requests.filter(x => x.path === '/api/mcp/call').length };
}

for (const condition of ['transport failure', 'timeout', 'disconnected']) {
  test(`UI fences later MCP commands after ${condition} until a successful refresh`, async () => {
    const p = await page(() => {
      if (condition === 'transport failure') throw Error('Synthetic transport failure');
      return response({ result: { isError: true, structuredContent: { error: { code: condition, message: 'Synthetic unknown outcome' } } } });
    });
    await p.submit();
    await p.submit();
    assert.equal(p.mcpCount(), 1, 'uncertain result must prevent a second MCP request');
    await p.refresh(true);
    await p.submit();
    assert.equal(p.mcpCount(), 1, 'failed directory refresh must not unlock MCP');
    await p.refresh();
    assert.equal(p.mcpCount(), 1, 'refresh must never replay the prior command');
    await p.submit();
    assert.equal(p.mcpCount(), 2, 'successful refresh permits a new explicit command');
  });
}

test('UI preserves definite policy denial without calling it an uncertain mutation', async () => {
  const p = await page(() => response({ result: { isError: true, structuredContent: { error: { code: 'permission_denied' } } } }));
  await p.submit();
  await p.submit();
  assert.equal(p.mcpCount(), 2);
  assert.ok(p.logs.some(x => x.includes('permission_denied')));
});

test('UI reports unavailable directory instead of inventing an empty paired account', async () => {
  const p = await page(() => response({ result: {} }));
  await p.refresh(true);
  for (const view of ['control', 'devices', 'access', 'pairing']) {
    const rendered = p.context.renderPortalPage(view);
    assert.match(rendered, /directory unavailable/i, view);
    assert.doesNotMatch(rendered, /No devices are paired/i, view);
  }
  assert.equal(p.nodes.get('active-node-summary').textContent, 'DIRECTORY UNAVAILABLE');
  await p.refresh();
  assert.match(p.context.renderPortalPage('devices'), /SyntheticDevice/);
  assert.equal(p.nodes.get('active-node-summary').textContent, '1 DIRECTORY RECORDS');
});

test('UI reports an unconfirmed server sign-out when logout transport fails', async () => {
  const p = await page(() => response({ result: {} }));
  p.failLogout();
  await p.context.portalSignOut();
  assert.equal(p.context.tpDemo.session, false);
  assert.match(p.toasts.at(-1), /sign-out was not confirmed/i);
  assert.match(p.toasts.at(-1), /reload and retry/i);
  assert.doesNotMatch(p.toasts.at(-1), /session ended/i);
});

test('UI discards owner authority arriving after sign-out', async () => {
  const p = await page(() => response({ result: {} }));
  const originalFetch = p.context.fetch;
  let finish;
  const delayed = new Promise(resolve => { finish = resolve; });
  p.context.fetch = (path, options) => path === '/api/authority' ? delayed : originalFetch(path, options);
  const loading = p.context.portalAuthorityLoad();
  await nextTurn();
  await p.context.portalSignOut();
  finish(response({ enabled: true, revision: 7, clients: [], grants: [{
    deviceId: 'SyntheticDevice', clientId: 'private-owner-client', principalId: 'private-owner-principal', level: 'observe',
  }] }));
  await loading;
  assert.equal(p.context.tpDemo.session, false);
  assert.doesNotMatch(p.context.renderPortalPage('access'), /private-owner-(client|principal)/,
    'a late response must not restore the previous owner policy to the signed-out page');
});

for (const failed of [false, true]) {
  test(`UI ignores a previous session authority ${failed ? 'failure' : 'response'} after a new sign-in`, async () => {
    const p = await page(() => response({ result: {} }));
    const originalFetch = p.context.fetch;
    let finish, reject, reads = 0;
    const delayed = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
    p.context.fetch = (path, options) => {
      if (path !== '/api/authority') return originalFetch(path, options);
      if (++reads === 1) return delayed;
      return response({ enabled: false, revision: 9, clients: [], grants: [{
        deviceId: 'SyntheticDevice', clientId: 'current-client', principalId: 'current-principal', level: 'blocked',
      }] });
    };
    const stale = p.context.portalAuthorityLoad();
    await p.context.portalSignOut();
    p.nodes.set('tp-live-token', { value: 'synthetic-existing-credential' });
    await p.context.portalLogin({ preventDefault() {} });
    await p.context.portalAuthorityLoad();
    if (failed) reject(Error('old session failure'));
    else finish(response({ enabled: true, revision: 1, clients: [], grants: [] }));
    await stale;
    const rendered = p.context.renderPortalPage('access');
    assert.equal(p.context.tpDemo.session, true);
    assert.match(rendered, /current-client/);
    assert.match(rendered, /REVISION 9/);
    assert.doesNotMatch(rendered, /old session failure/);
  });
}

for (const enabled of [false, true]) {
  test(`UI describes ${enabled ? 'immediate enforced' : 'staged'} grant edits`, async () => {
    const p = await page(() => response({ result: {} }));
    p.context.fetch = async () => response({ enabled, revision: 2, clients: [], grants: [] });
    await p.context.portalAuthorityLoad();
    const rendered = p.context.renderPortalPage('access');
    assert.match(rendered, enabled ? /Save applies this grant immediately/ : /Save stages one grant/);
    assert.match(rendered, enabled ? /\[ Save enforced grant \]/ : /\[ Stage access grant \]/);
  });
}

for (const operation of ['save', 'enforce']) {
  for (const status of [200, 401]) {
    test(`UI fences old authority ${operation} ${status} from a replacement session request`, async t => {
      const p = await page(() => response({ result: {} }));
      const originalFetch = p.context.fetch;
      let finishMutation, finishLoad, reads = 0;
      const mutation = new Promise(resolve => { finishMutation = resolve; });
      const nextLoad = new Promise(resolve => { finishLoad = resolve; });
      t.after(() => finishLoad(response({ enabled: false, revision: 9, clients: [], grants: [] })));
      p.context.fetch = (path, options) => {
        if (path === '/api/authority') {
          if (++reads === 1) return response({ enabled: false, revision: 1, clients: [], grants: [] });
          return nextLoad;
        }
        if (path === (operation === 'save' ? '/api/authority/grants' : '/api/authority/enforcement')) return mutation;
        return originalFetch(path, options);
      };
      await p.context.portalAuthorityLoad();
      for (const [id, value] of [
        ['tp-authority-device', 'SyntheticDevice'], ['tp-authority-client', 'existing-client'],
        ['tp-authority-principal', 'existing-principal'], ['tp-authority-level', 'blocked'],
        ['tp-authority-confirm', 'ENFORCE DEVICE GRANTS'],
      ]) p.nodes.set(id, { value });
      const saving = operation === 'save' ? p.context.portalAuthoritySave() : p.context.portalAuthorityEnforce();
      await p.context.portalSignOut();
      p.nodes.set('tp-live-token', { value: 'synthetic-existing-credential' });
      await p.context.portalLogin({ preventDefault() {} });
      const current = p.context.portalAuthorityLoad();
      finishMutation(response(status === 200 ? { revision: 2 } : { error: { code: 'unauthorized', message: 'Old session expired' } }, status));
      await saving;
      assert.equal(p.context.tpDemo.session, true, 'an old mutation must not invalidate a replacement session');
      void p.context.portalAuthorityLoad();
      assert.equal(reads, 2, 'old completion must not unlock or reload while the new session request is in flight');
      finishLoad(response({ enabled: false, revision: 9, clients: [], grants: [] }));
      await current;
      assert.match(p.context.renderPortalPage('access'), /REVISION 9/);
    });
  }
}

test('UI clears previous owner authority when explicitly signing in again', async () => {
  const p = await page(() => response({ result: {} }));
  const originalFetch = p.context.fetch;
  p.context.fetch = (path, options) => path === '/api/authority'
    ? response({ enabled: false, revision: 1, clients: [], grants: [{
      deviceId: 'SyntheticDevice', clientId: 'previous-owner-client', principalId: 'previous-owner-principal', level: 'blocked',
    }] }) : originalFetch(path, options);
  await p.context.portalAuthorityLoad();
  assert.match(p.context.renderPortalPage('access'), /previous-owner-client/);
  p.nodes.set('tp-live-token', { value: 'synthetic-existing-credential' });
  await p.context.portalLogin({ preventDefault() {} });
  assert.doesNotMatch(p.context.renderPortalPage('access'), /previous-owner-(client|principal)/);
});
