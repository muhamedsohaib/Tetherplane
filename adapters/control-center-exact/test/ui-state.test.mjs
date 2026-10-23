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
