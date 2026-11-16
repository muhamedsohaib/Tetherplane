// Read-only developer-beta browser inventory. Never starts a host, loads an
// extension, reads credential contents, accesses tabs, or changes configuration.
import {lstat} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";

const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const packageAssets=Object.freeze({
  browser_launcher:"bin/tetherplane-browserw.exe",
  browser_host:"browser/host.mjs",
  browser_rpc:"browser/dist/index.js",
  edge_manifest:"browser/extension/manifest.json",
  edge_background:"browser/extension/dist/background.js",
  edge_pair_ui:"browser/extension/dist/pair.js",
});
const ownerPrerequisites=Object.freeze({
  browser_bridge_token_present:"browser-bridge.token",
  extension_launch_token_present:"browser-extension-launch.token",
  pinned_extension_id_present:"browser-extension.id",
});

async function regularFileExists(file) {
  try {
    const entry=await lstat(file);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch(error) {
    if(error?.code==="ENOENT")return false;
    // Do not echo sensitive paths or ACL details.
    throw new Error("Browser readiness filesystem metadata could not be inspected.");
  }
}

export async function inspectBrowserReadiness({
  root=packageRoot,
  localAppData=process.env.LOCALAPPDATA,
  exists=regularFileExists
}={}) {
  if(typeof root!=="string" || !root)throw new Error("Package directory is missing.");
  const packageFiles={};
  for(const [name,relative] of Object.entries(packageAssets)) {
    packageFiles[name]=Boolean(await exists(join(root,...relative.split("/"))));
  }
  const ownerFiles={};
  for(const [name,filename] of Object.entries(ownerPrerequisites)) {
    // Only metadata existence is checked. No identity or token contents are read.
    ownerFiles[name]=typeof localAppData==="string" && localAppData.length>0
      ? Boolean(await exists(join(localAppData,"Tetherplane",filename)))
      : false;
  }
  const payloadPresent=Object.values(packageFiles).every(Boolean);
  return {
    schema:"tetherplane.developer-beta.browser-readiness.v1",
    verdict:payloadPresent
      ? "BROWSER_PAYLOAD_STAGED_OWNER_ACTION_REQUIRED"
      : "BROWSER_PACKAGE_INCOMPLETE",
    package_files:packageFiles,
    owner_prerequisites_present:ownerFiles,
    browser_host_started:"not_checked",
    extension_installed:"not_checked",
    browser_authenticated:"not_checked",
    tab_grants:"not_checked",
    guidance:payloadPresent
      ? "Package files are present, not activated. An owner-approved isolated browser setup and explicit expiring tab grant are still required."
      : "Browser package files are incomplete. Stop; do not load an extension or bypass the package preflight."
  };
}

const direct=process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct) {
  try {
    if(process.argv.length!==3 || process.argv[2]!=="--inspect") {
      throw new Error("Use CHECK BROWSER READINESS.cmd");
    }
    if(process.platform!=="win32" || process.arch!=="x64") {
      throw new Error("The developer beta browser diagnostic requires Windows x64.");
    }
    if(resolve(process.execPath).toLowerCase()!==resolve(join(packageRoot,"runtime","node.exe")).toLowerCase()) {
      throw new Error("Use the bundled Node executable.");
    }
    const result=await inspectBrowserReadiness();
    console.log("BROWSER_READINESS="+result.verdict);
    console.log(JSON.stringify(result));
    if(result.verdict!=="BROWSER_PAYLOAD_STAGED_OWNER_ACTION_REQUIRED")process.exitCode=2;
  } catch(error) {
    console.error("BROWSER_READINESS_BLOCKED: "+String(error?.message??"Unknown error").slice(0,200));
    process.exitCode=1;
  }
}
