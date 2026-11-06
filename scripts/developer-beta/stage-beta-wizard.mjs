import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";

function change(text,from,to,label){
 const at=text.indexOf(from);
 if(at<0||text.indexOf(from,at+from.length)!==-1)throw Error("BETA_SOURCE_DRIFT: "+label);
 return text.slice(0,at)+to+text.slice(at+from.length);
}
export function validatePublicRelay(value=""){
 if(!value)return "";
 if(typeof value!=="string"||value!==value.trim())throw Error("Relay URL is invalid");
 const u=new URL(value);
 if(u.protocol!=="wss:"||u.pathname!=="/device"||!u.hostname||u.search||u.hash||u.username||u.password||value.length>300)
  throw Error("Use an existing wss:// relay address ending /device without secrets");
 return u.href;
}
export function stage(name,original,relay=""){
 let s=original;
 if(name==="runtime-app.mjs"){
  const pairs=[
   ['join(process.env.LOCALAPPDATA || "", "TetherplaneStoreDevOnly")','join(process.env.LOCALAPPDATA || "", "TetherplaneDeveloperBeta")',"state"],
   ['join(packageRoot, "bin", "tetherd.exe")','join(packageRoot, "bin", "tetherd-agentw.exe")',"agent"],
   ['"bin/tetherd.exe"','"bin/tetherd-agentw.exe"',"selftest"],
   ['const args = agentArgs(config, join(stateRoot, "device-credential.txt"), join(stateRoot, "agent-state"));',
    'const args = [...agentArgs(config, join(stateRoot, "device-credential.txt"), join(stateRoot, "agent-state")), "--owner-instance-lock"];',"instance"],
   ['  const current = { pending: null, agent: null, status: "idle", lastError: null, stopRequested: false };',
    '  const sharedRoot = typeof options.suggestedAllowRoot === "string" ? resolve(options.suggestedAllowRoot) :\n'+
    '    process.env.USERPROFILE ? join(process.env.USERPROFILE, "Tetherplane Shared") : null;\n'+
    '  const current = { pending: null, agent: null, status: "idle", lastError: null, stopRequested: false };',"share_root"],
   ['state: current.status, hasSavedIdentity: Boolean(saved),',
    'state: current.status, suggestedAllowRoot: sharedRoot, hasSavedIdentity: Boolean(saved),',"state_suggestion"],
   ['        const allowRoot = await validateAllowedRoot(body.allowRoot);',
    '        if (sharedRoot && body.allowRoot === sharedRoot) {\n'+
    '          try {\n'+
    '            const entry = await lstat(sharedRoot);\n'+
    '            if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Suggested share is not a real directory.");\n'+
    '          } catch (error) {\n'+
    '            if (error?.code !== "ENOENT") throw error;\n'+
    '            await mkdir(sharedRoot, {mode:0o700});\n'+
    '          }\n'+
    '        }\n'+
    '        const allowRoot = await validateAllowedRoot(body.allowRoot);',"folder_create"]
  ];
  for(const [from,to,label] of pairs)s=change(s,from,to,label);
  return s;
 }
 if(name==="setup.html"){
  const replacements=[
   ["<title>Tetherplane — private setup preview</title>","<title>Tetherplane — Add device</title>","title"],
   ["TETHERPLANE · DEVELOPMENT PREVIEW","TETHERPLANE · DEVELOPER BETA","label"],
   ["<h1>Connect this computer securely.</h1>","<h1>Add this Windows computer</h1>","heading"],
   ["<p>Install once. Approve this device using your existing owner account. No new OAuth clients or device replacements.</p>",
    "<p>One owner approval, one device identity. No copied passwords or OAuth tokens.</p>","purpose"],
   ["This development build is not Microsoft Store-certified. Do not use it to replace an existing Tetherplane installation.",
    "Developer beta, not Store-certified or product-signed. Use a consenting test computer. Do not replace another agent or bypass Windows security.","trust"],
   ["New device ID <input","Device ID (automatically generated) <input","device"],
   ['Folder permitted for this device <input name="allowRoot" required placeholder="C:\\Users\\You\\Documents">',
    'Folder you explicitly share <input name="allowRoot" required placeholder="C:\\Users\\You\\Tetherplane Shared"><small>Recommended: a separate Tetherplane Shared folder, not your whole home folder. Created when you request pairing.</small>',"folder"],
   ['<button type="submit">Request a pairing code</button>','<button type="submit">Request owner approval</button>',"submit"],
   ["<p>In your existing, authenticated owner Control Center, approve the code below. Never paste your OAuth token here.</p>",
    "<p>On your existing signed-in owner computer, open <strong>Tetherplane Control Center → Device Authority</strong> and approve this exact code and device ID. This setup will connect automatically once the relay confirms approval.</p>","approval"],
   ['<output id="code"></output>','<output id="code"></output><button id="copyCode" type="button">Copy code</button><p id="waiting">Waiting for owner approval…</p>',"copy"],
   ['<button id="start">I approved this device — start agent</button>',
    '<button id="start" type="button">Already approved? Connect now</button>',"fallback"],
   ['<p class="foot">A started process is not proof that the relay accepted it. Confirm authenticated device.status independently before trusting a connection.</p>',
    '<p class="foot"><strong>Approval ≠ connected.</strong> Independently verify device.status from your authenticated owner account. Stop ends this session; revoke the device in Device Authority to remove access.</p>',"truth"]
  ];
  for(const [a,b,k] of replacements)s=change(s,a,b,k);
  const publicUrl=validatePublicRelay(relay).replaceAll("&","&amp;").replaceAll('"',"&quot;");
  s=change(s,'Relay endpoint <input name="relayUrl" required placeholder="wss://your-authorized-relay.example/device" autocomplete="off">',
   'Connection address <input name="relayUrl" required placeholder="wss://your-authorized-relay.example/device" value="'+publicUrl+'" autocomplete="off">',"relay");
  const start=s.indexOf('  <section id="startup" aria-label="Optional startup control">');
  const end=s.indexOf('  </section>',start);
  if(start<0||end<0)throw Error("BETA_SOURCE_DRIFT: startup");
  s=s.slice(0,start)+
    '  <section id="startup"><h2>Reconnect later</h2><p>Developer beta does not silently install Windows startup tasks. Open START HERE.cmd again to resume an approved identity. Your owner can revoke it in Device Authority.</p></section>'+
    s.slice(end+'  </section>'.length);
  return s;
 }
 if(name==="setup-client.js"){
  s=change(s,'const token = location.hash.slice(1);',
    'const token = location.hash.slice(1);\nlet waitingForOwner=false;\nlet approvalProbeBusy=false;',"poll_state");
  s=change(s,'    code.textContent = result.userCode;',
    '    code.textContent = result.userCode;\n    waitingForOwner=true;\n    status.textContent="Waiting for owner approval — agent not started";',"request");
  s=change(s,'    status.textContent = result.state + " — relay authentication not yet independently verified.";',
    '    waitingForOwner=false;\n    status.textContent=result.state+" — verify device.status on owner computer";',"status");
  s=change(s,'document.getElementById("start").addEventListener("click", start);',
    'document.getElementById("start").addEventListener("click", () => {waitingForOwner=false;if(!approvalProbeBusy)void start();});',"manual_start_no_overlap");
  s=change(s,'    status.textContent = r.state + " — connection not verified";',
    '    status.textContent=r.state+" — remote device.status not verified";\n    if(!form.allowRoot.value && r.suggestedAllowRoot) form.allowRoot.value=r.suggestedAllowRoot;',"prefill");
  s+='\n// Automatic retry after local request never bypasses relay owner approval.\n'+
   'async function tryOwnerApprovedStart(){\n'+
   ' if(!waitingForOwner||approvalProbeBusy)return;\n'+
   ' approvalProbeBusy=true;\n'+
   ' try{const r=await call("/api/start",{confirmation:"I APPROVED THIS DEVICE"});\n'+
   '  waitingForOwner=false;\n'+
   '  status.textContent=r.state+" — verify authenticated device.status";\n'+
   '  document.getElementById("waiting").textContent="Approval verified. Agent launched; remote connection not yet independently verified.";\n'+
   ' }catch(error){const message=String(error?.message||"");\n'+
   '  if(/has not confirmed owner approval|not confirmed owner approval|Approve the code/i.test(message)){\n'+
   '   status.textContent="Waiting for owner approval — agent not started";\n'+
   '  }else{waitingForOwner=false;showError(error);}\n'+
   ' }finally{approvalProbeBusy=false;}\n'+
   '}\n'+
   'setInterval(tryOwnerApprovedStart,2500);\n'+
   'document.getElementById("copyCode").addEventListener("click",async()=>{\n'+
   ' try{await navigator.clipboard.writeText(code.textContent);feedback.textContent="Code copied."}\n'+
   ' catch{feedback.textContent="Select and copy the code manually."}\n'+
   '});\n';
  return s;
 }
 if(name==="setup.css")return s+'\nsmall{display:block;margin-top:7px;color:#9fb1c3;line-height:1.5}#waiting{color:#b7e5d3;font-weight:500}button:focus-visible,input:focus-visible{outline:2px solid #8ed3d3;outline-offset:2px}\n';
 throw Error("BETA_UNKNOWN_SOURCE");
}
const direct=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
 const [mode,folder,relay=""]=process.argv.slice(2);
 if(!["--stage","--check"].includes(mode)||!folder||process.argv.length>5)throw Error("Usage: --stage|--check APP_FOLDER [RELAY_WSS]");
 const edits=[];
 for(const name of ["runtime-app.mjs","setup.html","setup-client.js","setup.css"]){
  const p=path.join(path.resolve(folder),name);
  edits.push([p,stage(name,await readFile(p,"utf8"),relay)]);
 }
 if(mode==="--stage")for(const [p,s] of edits)await writeFile(p,s,"utf8");
 console.log(mode==="--stage"?"DEVELOPER_BETA_WIZARD_STAGE_PASS":"DEVELOPER_BETA_WIZARD_SOURCE_CONTRACT_PASS");
}
