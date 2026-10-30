// Execute the installed PowerShell entrypoint, including its receipt forwarding.
// This harness is called only by the guarded disposable fresh-host script.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const [prefix, allowed, outside] = process.argv.slice(2).map(p => resolve(p));
const requireInstalled = createRequire(join(prefix, 'adapters/compact-mcp/package.json'));
const { Client } = await import(pathToFileURL(requireInstalled.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(requireInstalled.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
const client = new Client({ name: 'github-exact-installed-candidate', version: '1' }, { capabilities: {} });
try {
  await client.connect(new StdioClientTransport({
    command: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-File', join(prefix, 'launch/tetherplane-mcp.ps1'), '--allow', allowed],
    stderr: 'pipe', cwd: prefix,
  }));
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['batch', 'browser', 'desktop', 'device', 'files', 'process']);
  const status = await client.callTool({ name: 'device', arguments: { op: 'status' } });
  assert.equal(status.isError, undefined);
  assert.equal(status.structuredContent?.agent_version, '0.1.0');
  const denied = await client.callTool({ name: 'files', arguments: { op: 'read', args: { path: outside } } });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent?.error?.code, 'permission_denied');
  console.log('EXACT_INSTALLED_LAUNCHER_SIX_TOOLS_STATUS_AND_PATH_DENIAL_OK');
} finally { await client.close(); }
