// Disposable Node child_process CDP-pipe experiment, Windows Chrome only.
// Exercises real CDP; never attaches to an existing browser profile or session.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const executable = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(executable)) throw new Error('CHROME_REQUIRED_FOR_PRIVATE_PIPE_TEST');

async function probe(extraIoPipes) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'tp-node-private-cdp-'));
  const args = [
    '--remote-debugging-pipe',
    ...(extraIoPipes ? ['--remote-debugging-io-pipes=3,4'] : []),
    '--headless=new', '--no-first-run', '--disable-background-networking',
    '--user-data-dir=' + profile, 'about:blank',
  ];
  let browser;
  const result = { mode: extraIoPipes ? 'explicit-fd3-fd4' : 'default-fd3-fd4', response: false, portFile: null, profileRemoved: false };
  try {
    browser = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    const transportWrite = browser.stdio[3];
    const transportRead = browser.stdio[4];
    let buffer = Buffer.alloc(0);
    const protocol = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('CDP_PIPE_TIMEOUT')), 9000);
      function done(fn, value) { clearTimeout(deadline); fn(value); }
      transportRead.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf(0);
        if (end < 0) return;
        try { done(resolve, JSON.parse(buffer.subarray(0, end).toString('utf8'))); }
        catch (error) { done(reject, error); }
      });
      transportRead.once('end', () => done(reject, new Error('CDP_PIPE_EOF')));
      browser.once('exit', code => done(reject, new Error('CDP_BROWSER_EXIT_' + code)));
      browser.once('error', error => done(reject, error));
      transportWrite.write(JSON.stringify({ id: 1, method: 'Browser.getVersion' }) + '\0');
    });
    result.response = protocol.id === 1 && Boolean(protocol.result?.protocolVersion);
    result.portFile = existsSync(path.join(profile, 'DevToolsActivePort'));
    if (result.response) transportWrite.write(JSON.stringify({ id: 2, method: 'Browser.close' }) + '\0');
    return result;
  } catch (error) {
    result.error = String(error?.message ?? error).slice(0, 170);
    return result;
  } finally {
    if (browser) {
      browser.stdio[3]?.end();
      try { browser.kill(); } catch {}
    }
    const escaped = profile.replace(/'/g, "''");
    const ps = "$r='" + escaped + "';Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" |Where-Object {$_.CommandLine -like \"*$r*\"} |ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}";
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 12000 }); }
    catch (error) { result.cleanupError = String(error?.message ?? error).slice(0, 100); }
    try { await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) { result.cleanupError = String(error?.message ?? error).slice(0, 100); }
    result.profileRemoved = !existsSync(profile);
  }
}

for (const explicit of [false, true]) {
  const result = await probe(explicit);
  console.log(JSON.stringify(result));
  if (result.response && result.portFile === false && result.profileRemoved) process.exit(0);
}
process.exitCode = 1;
