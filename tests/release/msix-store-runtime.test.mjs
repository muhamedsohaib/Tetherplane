import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  validateRelayUrl, validateDeviceId, validateAllowedRoot, agentArgs,
  requestPairing, readSavedConfig, persistApprovedConfig, createWizard
} from "../../packaging/msix-store-runtime/app/runtime-app.mjs";

const paired = { pairingId: "synthetic-pair", userCode: "ABCD-1234", expiresAt: new Date(Date.now() + 600000).toISOString() };
function goodRelay() { return "wss://relay.example.test/device"; }
function fixture(t) {
  return mkdtemp(join(tmpdir(), "tetherplane-store-runtime-")).then(async root => {
    const stateRoot = join(root, "isolated-new-state");
    const packageRoot = join(root, "package");
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await writeFile(join(packageRoot, "bin", "tetherd.exe"), "SYNTHETIC_EXECUTABLE_PLACEHOLDER_NOT_RUN");
    const allowRoot = join(root, "allowed folder");
    await mkdir(allowRoot);
    t.after(() => rm(root, { recursive: true, force: true }));
    return { root, stateRoot, packageRoot, allowRoot };
  });
}
function stubAgent() {
  const p = new EventEmitter();
  p.exitCode = null;
  p.stderr = { resume() {} };
  p.kill = () => { p.exitCode = 0; p.emit("exit", 0); return true; };
  return p;
}
function mockFetch(record) {
  return async (url, options) => {
    record.push({ url, method: options.method, redirect: options.redirect, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(paired), { status: 200, headers: { "content-type": "application/json" } });
  };
}
function setupUrl(wizard) {
  const u = new URL(wizard.url);
  return { origin: u.origin, token: u.hash.slice(1) };
}
async function request(wizard, route, method="GET", body, opt={}) {
  const u = setupUrl(wizard);
  return fetch(u.origin + route, {
    method,
    headers: {
      "x-tetherplane-setup": opt.token ?? u.token,
      ...(method === "POST" ? { origin: opt.origin ?? u.origin, "content-type": "application/json" } : {}),
      ...(opt.headers || {}),
    },
    body: method === "POST" ? JSON.stringify(body || {}) : undefined,
    redirect: "manual",
  });
}
test("relay input is TLS-only, exact device route, no embedded credentials or query strings", () => {
  assert.equal(validateRelayUrl("wss://relay.example.test/device"), "wss://relay.example.test/device");
  for (const u of [
    "ws://relay.example.test/device", "https://relay.example.test/device",
    "wss://alice:secret@relay.example.test/device", "wss://relay.example.test/mcp",
    "wss://relay.example.test/device?token=abc", "wss://relay.example.test/device#x",
    " wss://relay.example.test/device"
  ]) assert.throws(() => validateRelayUrl(u));
});

test("device name and access root reject malicious and missing input", async t => {
  const f = await fixture(t);
  assert.equal(validateDeviceId("tp-my-laptop_1"), "tp-my-laptop_1");
  for (const id of ["", "../root", "a b", "a/b", "!" ,"x".repeat(129)]) assert.throws(()=>validateDeviceId(id));
  await assert.rejects(()=>validateAllowedRoot("relative-path"));
  await assert.rejects(()=>validateAllowedRoot(join(f.root, "missing")));
  assert.equal(await validateAllowedRoot(f.allowRoot), f.allowRoot);
});

test("pairing uses only a SHA-256 hash over HTTPS and does not transmit credential or owner token", async () => {
  const calls = [];
  const secret = "synthetic-test-secret-not-an-oauth-token-123";
  const result = await requestPairing({ relayUrl: goodRelay(), deviceId: "tp-test", secret }, { fetchImpl: mockFetch(calls) });
  assert.equal(result.userCode, paired.userCode);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://relay.example.test/pair/start");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].redirect, "manual");
  assert.match(calls[0].body.credentialHash, /^[a-f0-9]{64}$/);
  assert.equal(calls[0].body.deviceId, "tp-test");
  assert.doesNotMatch(JSON.stringify(calls), /synthetic-test-secret|Bearer|authorization/i);
});

test("unexpected pairing response and redirect fail closed", async () => {
  const item = { relayUrl: goodRelay(), deviceId: "tp-fail", secret: "this-is-a-secret-long-enough" };
  await assert.rejects(() => requestPairing(item, { fetchImpl: async () => new Response(null, { status: 302 }) }));
  await assert.rejects(() => requestPairing(item, { fetchImpl: async () =>
    new Response(JSON.stringify({ pairingId: "x", userCode: "BAD", expiresAt: "not-a-date" }), { status: 200 }) }));
});

test("wizard binds to loopback, has strong headers, and never exposes setup token in HTML", async t => {
  const f = await fixture(t);
  const wizard = await createWizard({ stateRoot: f.stateRoot, packageRoot: f.packageRoot, fetchImpl:mockFetch([]) });
  t.after(() => wizard.close());
  const { origin, token } = setupUrl(wizard);
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const page = await request(wizard, "/");
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(page.headers.get("referrer-policy"), /no-referrer/);
  assert.doesNotMatch(html, new RegExp(token));
  const direct = await fetch(origin + "/api/status");
  assert.equal(direct.status, 403);
  const wrong = await request(wizard, "/api/status", "GET", undefined, { token: "wrong" });
  assert.equal(wrong.status, 403);
});

test("untrusted origin and missing pairing confirmation never mutate the filesystem", async t => {
  const f = await fixture(t);
  const calls=[];
  const wizard = await createWizard({ stateRoot:f.stateRoot, packageRoot:f.packageRoot, fetchImpl:mockFetch(calls) });
  t.after(()=>wizard.close());
  const denied=await request(wizard, "/api/pair", "POST",
    { deviceId:"tp-demo",relayUrl:goodRelay(),allowRoot:f.allowRoot },
    { origin:"https://external.example" });
  assert.equal(denied.status,403);
  assert.equal(calls.length,0);
  const premature=await request(wizard,"/api/start","POST",{ confirmation:"I APPROVED THIS DEVICE" });
  assert.equal(premature.status,400);
  await assert.rejects(()=>stat(f.stateRoot),{code:"ENOENT"});
});

test("explicit user pairing flow preserves credential secrecy and does not assert connectivity", async t => {
  const f = await fixture(t);
  const calls=[], spawns=[];
  const wizard=await createWizard({
    stateRoot:f.stateRoot,packageRoot:f.packageRoot,fetchImpl:mockFetch(calls),
    spawnAgent:(exe,args,opts)=>{spawns.push({exe,args,opts});return stubAgent();}
  });
  t.after(()=>wizard.close());
  const values={deviceId:"tp-new",relayUrl:goodRelay(),allowRoot:f.allowRoot};
  const begin=await request(wizard,"/api/pair","POST",values);
  assert.equal(begin.status,200);
  const challenge=await begin.json();
  assert.equal(challenge.userCode,"ABCD-1234");
  await assert.rejects(()=>stat(f.stateRoot),{code:"ENOENT"});
  const notConfirmed=await request(wizard,"/api/start","POST",{ confirmation:"yes" });
  assert.equal(notConfirmed.status,400);
  const started=await request(wizard,"/api/start","POST",{ confirmation:"I APPROVED THIS DEVICE" });
  assert.equal(started.status,200);
  assert.equal((await started.json()).connected,"not_verified");
  assert.equal(spawns.length,1);
  assert.ok(spawns[0].exe.endsWith("tetherd.exe"));
  assert.deepEqual(spawns[0].args.slice(0,4),["--relay-url",goodRelay(),"--device-id","tp-new"]);
  assert.equal(spawns[0].args[spawns[0].args.indexOf("--allow")+1],f.allowRoot);
  const secret=(await readFile(join(f.stateRoot,"device-credential.txt"),"utf8")).trim();
  assert.ok(secret.length>=32);
  assert.notEqual(secret,calls[0].body.credentialHash);
  const status=await request(wizard,"/api/status");
  const details=await status.json();
  assert.equal(details.connected,"not_verified");
  assert.doesNotMatch(JSON.stringify(details),new RegExp(secret));
  const duplicate=await request(wizard,"/api/start","POST",{ confirmation:"I APPROVED THIS DEVICE" });
  assert.equal(duplicate.status,400);
  const stopped=await request(wizard,"/api/stop","POST",{});
  assert.equal(stopped.status,200);
});

test("saved setup resumes only after explicit confirmation and does not re-pair",async t=>{
  const f=await fixture(t);
  const pending={deviceId:"tp-saved",relayUrl:goodRelay(),allowRoot:f.allowRoot,secret:"test-credential-content-that-is-long-enough",expiresAt:Date.now()+50000};
  await persistApprovedConfig(f.stateRoot,pending);
  const previous=await readFile(join(f.stateRoot,"device.json"),"utf8");
  let calls=0;
  const wizard=await createWizard({stateRoot:f.stateRoot,packageRoot:f.packageRoot,
    fetchImpl:async()=>{calls++;throw Error("unexpected pairing");},spawnAgent:()=>stubAgent()});
  t.after(()=>wizard.close());
  const status=await (await request(wizard,"/api/status")).json();
  assert.equal(status.hasSavedIdentity,true);
  const denied=await request(wizard,"/api/pair","POST",{deviceId:"tp-different",relayUrl:goodRelay(),allowRoot:f.allowRoot});
  assert.equal(denied.status,400);
  assert.equal(calls,0);
  const start=await request(wizard,"/api/start","POST",{confirmation:"I APPROVED THIS DEVICE"});
  assert.equal(start.status,200);
  assert.equal(await readFile(join(f.stateRoot,"device.json"),"utf8"),previous);
});

test("existing identity is never overwritten even if a second consent arrives",async t=>{
  const f=await fixture(t);
  const pending={deviceId:"tp-original",relayUrl:goodRelay(),allowRoot:f.allowRoot,secret:"long-test-credential-value-for-identity",expiresAt:Date.now()+50000};
  await persistApprovedConfig(f.stateRoot,pending);
  const old=await readFile(join(f.stateRoot,"device-credential.txt"),"utf8");
  await assert.rejects(()=>persistApprovedConfig(f.stateRoot,pending));
  assert.equal(await readFile(join(f.stateRoot,"device-credential.txt"),"utf8"),old);
  assert.equal((await readSavedConfig(f.stateRoot)).deviceId,"tp-original");
});

test("new pairing becomes a saved identity immediately; stop and restart do not require new pairing", async t => {
  const f = await fixture(t);
  const pairingCalls = [], processes = [];
  const wizard = await createWizard({
    stateRoot: f.stateRoot, packageRoot: f.packageRoot,
    fetchImpl: mockFetch(pairingCalls),
    spawnAgent: (exe,args) => { const p=stubAgent(); processes.push({ p, args }); return p; }
  });
  t.after(() => wizard.close());
  const begin = await request(wizard,"/api/pair","POST",{
    deviceId:"tp-one-shot",relayUrl:goodRelay(),allowRoot:f.allowRoot
  });
  assert.equal(begin.status,200);
  assert.equal((await request(wizard,"/api/start","POST",{confirmation:"I APPROVED THIS DEVICE"})).status,200);
  const savedStatus = await (await request(wizard,"/api/status")).json();
  assert.equal(savedStatus.hasSavedIdentity,true,"same wizard must recognize the new saved identity");
  assert.equal((await request(wizard,"/api/stop","POST",{})).status,200);
  const stopped = await (await request(wizard,"/api/status")).json();
  assert.equal(stopped.state,"stopped");
  assert.equal(stopped.lastError,null);
  assert.equal((await request(wizard,"/api/start","POST",{confirmation:"I APPROVED THIS DEVICE"})).status,200);
  assert.equal(processes.length,2);
  assert.deepEqual(processes[0].args,processes[1].args);
  assert.equal(pairingCalls.length,1,"restart must not request replacement pairing");
  const denied = await request(wizard,"/api/pair","POST",{
    deviceId:"tp-other",relayUrl:goodRelay(),allowRoot:f.allowRoot
  });
  assert.equal(denied.status,400);
  processes[1].p.kill();
});

test("native agent launch failure permits recovery without replacing the stored identity", async t => {
  const f=await fixture(t);
  await persistApprovedConfig(f.stateRoot,{
    deviceId:"tp-retry",relayUrl:goodRelay(),allowRoot:f.allowRoot,
    secret:"test-credential-value-that-is-long-enough",expiresAt:Date.now()+60000
  });
  let attempts=0;
  const wizard=await createWizard({stateRoot:f.stateRoot,packageRoot:f.packageRoot,
    spawnAgent:()=>{
      const agent=stubAgent();
      attempts++;
      if(attempts===1) queueMicrotask(()=>agent.emit("error",new Error("simulated Smart App Control denial")));
      return agent;
    }
  });
  t.after(()=>wizard.close());
  assert.equal((await request(wizard,"/api/start","POST",{confirmation:"I APPROVED THIS DEVICE"})).status,200);
  await new Promise(resolve=>setImmediate(resolve));
  const failure=await (await request(wizard,"/api/status")).json();
  assert.equal(failure.state,"start_failed");
  assert.equal(failure.hasSavedIdentity,true);
  assert.equal((await request(wizard,"/api/start","POST",{confirmation:"I APPROVED THIS DEVICE"})).status,200);
  assert.equal(attempts,2);
});
