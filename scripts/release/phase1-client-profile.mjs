#!/usr/bin/env node
// A preview only: emit a bounded stdio MCP client configuration; never write client settings.
import { lstatSync } from 'node:fs';
import os from 'node:os';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const supported = new Set(['opencode', 'claude-code', 'codex']);
const requiredFlags = ['--client', '--server', '--tetherd', '--allow', '--state-dir', '--principal-profile'];
const optionalFlags = ['--node', '--opencode-schema'];

function fail(message) {
  throw new Error(`phase1 client profile: ${message}`);
}

function parseArgs(argv) {
  if (argv.length % 2 !== 0) fail('every flag requires a value');
  const result = Object.create(null);
  const known = new Set([...requiredFlags, ...optionalFlags]);
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!known.has(flag) || !value || value.startsWith('--') || result[flag] !== undefined) {
      fail(`unknown, duplicate, or incomplete argument: ${flag ?? '(missing)'}`);
    }
    result[flag] = value;
  }
  for (const flag of requiredFlags) {
    if (!result[flag]) fail(`${flag} is required`);
  }
  if (!supported.has(result['--client'])) fail('unsupported client');
  if (result['--client'] === 'opencode') {
    if (!['v1', 'v2'].includes(result['--opencode-schema'])) {
      fail('OpenCode requires explicit --opencode-schema v1 or v2');
    }
  } else if (result['--opencode-schema'] !== undefined) {
    fail('--opencode-schema is only valid for OpenCode');
  }
  return result;
}

// Reject links throughout the path rather than only a symlink at the final component.
// A locally selected path is NOT an authorization mechanism: tetherd must still enforce policy.
function checkedPath(value, kind, label) {
  if (!isAbsolute(value)) fail(`${label} must be an absolute path`);
  const fullPath = resolve(value);
  const { root } = parse(fullPath);
  let current = fullPath;
  for (;;) {
    let stat;
    try { stat = lstatSync(current); } catch { fail(`${label} does not exist`); }
    if (stat.isSymbolicLink()) fail(`${label} must not contain a symbolic link`);
    if (current === fullPath) {
      if (kind === 'file' && !stat.isFile()) fail(`${label} must be a regular file`);
      if (kind === 'directory' && !stat.isDirectory()) fail(`${label} must be a directory`);
    }
    if (current === root) break;
    current = dirname(current);
  }
  return fullPath;
}

// TOML basic strings accept JSON-style escaped backslashes and quotes for paths.
function tomlString(value) {
  return JSON.stringify(value);
}

export function buildProfile(argv) {
  const flags = parseArgs(argv);
  const node = checkedPath(flags['--node'] ?? process.execPath, 'file', 'node executable');
  const server = checkedPath(flags['--server'], 'file', 'MCP server');
  const tetherd = checkedPath(flags['--tetherd'], 'file', 'tetherd');
  const allowedRoot = checkedPath(flags['--allow'], 'directory', 'allowed root');
  const stateDir = checkedPath(flags['--state-dir'], 'directory', 'state directory');
  const principal = checkedPath(flags['--principal-profile'], 'file', 'principal profile');
  const systemRoot = parse(allowedRoot).root;
  const home = resolve(os.homedir());
  if (allowedRoot === systemRoot || allowedRoot.toLowerCase() === home.toLowerCase()) {
    fail('allowed root must be narrower than a filesystem or user-home root');
  }
  if (stateDir === allowedRoot) fail('state directory must not equal the allowed root');
  const args = [server, '--tetherd', tetherd, '--allow', allowedRoot,
    '--state-dir', stateDir, '--principal-profile', principal];

  switch (flags['--client']) {
    case 'opencode': {
      const configuration = { type: 'local', command: [node, ...args] };
      const v1 = flags['--opencode-schema'] === 'v1';
      if (v1) {
        return JSON.stringify({ mcp: { tetherplane: { ...configuration, enabled: true } } }, null, 2) + '\n';
      }
      // V2 exposes MCP tools via Code Mode by default. codemode:false preserves
      // the direct six-tool acceptance surface used by the v1 client and other agents.
      return JSON.stringify({ mcp: { servers: {
        tetherplane: { ...configuration, disabled: false, codemode: false },
      } } }, null, 2) + '\n';
    }
    case 'claude-code':
      return JSON.stringify({
        mcpServers: { tetherplane: { type: 'stdio', command: node, args } },
      }, null, 2) + '\n';
    case 'codex':
      return '[mcp_servers.tetherplane]\n' +
        `command = ${tomlString(node)}\n` +
        `args = [${args.map(tomlString).join(', ')}]\n`;
    default:
      fail('unreachable client');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(buildProfile(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
