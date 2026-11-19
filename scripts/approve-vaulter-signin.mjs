/**
 * Explicit, device-authenticated Tetherplane browser-login approval, VAULTER ONLY.
 * This is a local operator action, not a browser page, OAuth client, or daemon.
 * The device credential is read from its EXISTING local file after confirmation
 * and is transmitted only to VAULTER's loopback relay. It is never printed.
 * No arguments: challenge URLs, codes and file paths are prompted, not logged
 * to shell history. This script does not start/stop/re-pair any agent.
 */
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

const DEVICE_ID = 'VAULTER';
const INTERACTION_ORIGIN = 'https://vaulter.tailf65eba.ts.net';
const RELAY_APPROVE_URL = 'http://127.0.0.1:8788/auth/device-login/approve';

export function parseChallengeUrl(value) {
  const bad = () => new Error('Invalid challenge link: enter the exact Vaulter interaction URL shown for your own current login.');
  if (typeof value !== 'string') throw bad();
  const text = value.trim();
  if (!text.startsWith(INTERACTION_ORIGIN + '/interaction/')) throw bad();
  let url;
  try { url = new URL(text); } catch { throw bad(); }
  if (url.origin !== INTERACTION_ORIGIN || url.username || url.password || url.search || url.hash) throw bad();
  const match = /^\/interaction\/([A-Za-z0-9._~-]{8,256})(?:\/device-login)?$/.exec(url.pathname);
  if (!match) throw bad();
  return match[1];
}

export function normalizeCode(value) {
  if (typeof value !== 'string') throw new Error('Invalid code: enter the one-time code shown on your current Vaulter sign-in page.');
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) {
    throw new Error('Invalid code: expected exactly XXXX-XXXX.');
  }
  return normalized;
}

/** Parse only the existing VAULTER tetherd process flags; never print its command line. */
export function extractCredentialPath(commandLine) {
  if (typeof commandLine !== 'string') return null;
  const id = /(?:^|\s)--device-id\s+(?:"([^"]+)"|(\S+))/i.exec(commandLine);
  if (!id || (id[1] ?? id[2]).toUpperCase() !== DEVICE_ID) return null;
  const match = /(?:^|\s)--device-credential-file\s+(?:"([^"]+)"|(\S+))/i.exec(commandLine);
  const path = match && (match[1] ?? match[2]);
  return path && !/[\r\n]/.test(path) ? path : null;
}

function discoverExistingCredentialPath() {
  if (process.platform !== 'win32') return null;
  try {
    // Does not alter service state. This inspection is local and read-only.
    const cmd = "$p = Get-CimInstance Win32_Process -Filter \"Name = 'tetherd.exe'\" -ErrorAction Stop | Select-Object -ExpandProperty CommandLine; $p | ConvertTo-Json -Compress";
    const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8', windowsHide: true, timeout: 4000, maxBuffer: 128 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = JSON.parse(result);
    const lines = Array.isArray(parsed) ? parsed : [parsed];
    const paths = [...new Set(lines.map(extractCredentialPath).filter(Boolean))];
    return paths.length === 1 ? paths[0] : null;
  } catch { return null; }
}

export async function approveVaulterLogin({
  interactionUrl, userCode, credentialFile, confirmation,
  readFileImpl = readFile, fetchImpl = globalThis.fetch,
}) {
  const interactionUid = parseChallengeUrl(interactionUrl);
  const code = normalizeCode(userCode);
  if (confirmation !== 'APPROVE') throw new Error('Explicit confirmation required: no approval was submitted.');
  if (typeof credentialFile !== 'string' || !credentialFile.trim() || /[\r\n]/.test(credentialFile)) {
    throw new Error('An existing VAULTER device credential file is required. No approval was submitted.');
  }

  let credential;
  try { credential = (await readFileImpl(credentialFile, 'utf8')).trim(); }
  catch { throw new Error('Could not read the existing VAULTER device credential file. No approval was submitted.'); }
  if (!/^\S{16,}$/.test(credential) || /[\r\n]/.test(credential)) {
    throw new Error('Existing VAULTER device credential is invalid. No approval was submitted.');
  }

  let response;
  try {
    response = await fetchImpl(RELAY_APPROVE_URL, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: 'Device ' + credential,
        'x-tetherplane-device-id': DEVICE_ID,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ interactionUid, userCode: code }),
    });
  } catch {
    throw new Error('Local relay request failed; approval is not confirmed. No automatic retry was attempted.');
  } finally {
    credential = undefined;
  }

  if (response.status !== 200) {
    if (response.status === 401) throw new Error('Relay rejected this VAULTER device identity (401); do not reset or re-pair it.');
    if (response.status === 400 || response.status === 404) throw new Error('Login challenge invalid, expired or already used; initiate one fresh browser sign-in.');
    throw new Error('Relay did not confirm approval (HTTP ' + response.status + '); do not retry blindly.');
  }

  let data;
  try { data = await response.json(); } catch {
    throw new Error('Relay response malformed; approval is not confirmed.');
  }
  if (!data || data.status !== 'approved') throw new Error('Relay did not return an approved status; approval is not confirmed.');
  return { status: 'approved' };
}

export async function runCli({
  input = process.stdin,
  output = process.stdout,
  readFileImpl = readFile,
  fetchImpl = globalThis.fetch,
  discoverImpl = discoverExistingCredentialPath,
} = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('An interactive terminal is required: sign-in approval cannot run unattended.');
  if (process.argv.length > 2) throw new Error('No command-line arguments accepted. Enter the challenge privately when prompted.');
  const rl = readline.createInterface({ input, output });
  try {
    output.write('Tetherplane VAULTER: one-time, device-authenticated browser sign-in approval.\n');
    output.write('Only approve a sign-in YOU initiated. Do not paste credentials or a different device\'s code.\n');
    const interactionUrl = (await rl.question('Vaulter browser challenge URL: ')).trim();
    parseChallengeUrl(interactionUrl);
    const userCode = normalizeCode(await rl.question('Current one-time code (XXXX-XXXX): '));
    const discovered = discoverImpl();
    let credentialFile = discovered;
    if (!credentialFile) credentialFile = (await rl.question('Path to existing VAULTER device credential FILE (not its contents): ')).trim();
    if (!credentialFile) throw new Error('No device credential path provided; nothing was submitted.');
    output.write('Device: ' + DEVICE_ID + ' | Approval destination: ' + RELAY_APPROVE_URL + '\n');
    output.write('Check the displayed browser code and account request. Approval cannot be undone.\n');
    const confirmation = (await rl.question('Type APPROVE to authorize this exact sign-in, anything else cancels: ')).trim();
    const result = await approveVaulterLogin({
      interactionUrl, userCode, credentialFile, confirmation, readFileImpl, fetchImpl,
    });
    output.write('Relay confirmed approval. Return to the ORIGINAL browser tab and select Continue after approving.\n');
    return result;
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(error => {
    // The catch only emits messages intentionally authored above. Never include
    // request headers, secret contents, response bodies or raw process commands.
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}
