import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import type { InvocationEnvelope } from "@tetherplane/protocol";
import { RelayServer } from "../src/server.ts";
import { StaticClientAuthenticator } from "../src/auth/static-auth.ts";
import { hashDeviceCredential } from "../src/devices/registry.ts";

const owner = { accountId: "release-owner", clientId: "enrolled-owner-portal", principalId: "human:owner" };
const ai = { ...owner, clientId: "observed-ai-client" };
const stranger = { ...owner, clientId: "not-approved-ai-client" };
const devices = ["Leno", "Surface", "RTX", "VAULTER"] as const;

function invoke(device: string, capability: string): InvocationEnvelope {
  return {
    protocol_version: "1.0", request_id: "restart-"+Math.random(),
    device_id: device, principal_id: null, job_id: null, capability, arguments: {},
    actor: { id: "untrusted", kind: "ai_client" }, session_id: null,
    response_mode: "compact", idempotency_key: null, preconditions: [], expectations: [],
  };
}
test("Leno-only enforcement survives relay restart, denies strangers, preserves other devices, and can roll back", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-leno-release-restart-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const registryState = path.join(dir, "registry.json");
  const ownerState = path.join(dir, "authority.json");
  await writeFile(ownerState, JSON.stringify({version:1,revision:0,enabled:false,grants:[]})+"\n");
  const auth = new StaticClientAuthenticator([
    {...owner,token:"synthetic-owner-restart"},
    {...ai,token:"synthetic-ai-restart"},
    {...stranger,token:"synthetic-stranger-restart"},
  ]);
  const credentials = new Map<string, string>();
  async function boot() {
    const server = await RelayServer.create({
      authenticator: auth, stateFile: registryState,
      allowInsecureLocalhost: true, ownerAuthority: { owner, stateFile: ownerState },
    });
    const addr = await server.listen({ host:"127.0.0.1", port:0 });
    return {server,addr, sockets:[] as WebSocket[]};
  }
  let running = await boot();
  t.after(async () => {
    for (const s of running.sockets) s.terminate();
    await running.server.close();
  });
  for (const device of devices) {
    const credential = "synthetic-restart-device-credential-"+device;
    credentials.set(device, credential);
    const pairing = await running.server.registry.startPairing({
      deviceId:device,credentialHash:hashDeviceCredential(credential),
    });
    await running.server.registry.approvePairing({accountId:owner.accountId,userCode:pairing.userCode});
  }
  async function connectAll() {
    for (const device of devices) {
      const ws = new WebSocket(running.addr.deviceWsUrl, {headers:{
        authorization:"Device "+credentials.get(device),
        "x-tetherplane-device-id":device,
      }});
      running.sockets.push(ws);
      ws.on("message", raw => {
        const m = JSON.parse(String(raw));
        if(m.type!=="invoke") return;
        ws.send(JSON.stringify({type:"result",routeId:m.routeId,result:{
          protocol_version:"1.0",request_id:m.invocation.request_id,status:"success",
          data:{device,capability:m.invocation.capability},delta:null,
          error:null,policy:null,verification:"not_applicable",continuation:null,
          timing:{duration_ms:1},
        }}));
      });
      await once(ws,"open");
    }
    for (let i=0;i<100 && !devices.every(d=>running.server.router.isOnline(d));i++) {
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(devices.every(d=>running.server.router.isOnline(d)), "all four devices registered after boot");
  }
  async function api(route:string, token:string, method="GET", body?:Record<string,unknown>) {
    const res=await fetch(running.addr.httpUrl+route,{
      method,headers:{
        authorization:"Bearer "+token,
        ...(body?{"content-type":"application/json"}:{}),
      },...(body?{body:JSON.stringify(body)}:{}),
    });
    return {status:res.status,data:await res.json()};
  }
  await connectAll();
  const identity=await auth.authenticate("synthetic-ai-restart");
  const outsider=await auth.authenticate("synthetic-stranger-restart");
  assert.ok(identity && outsider);
  assert.equal((await running.server.router.call(identity,invoke("Leno","device.status"))).status,"success");
  const stage=await api("/owner/leno/grant","synthetic-owner-restart","POST",{
    revision:0,clientId:ai.clientId,principalId:ai.principalId,confirmation:"TRUST Leno"
  });
  assert.equal(stage.status,200);
  assert.equal((await api("/owner/leno/enforcement","synthetic-owner-restart","POST",{
    revision:1,enabled:true,confirmation:"ENFORCE Leno GRANTS"
  })).status,200);
  assert.equal((await running.server.router.call(outsider,invoke("Leno","process.run"))).error?.code,"permission_denied");

  // Simulate a real relay stop/restart using the same persisted registry and authority.
  for (const socket of running.sockets) socket.terminate();
  await running.server.close();
  running=await boot();
  const snapshot=await api("/owner/leno","synthetic-owner-restart");
  assert.equal(snapshot.status,200);
  assert.equal(snapshot.data.revision,2);
  assert.equal(snapshot.data.enabled,false);
  assert.deepEqual(snapshot.data.enforcedDevices,["Leno"]);
  assert.equal(snapshot.data.grants.length,1);
  assert.equal(snapshot.data.clients.some((c:{clientId:string})=>c.clientId===ai.clientId),false,
    "observed-client memory should reset on relay restart");
  await connectAll();
  assert.equal((await running.server.router.call(identity,invoke("Leno","process.run"))).status,"success");
  assert.equal((await running.server.router.call(outsider,invoke("Leno","device.status"))).error?.code,"permission_denied");
  assert.equal((await running.server.router.call(owner,invoke("Leno","device.status"))).status,"success");
  assert.equal((await running.server.router.call(owner,invoke("Leno","process.run"))).error?.code,"permission_denied");
  for(const device of ["Surface","RTX","VAULTER"]) {
    assert.equal((await running.server.router.call(outsider,invoke(device,"process.run"))).status,"success",device);
  }
  const rollback=await api("/owner/leno/enforcement","synthetic-owner-restart","POST",{
    revision:2,enabled:false,confirmation:"RESTORE Leno LEGACY ACCESS",
  });
  assert.equal(rollback.status,200);
  assert.equal(rollback.data.revision,3);
  const restored=await api("/owner/leno","synthetic-owner-restart");
  assert.deepEqual(restored.data.enforcedDevices,[]);
  assert.equal((await running.server.router.call(outsider,invoke("Leno","device.status"))).status,"success");
});