import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {inspectBrowserReadiness} from "../../packaging/developer-beta/browser-readiness.mjs";

const assets=[
  "bin/tetherplane-browserw.exe",
  "browser/host.mjs",
  "browser/dist/index.js",
  "browser/extension/manifest.json",
  "browser/extension/dist/background.js",
  "browser/extension/dist/pair.js",
];
const ownerFiles=[
  "browser-bridge.token",
  "browser-extension-launch.token",
  "browser-extension.id",
];
function fakeFiles({root,local,packagePresent=assets,ownerPresent=[]}) {
  const found=new Set([
    ...packagePresent.map(f=>join(root,...f.split("/"))),
    ...ownerPresent.map(f=>join(local,"Tetherplane",f))
  ]);
  const observed=[];
  const exists=async path=>{observed.push(path);return found.has(path)};
  return {exists,observed};
}

test("launcher verifies the package before running the read-only inspector",async()=>{
  const cmd=await readFile(join(import.meta.dirname,"../../packaging/developer-beta/CHECK BROWSER READINESS.cmd"),"utf8");
  assert.match(cmd,/preflight\.mjs" --check/);
  assert.match(cmd,/browser-readiness\.mjs" --inspect/);
  assert.doesNotMatch(cmd,/--start|--install|--grant|--browser-host|--pair\b/);
});

test("all browser payload files but no owner prerequisites means staged, NOT connected",async()=>{
  const root=join(tmpdir(),"tp-beta-package");
  const local=join(tmpdir(),"tp-beta-local");
  const {exists,observed}=fakeFiles({root,local});
  const actual=await inspectBrowserReadiness({root,localAppData:local,exists});
  assert.equal(actual.verdict,"BROWSER_PAYLOAD_STAGED_OWNER_ACTION_REQUIRED");
  assert.deepEqual(Object.values(actual.package_files),Array(6).fill(true));
  assert.deepEqual(Object.values(actual.owner_prerequisites_present),Array(3).fill(false));
  assert.equal(actual.browser_authenticated,"not_checked");
  assert.equal(actual.tab_grants,"not_checked");
  assert.equal(actual.extension_installed,"not_checked");
  assert.equal(observed.length,9,"Only six staged assets and three owner file metadata checks are allowed");
  assert.ok(observed.every(file=>file.startsWith(root)||file.startsWith(local)));
});

test("all owner token and extension ID files present never implies browser authorization",async()=>{
  const root=join(tmpdir(),"tp-ready-package");
  const local=join(tmpdir(),"tp-ready-local");
  const {exists}=fakeFiles({root,local,ownerPresent:ownerFiles});
  const report=await inspectBrowserReadiness({root,localAppData:local,exists});
  assert.equal(report.verdict,"BROWSER_PAYLOAD_STAGED_OWNER_ACTION_REQUIRED");
  assert.deepEqual(Object.values(report.owner_prerequisites_present),Array(3).fill(true));
  assert.equal(report.browser_host_started,"not_checked");
  assert.equal(report.browser_authenticated,"not_checked");
  assert.equal(report.tab_grants,"not_checked");
});

test("missing or unverified browser payload denies readiness",async()=>{
  const root=join(tmpdir(),"tp-incomplete-package");
  const local=join(tmpdir(),"tp-incomplete-local");
  const {exists}=fakeFiles({root,local,packagePresent:assets.slice(0,-1)});
  const report=await inspectBrowserReadiness({root,localAppData:local,exists});
  assert.equal(report.verdict,"BROWSER_PACKAGE_INCOMPLETE");
  assert.equal(report.package_files.edge_pair_ui,false);
});

test("metadata lookup failure is fail-closed and does not disclose path",async()=>{
  const root=join(tmpdir(),"tp-readiness-error");
  await assert.rejects(inspectBrowserReadiness({
    root,localAppData:join(tmpdir(),"tp-private"),
    exists:async()=>{throw new Error("metadata unavailable")}
  }),/metadata unavailable/);
});

test("real read-only inspection never modifies synthetic token contents or files",async t=>{
  const temp=await mkdtemp(join(tmpdir(),"tp-browser-readiness-"));
  t.after(()=>rm(temp,{force:true,recursive:true,maxRetries:5,retryDelay:150}));
  const root=join(temp,"package");
  const local=join(temp,"local");
  for(const relative of assets) {
    const dest=join(root,...relative.split("/"));
    await mkdir(dirname(dest),{recursive:true});
    await writeFile(dest,"SYNTHETIC_PACKAGE_CONTENT\n");
  }
  const original="SYNTHETIC_SECRET_CONTENT_NEVER_PRINT\n";
  for(const name of ownerFiles) {
    const dest=join(local,"Tetherplane",name);
    await mkdir(dirname(dest),{recursive:true});
    await writeFile(dest,original);
  }
  const report=await inspectBrowserReadiness({root,localAppData:local});
  assert.equal(report.verdict,"BROWSER_PAYLOAD_STAGED_OWNER_ACTION_REQUIRED");
  assert.ok(!JSON.stringify(report).includes("SYNTHETIC_SECRET_CONTENT_NEVER_PRINT"));
  for(const name of ownerFiles) {
    assert.equal(await readFile(join(local,"Tetherplane",name),"utf8"),original);
  }
});
