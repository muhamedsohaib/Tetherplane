import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {copyFile, mkdir, readFile, writeFile, rm, stat} from "node:fs/promises";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {pngSize} from "../../scripts/msix-store/verify-store-listing-assets.mjs";

// Only a disposable, same-repository GitHub-hosted Windows PR runner may
// render the genuine UNPAIRED source wizard. No MSIX installation or pairing.
const eligible = process.env.GITHUB_ACTIONS === "true" &&
  process.env.GITHUB_EVENT_NAME === "pull_request" &&
  process.env.RUNNER_OS === "Windows" &&
  process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
  process.env.GITHUB_HEAD_REF?.startsWith("feature/msix-store-artwork-preflight-") &&
  typeof process.env.RUNNER_TEMP === "string" &&
  process.env.RUNNER_TEMP.length > 2;
if (process.env.TETHERPLANE_REQUIRE_UNPAIRED_CAPTURE === "1" && !eligible) {
  throw new Error("STORE_UNPAIRED_SCREENSHOT_DISPOSABLE_WINDOWS_PR_REQUIRED");
}

function findBrowser() {
  const program = process.env.ProgramFiles || "C:\\Program Files";
  const x86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  return [
    join(x86,"Microsoft","Edge","Application","msedge.exe"),
    join(program,"Microsoft","Edge","Application","msedge.exe"),
    join(program,"Google","Chrome","Application","chrome.exe"),
    join(x86,"Google","Chrome","Application","chrome.exe"),
  ].find(existsSync) || null;
}
async function captureBrowser(browser, png, profile, url) {
  // Viewport only. Neither the URL fragment nor browser chrome is captured.
  const args = ["--headless=new","--disable-gpu","--disable-background-networking",
    "--disable-extensions","--no-first-run","--no-default-browser-check",
    "--hide-scrollbars","--window-size=1920,1080",
    "--virtual-time-budget=5000","--user-data-dir="+profile,
    "--screenshot="+png,url];
  const child = spawn(browser,args,{windowsHide:true,stdio:"ignore",timeout:45000});
  const code = await new Promise((resolveExit,rejectExit)=>{
    child.once("error",rejectExit);
    child.once("exit",(c,signal)=>
      signal?rejectExit(new Error("STORE_UI_BROWSER_TERMINATED")):resolveExit(c));
  });
  assert.equal(code,0,"STORE_UI_BROWSER_NONZERO_EXIT");
}

test("real unpaired runtime screen from ephemeral Windows; screenshot discarded",
  {skip:!eligible},async ()=>{
  const browser=findBrowser();
  assert.ok(browser,"STORE_UI_BROWSER_REQUIRED");
  const scratch=join(process.env.RUNNER_TEMP,
    "tetherplane-store-private-"+randomBytes(16).toString("hex"));
  const app=join(scratch,"payload","app");
  const original=resolve("packaging","msix-store-runtime","app");
  const screenshot=join(scratch,"unpaired.NOT_FOR_STORE_SUBMISSION.png");
  const profile=join(scratch,"browser-profile");
  let wizard;
  try {
    await mkdir(app,{recursive:true});
    for(const name of ["runtime-app.mjs","setup.html","setup.css",
                       "setup-client.js","state-security.mjs"]){
      await copyFile(join(original,name),join(app,name));
    }
    const stage=await import("../../scripts/msix-store/stage-store-runtime.mjs");
    stage.assertApprovedScratchPath(app);
    for(const name of ["runtime-app.mjs","setup.html"]){
      const p=join(app,name);
      await writeFile(p,stage.transformStoreRuntime(name,await readFile(p,"utf8")),"utf8");
    }
    const html=await readFile(join(app,"setup.html"),"utf8");
    assert.match(html,/OWNER-APPROVED SETUP/);
    assert.doesNotMatch(html,/DEVELOPMENT PREVIEW|Store-preview|not Microsoft Store-certified/i);
    const runtime=await import(pathToFileURL(join(app,"runtime-app.mjs")).href);
    wizard=await runtime.createWizard({stateRoot:join(scratch,"never-paired-state")});
    assert.equal(wizard.state.status,"idle");
    assert.equal(wizard.state.agent,null);
    assert.equal(wizard.state.pending,null);
    const local=new URL(wizard.url);
    const response=await fetch(new URL("/api/status",local),{
      headers:{"x-tetherplane-setup":local.hash.slice(1)}
    });
    assert.equal(response.status,200);
    const state=await response.json();
    assert.equal(state.state,"idle");
    assert.equal(state.connected,"not_verified");
    assert.equal(state.hasSavedIdentity,false);
    assert.equal(state.pending,null);
    await captureBrowser(browser,screenshot,profile,wizard.url);
    const bytes=await readFile(screenshot);
    const pixel=pngSize(bytes);
    assert.ok(pixel.width>=1366&&pixel.height>=768,
      "STORE_UI_SCREENSHOT_MIN_DESKTOP_SIZE_REQUIRED");
    assert.ok((await stat(screenshot)).size<50*1024*1024,
      "STORE_UI_SCREENSHOT_MAX_50MB");
    assert.equal(wizard.state.status,"idle");
    assert.equal(wizard.state.agent,null);
    assert.equal(wizard.state.pending,null);
    console.log(JSON.stringify({
      gate:"ACTUAL_UNPAIRED_WINDOWS_BROWSER_RENDER_PASS",
      pixels:pixel.width+"x"+pixel.height,
      wizard:"IDLE_UNPAIRED_NOT_CONNECTED",
      screenshot:"DISCARDED_NOT_REVIEWED_NOT_FOR_STORE_SUBMISSION",
      installed_msix:false,owner_devices_touched:false
    }));
  } finally {
    if(wizard)await wizard.close();
    const parent=resolve(process.env.RUNNER_TEMP);
    if(resolve(scratch).startsWith(parent+"\\")&&
      /tetherplane-store-private-[0-9a-f]{32}$/i.test(scratch)) {
      await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:500});
    }
  }
});