import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile as callbackExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(callbackExecFile);
import test from "node:test";
import {
  validateRelayUrl, validateDeviceId, validateAllowedRoot, agentArgs,
  requestPairing, readSavedConfig, persistApprovedConfig, createWizard, probeApprovedDevice
} from "../../packaging/msix-store-runtime/app/runtime-app.mjs";
import { windowsPowerShell51Environment } from "../../scripts/msix-store/windows-powershell-env.mjs";

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
    approvalProbe: async () => true,
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
    approvalProbe: async () => true,
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

test("an expired unapproved challenge can be retried without persisting or replacing device identity",async t=>{
  const f=await fixture(t);
  const calls=[];
  const wizard=await createWizard({stateRoot:f.stateRoot,packageRoot:f.packageRoot,fetchImpl:mockFetch(calls)});
  t.after(()=>wizard.close());
  const data={deviceId:"tp-expiring",relayUrl:goodRelay(),allowRoot:f.allowRoot};
  assert.equal((await request(wizard,"/api/pair","POST",data)).status,200);
  assert.ok(wizard.state.pending);
  wizard.state.pending.expiresAt=Date.now()-1;
  const expired=await (await request(wizard,"/api/status")).json();
  assert.equal(expired.state,"pairing_expired");
  assert.ok(expired.pending,"expired challenge remains available for late approval verification");
  assert.equal(expired.hasSavedIdentity,false);
  assert.equal((await request(wizard,"/api/pair","POST",data)).status,200);
  assert.equal(calls.length,2);
  assert.notEqual(calls[0].body.credentialHash,calls[1].body.credentialHash);
  await assert.rejects(()=>stat(f.stateRoot),{code:"ENOENT"});
});


test("relay owner approval must be verified before saving a new identity or starting an agent",async t=>{
  const f=await fixture(t);
  let approved=false;
  let attempts=0;
  let spawns=0;
  const wizard=await createWizard({
    stateRoot:f.stateRoot, packageRoot:f.packageRoot, fetchImpl:mockFetch([]),
    approvalProbe: async () => { attempts++; return approved; },
    spawnAgent:()=>{spawns++;return stubAgent();}
  });
  t.after(()=>wizard.close());
  assert.equal((await request(wizard,"/api/pair","POST",{
    deviceId:"tp-verify-first",relayUrl:goodRelay(),allowRoot:f.allowRoot
  })).status,200);
  const early=await request(wizard,"/api/start","POST",{confirmation:"I APPROVED THIS DEVICE"});
  assert.equal(early.status,400);
  assert.equal((await request(wizard,"/api/status")).status,200);
  assert.equal((await (await request(wizard,"/api/status")).json()).hasSavedIdentity,false);
  assert.equal(spawns,0);
  await assert.rejects(()=>stat(f.stateRoot),{code:"ENOENT"});
  approved=true;
  assert.equal((await request(wizard,"/api/start","POST",{confirmation:"I APPROVED THIS DEVICE"})).status,200);
  assert.equal(attempts,2);
  assert.equal(spawns,1);
  assert.equal((await (await request(wizard,"/api/status")).json()).hasSavedIdentity,true);
});

test("WSS approval probe checks the exact RFC6455 challenge, never accepts a fake HTTP upgrade",async()=>{
  const config={deviceId:"tp-probe",relayUrl:goodRelay(),secret:"synthetic-credential-12345678901234567890"};
  const seen=[];
  const fakeRequest=(mode)=>(url,options)=>{
    seen.push({scheme:url.protocol,path:url.pathname,method:options.method,headers:options.headers});
    const req=new EventEmitter();
    req.end=()=>{
      queueMicrotask(()=>{
        if(mode==="denied"){
          const res=new EventEmitter();res.statusCode=401;res.resume=()=>{};
          req.emit("response",res);
        } else {
          const key=options.headers["sec-websocket-key"];
          const expected=createHash("sha1").update(key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
          req.emit("upgrade",{statusCode:101,headers:{
            "sec-websocket-accept":mode==="valid"?expected:"invalid",
            upgrade:"websocket"
          }},{destroy(){}},Buffer.alloc(0));
        }
      });
    };
    req.destroy=()=>{};
    return req;
  };
  await assert.rejects(()=>probeApprovedDevice(config,{requestImpl:fakeRequest("denied")}));
  await assert.rejects(()=>probeApprovedDevice(config,{requestImpl:fakeRequest("forged")}));
  assert.equal(await probeApprovedDevice(config,{requestImpl:fakeRequest("valid")}),true);
  assert.equal(seen.length,3);
  for(const sample of seen){
    assert.equal(sample.scheme,"https:");
    assert.equal(sample.path,"/device");
    assert.equal(sample.method,"GET");
    assert.equal(sample.headers.authorization,"Device "+config.secret);
    assert.equal(sample.headers["x-tetherplane-device-id"],"tp-probe");
  }
});


test("late owner approval remains recoverable after pairing code TTL, without a second identity",async t=>{
  const f=await fixture(t);
  const calls=[], spawns=[];
  const wizard=await createWizard({
    stateRoot:f.stateRoot,packageRoot:f.packageRoot,fetchImpl:mockFetch(calls),
    approvalProbe:async()=>true,
    spawnAgent:(exe,args)=>{spawns.push({exe,args});return stubAgent();}
  });
  t.after(()=>wizard.close());
  assert.equal((await request(wizard,"/api/pair","POST",{
    deviceId:"tp-late-approval",relayUrl:goodRelay(),allowRoot:f.allowRoot
  })).status,200);
  wizard.state.pending.expiresAt=Date.now()-1;
  const status=await (await request(wizard,"/api/status")).json();
  assert.equal(status.state,"pairing_expired");
  assert.ok(status.pending);
  assert.equal((await request(wizard,"/api/start","POST",{confirmation:"I APPROVED THIS DEVICE"})).status,200);
  assert.equal((await (await request(wizard,"/api/status")).json()).hasSavedIdentity,true);
  assert.equal(calls.length,1);
  assert.equal(spawns.length,1);
});


test("Windows newly paired identity has a user-and-SYSTEM-only DACL before credential persistence", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const secret = "synthetic-only-not-a-real-device-credential-20261027";
  await persistApprovedConfig(f.stateRoot, {
    deviceId: "tp-windows-acl",
    relayUrl: goodRelay(),
    allowRoot: f.allowRoot,
    secret,
    expiresAt: Date.now() + 600_000,
  });
  assert.equal((await readFile(join(f.stateRoot, "device-credential.txt"), "utf8")).trim(), secret);
  assert.equal((await readSavedConfig(f.stateRoot)).deviceId, "tp-windows-acl");

  // Independent Windows security descriptor inspection, not source-code
  // assertions or POSIX mode bits. Do not print ACL identities or secrets.
  const check = [
    "$ErrorActionPreference = 'Stop'",
    "$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$permitted = @($owner, 'S-1-5-18')",
    "$paths = @($env:TETHERPLANE_TEST_STATE_ROOT, $env:TETHERPLANE_TEST_CREDENTIAL_PATH, $env:TETHERPLANE_TEST_CONFIG_PATH)",
    "foreach ($path in $paths) {",
    "  $acl = Get-Acl -LiteralPath $path",
    "  if ($path -eq $paths[0] -and -not $acl.AreAccessRulesProtected) { throw 'Private state root still inherits a parent DACL' }",
    "  $rules = @($acl.Access)",
    "  if ($rules.Count -lt 2) { throw 'Private state DACL has insufficient entries' }",
    "  $observed = @()",
    "  foreach ($rule in $rules) {",
    "    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "    if ($permitted -notcontains $sid) { throw 'Private state contains an unintended principal' }",
    "    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw 'Private state contains an unexpected denial' }",
    "    $observed += $sid",
    "  }",
    "  if ($observed -notcontains $owner -or $observed -notcontains 'S-1-5-18') { throw 'Private state does not grant the owner and SYSTEM' }",
    "}",
    "'WINDOWS_USER_PRIVATE_DACL_PASS'",
  ].join("\n");
  const { stdout } = await execFileAsync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", check], {
      windowsHide: true, timeout: 15_000, maxBuffer: 32_768,
      env: {
        ...windowsPowerShell51Environment(process.env),
        TETHERPLANE_TEST_STATE_ROOT: f.stateRoot,
        TETHERPLANE_TEST_CREDENTIAL_PATH: join(f.stateRoot, "device-credential.txt"),
        TETHERPLANE_TEST_CONFIG_PATH: join(f.stateRoot, "device.json"),
      },
    });
  assert.match(stdout, /WINDOWS_USER_PRIVATE_DACL_PASS/);
});

test("Windows pre-existing or foreign state is preserved without ACL edits or re-pairing", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  await mkdir(f.stateRoot);
  const sentinel = join(f.stateRoot, "foreign-data.txt");
  await writeFile(sentinel, "untouched");
  await assert.rejects(
    () => persistApprovedConfig(f.stateRoot, {
      deviceId: "tp-no-overwrite", relayUrl: goodRelay(), allowRoot: f.allowRoot,
      secret: "synthetic-only-credential-that-must-never-be-written",
      expiresAt: Date.now() + 600_000,
    }),
    /Windows private device state could not be created/
  );
  assert.equal(await readFile(sentinel, "utf8"), "untouched");
  await assert.rejects(() => stat(join(f.stateRoot, "device-credential.txt")), { code: "ENOENT" });
  await assert.rejects(() => stat(join(f.stateRoot, "device.json")), { code: "ENOENT" });
});


test("Windows saved credential ACL drift blocks restart without modifying identity", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const original = {
    deviceId: "tp-drift-detected",
    relayUrl: goodRelay(),
    allowRoot: f.allowRoot,
    secret: "synthetic-only-restart-dacl-drift-credential",
    expiresAt: Date.now() + 600_000
  };
  await persistApprovedConfig(f.stateRoot, original);
  const credPath = join(f.stateRoot, "device-credential.txt");
  const configPath = join(f.stateRoot, "device.json");
  const originalCredential = await readFile(credPath, "utf8");
  const originalConfig = await readFile(configPath, "utf8");
  assert.equal((await readSavedConfig(f.stateRoot)).deviceId, original.deviceId);

  // Simulate an ACL regression in this disposable fixture only. We grant
  // builtin Users read access to a SYNTHETIC credential, never to an owner
  // device, and do not relax machine-wide security controls.
  const icacls = join(process.env.SystemRoot || process.env.WINDIR, "System32", "icacls.exe");
  await execFileAsync(icacls, [credPath, "/grant", "*S-1-5-32-545:(R)"], {
    windowsHide: true, timeout: 8_000, maxBuffer: 16_384
  });
  await assert.rejects(
    () => readSavedConfig(f.stateRoot),
    /Existing Windows device state has unverified permissions/
  );
  await assert.rejects(
    () => createWizard({ stateRoot: f.stateRoot, packageRoot: f.packageRoot }),
    /Existing Windows device state has unverified permissions/
  );
  assert.equal(await readFile(credPath, "utf8"), originalCredential);
  assert.equal(await readFile(configPath, "utf8"), originalConfig);

  // Verify Tetherplane did not silently "fix" or erase the bad ACE.
  const verify = [
    "$ErrorActionPreference = 'Stop'",
    "$acl = [System.IO.File]::GetAccessControl($env:TP_DRIFT_FIXTURE)",
    "$found = $false",
    "foreach ($rule in $acl.Access) {",
    "  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "  if ($sid -eq 'S-1-5-32-545') { $found = $true }",
    "}",
    "if (-not $found) { throw 'Expected fixture ACL drift was silently removed' }",
    "'DRIFT_PRESERVED_FOR_OWNER_REVIEW'"
  ].join("\n");
  const { stdout } = await execFileAsync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", verify], {
      windowsHide: true, timeout: 15_000, maxBuffer: 16_384,
      env: { ...windowsPowerShell51Environment(process.env), TP_DRIFT_FIXTURE: credPath }
    });
  assert.match(stdout, /DRIFT_PRESERVED_FOR_OWNER_REVIEW/);
});

test("Windows ACL drift on the saved state root blocks identity reuse", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  await persistApprovedConfig(f.stateRoot, {
    deviceId: "tp-root-drift",
    relayUrl: goodRelay(),
    allowRoot: f.allowRoot,
    secret: "synthetic-only-root-drift-credential-value",
    expiresAt: Date.now() + 600_000
  });
  const preserved = await readFile(join(f.stateRoot, "device.json"), "utf8");
  const icacls = join(process.env.SystemRoot || process.env.WINDIR, "System32", "icacls.exe");
  await execFileAsync(icacls, [f.stateRoot, "/grant", "*S-1-5-32-545:(OI)(CI)(R)"], {
    windowsHide: true, timeout: 8_000, maxBuffer: 16_384
  });
  await assert.rejects(
    () => readSavedConfig(f.stateRoot),
    /Existing Windows device state has unverified permissions/
  );
  assert.equal(await readFile(join(f.stateRoot, "device.json"), "utf8"), preserved);
});
