import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseChallengeUrl, normalizeCode, extractCredentialPath,
  approveVaulterLogin, runCli,
} from '../approve-vaulter-signin.mjs';

const URL = 'https://vaulter.tailf65eba.ts.net/interaction/interaction_ABCDEFG12/device-login';
const CODE = 'AB12-CD34';
const FILE = 'C:\\ProgramData\\Tetherplane\\device.credential';
const SECRET = 'a-valid-existing-device-credential-which-must-not-be-logged';

test('parses a challenge only from the exact protected Vaulter origin and interaction path', () => {
  assert.equal(parseChallengeUrl(URL), 'interaction_ABCDEFG12');
  assert.equal(parseChallengeUrl(URL.replace('/device-login', '')), 'interaction_ABCDEFG12');
  for (const invalid of [
    URL.replace('https:', 'http:'), URL.replace('vaulter.tailf65eba.ts.net', 'attacker.example'),
    URL.replace('vaulter.tailf65eba.ts.net', 'vaulter.tailf65eba.ts.net.attacker.example'),
    URL.replace('/interaction/', '/fake/interaction/'), URL + '?token=foo',
    URL + '#fragment', URL.replace('net/', 'net:443/'),
    URL.replace('/device-login', '/consent'),
    'https://vaulter.tailf65eba.ts.net@attacker.test/interaction/interaction_ABCDEFG12',
  ]) assert.throws(() => parseChallengeUrl(invalid), /challenge link/i, invalid);
});

test('normalizes only valid one-time codes without guessing or silently repairing', () => {
  assert.equal(normalizeCode('ab12-cd34'), CODE);
  assert.equal(normalizeCode(' AB12-CD34 '), CODE);
  for (const invalid of ['', 'abcd1234', 'ABCD-E', 'ABCD-EFGHI', 'ABCD--1234', 'ABCD-1234\nX']) {
    assert.throws(() => normalizeCode(invalid), /code/i);
  }
});

test('extracts only VAULTER device credential file path, never the raw process command line', () => {
  const vaulter = '"C:\\Tetherplane\\tetherd.exe" --device-id VAULTER --device-credential-file "C:\\ProgramData\\Tetherplane\\device.credential" --relay-url wss://vaulter.tailf65eba.ts.net:10000/device';
  assert.equal(extractCredentialPath(vaulter), FILE);
  assert.equal(extractCredentialPath(vaulter.replace('VAULTER','Leno')), null);
  assert.equal(extractCredentialPath('--device-id VAULTER --device-credential-file C:\\tmp\\plain.txt'), 'C:\\tmp\\plain.txt');
  assert.equal(extractCredentialPath('--device-id VAULTER --device-credential-file'), null);
});

test('rejects absent human authorization before reading a secret or making any request', async () => {
  let reads = 0, requests = 0;
  for (const confirm of ['NO', '', 'APPROVE!']) {
    await assert.rejects(approveVaulterLogin({
      interactionUrl: URL, userCode: CODE, credentialFile: FILE, confirmation: confirm,
      readFileImpl: async () => { reads++; return SECRET; },
      fetchImpl: async () => { requests++; throw Error('must not request'); },
    }), /confirmation/i);
  }
  assert.equal(reads, 0);
  assert.equal(requests, 0);
});

test('approves exactly one interaction via fixed loopback relay using the existing credential in memory', async () => {
  let calls = 0;
  const result = await approveVaulterLogin({
    interactionUrl: URL, userCode: CODE, credentialFile: FILE, confirmation: 'APPROVE',
    readFileImpl: async (path, encoding) => { assert.equal(path, FILE); assert.equal(encoding, 'utf8'); return SECRET + '\n'; },
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:8788/auth/device-login/approve');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Authorization, 'Device ' + SECRET);
      assert.equal(options.headers['x-tetherplane-device-id'], 'VAULTER');
      assert.deepEqual(JSON.parse(options.body), {interactionUid: 'interaction_ABCDEFG12', userCode: CODE});
      assert.equal(options.body.includes(SECRET), false);
      return { status: 200, json: async () => ({status: 'approved'}) };
    },
  });
  assert.deepEqual(result, { status: 'approved' });
  assert.equal(calls, 1);
});

test('fails closed for nonexistent or malformed device credentials and does not call the relay', async () => {
  let calls = 0;
  for (const secret of ['', 'short', 'contains\nheader-injection']) {
    await assert.rejects(approveVaulterLogin({
      interactionUrl: URL, userCode: CODE, credentialFile: FILE, confirmation: 'APPROVE',
      readFileImpl: async () => secret,
      fetchImpl: async () => { calls++; throw Error('must not request'); },
    }), /credential/i);
  }
  assert.equal(calls, 0);
});

test('rejects unauthorized, expired, replayed, redirected, and inconsistent relay replies without leaking the credential', async () => {
  for (const status of [200, 302, 400, 401, 403, 404, 500]) {
    let calls = 0;
    await assert.rejects(approveVaulterLogin({
      interactionUrl: URL, userCode: CODE, credentialFile: FILE, confirmation: 'APPROVE',
      readFileImpl: async () => SECRET,
      fetchImpl: async () => {
        calls++;
        return {status, json: async () => ({status: status===200 ? 'pending' : 'error', detail: SECRET})};
      },
    }), error => { assert.equal(String(error).includes(SECRET), false); return true; });
    assert.equal(calls, 1);
  }
});

test('CLI declines non-interactive use before reading any device identity', async () => {
  let fetched = 0, read = 0;
  await assert.rejects(runCli({
    input: {isTTY: false}, output: {isTTY: true},
    readFileImpl: async () => {read++;return SECRET;},
    fetchImpl: async () => {fetched++;},
  }), /interactive terminal/i);
  assert.equal(fetched, 0);
  assert.equal(read, 0);
});

test('real HTTP integration sends only the approved JSON and device identity to a loopback relay', async () => {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/auth/device-login/approve');
    assert.equal(req.headers['x-tetherplane-device-id'], 'VAULTER');
    assert.equal(req.headers.authorization, 'Device ' + SECRET);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')),
      { interactionUid: 'interaction_ABCDEFG12', userCode: CODE });
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ status: 'approved' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    let requests = 0;
    const result = await approveVaulterLogin({
      interactionUrl: URL, userCode: CODE, credentialFile: FILE, confirmation: 'APPROVE',
      readFileImpl: async () => SECRET,
      fetchImpl: (address, options) => {
        requests++;
        assert.equal(address, 'http://127.0.0.1:8788/auth/device-login/approve');
        return fetch('http://127.0.0.1:' + port + '/auth/device-login/approve', options);
      },
    });
    assert.deepEqual(result, { status: 'approved' });
    assert.equal(requests, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
