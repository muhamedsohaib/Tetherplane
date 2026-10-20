import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProfile } from '../../scripts/release/phase1-client-profile.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'tetherplane-client-profile-'));
const server = path.join(root, 'stdio-server.js');
const tetherd = path.join(root, 'tetherd');
const principal = path.join(root, 'principal.json');
const allow = path.join(root, 'allowed');
const state = path.join(root, 'state');
writeFileSync(server, 'server');
writeFileSync(tetherd, 'agent');
writeFileSync(principal, '{}');
mkdirSync(allow);
mkdirSync(state);
const flags = ['--server', server, '--tetherd', tetherd, '--allow', allow,
  '--state-dir', state, '--principal-profile', principal];
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

test('OpenCode v1 preview uses the canonical stdio adapter without writing client files', () => {
  const before = readFileSync(server, 'utf8');
  const profile = JSON.parse(buildProfile(['--client', 'opencode', '--opencode-schema', 'v1', ...flags]));
  const config = profile.mcp.tetherplane;
  assert.equal(config.type, 'local');
  assert.equal(config.enabled, true);
  assert.equal(config.command[1], server);
  assert.deepEqual(config.command.slice(2), ['--tetherd', tetherd, '--allow', allow,
    '--state-dir', state, '--principal-profile', principal]);
  assert.equal(readFileSync(server, 'utf8'), before);
});

test('OpenCode v2 preview uses mcp.servers, disables Code Mode and never emits a v1 field', () => {
  const profile = JSON.parse(buildProfile(['--client', 'opencode', '--opencode-schema', 'v2', ...flags]));
  assert.deepEqual(Object.keys(profile.mcp), ['servers']);
  const config = profile.mcp.servers.tetherplane;
  assert.equal(config.type, 'local');
  assert.equal(config.disabled, false);
  assert.equal(config.codemode, false);
  assert.equal(config.enabled, undefined);
  assert.equal(config.command.at(-1), principal);
});

test('refuses ambiguous OpenCode version instead of silently emitting incompatible settings', () => {
  assert.throws(() => buildProfile(['--client', 'opencode', ...flags]), /explicit --opencode-schema/);
  assert.throws(() => buildProfile(['--client', 'opencode', '--opencode-schema', 'v3', ...flags]), /explicit --opencode-schema/);
});

test('Claude Code preview retains stdio JSON structure', () => {
  const { mcpServers } = JSON.parse(buildProfile(['--client', 'claude-code', ...flags]));
  assert.equal(mcpServers.tetherplane.type, 'stdio');
  assert.equal(mcpServers.tetherplane.args[0], server);
  assert.equal(mcpServers.tetherplane.args.includes(principal), true);
});

test('Codex preview generates an explicit TOML server block', () => {
  const output = buildProfile(['--client', 'codex', ...flags]);
  assert.match(output, /^\[mcp_servers\.tetherplane\]/);
  assert.match(output, /command = /);
  assert.match(output, /args = \[/);
  assert.ok(output.includes(JSON.stringify(principal)));
});

test('rejects unknown clients and duplicate, invalid or incomplete flags', () => {
  assert.throws(() => buildProfile(['--client', 'unknown', ...flags]), /unsupported client/);
  assert.throws(() => buildProfile(['--client', 'codex', ...flags, '--allow', allow]), /duplicate/);
  assert.throws(() => buildProfile(['--client', 'codex', ...flags, '--state-dir']), /requires a value/);
  assert.throws(() => buildProfile(['--client', 'codex', '--opencode-schema', 'v1', ...flags]), /only valid for OpenCode/);
});

test('rejects nonexistent, nonabsolute and wrong-kind paths', () => {
  assert.throws(() => buildProfile(['--client', 'claude-code', ...flags.slice(0, 2),
    '--tetherd', path.join(root, 'missing'), '--allow', allow, '--state-dir', state, '--principal-profile', principal]), /does not exist/);
  assert.throws(() => buildProfile(['--client', 'claude-code', '--server', 'relative.mjs',
    '--tetherd', tetherd, '--allow', allow, '--state-dir', state, '--principal-profile', principal]), /absolute path/);
  assert.throws(() => buildProfile(['--client', 'claude-code', '--server', allow,
    '--tetherd', tetherd, '--allow', allow, '--state-dir', state, '--principal-profile', principal]), /regular file/);
});

test('requires explicitly approved principal and isolated state directory', () => {
  const short = ['--client', 'codex', '--server', server, '--tetherd', tetherd, '--allow', allow];
  assert.throws(() => buildProfile(short), /--state-dir is required/);
  assert.throws(() => buildProfile([...short, '--state-dir', state]), /--principal-profile is required/);
  assert.throws(() => buildProfile(['--client', 'codex', ...flags.slice(0, -2)]), /--principal-profile is required/);
  assert.throws(() => buildProfile(['--client', 'codex', ...flags.slice(0, 4), '--allow', allow,
    '--state-dir', allow, '--principal-profile', principal]), /state directory must not equal/);
});

test('rejects overly broad filesystem or home roots', () => {
  const broad = ['--client', 'codex', '--server', server, '--tetherd', tetherd,
    '--state-dir', state, '--principal-profile', principal];
  assert.throws(() => buildProfile([...broad, '--allow', path.parse(root).root]), /allowed root must be narrower/);
  assert.throws(() => buildProfile([...broad, '--allow', os.homedir()]), /allowed root must be narrower/);
});

test('rejects symlinked ancestors as well as final symlink', { skip: process.platform === 'win32' }, () => {
  const alias = path.join(root, 'alias');
  symlinkSync(allow, alias, 'dir');
  assert.throws(() => buildProfile(['--client', 'codex', '--server', server, '--tetherd', tetherd,
    '--allow', alias, '--state-dir', state, '--principal-profile', principal]), /symbolic link/);
});
