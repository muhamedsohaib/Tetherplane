#!/usr/bin/env node
/**
 * Non-publishing, non-installing Codex real-client acceptance harness.
 * - The existing authenticated Codex home is read, NEVER modified.
 * - Session-scoped -c overrides disable ALL inherited MCP entries.
 * - A temporary principal allows only device.status and filesystem.read.
 * - Real model calls require explicit --mode run --approval auto-review.
 * - Stdin is closed; all child processes have bounded timeouts.
 * - The resulting report is sanitized and is NOT release authorization.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SERVER_NAME = 'tetherplane_phase1_trial';
const SOURCE = 'tetherplane.phase1.codex-acceptance.v1';
const MAX_STDOUT = 6 * 1024 * 1024;
const DEFAULT_TIMEOUT = 110;
const DEFAULT_MCP_TIMEOUT = 25;
const HEX64 = /^[a-fA-F0-9]{64}$/;
const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

function failure(message) { throw new Error(message); }
function sha256Bytes(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
export function digestFile(file) {
  return fs.existsSync(file) ? sha256Bytes(fs.readFileSync(file)) : 'ABSENT';
}
export function sanitize(value, home = os.homedir()) {
  let message = String(value ?? '');
  if (home) message = message.split(home).join('[USER]');
  return message
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, '[SECRET]')
    .replace(/Bearer\s+[a-zA-Z0-9._~+/-]{10,}/gi, 'Bearer [SECRET]')
    .slice(0, 450);
}

export function parseFlags(argv) {
  const valid = new Set(['--codex', '--adapter', '--tetherd', '--device', '--node',
    '--mode', '--approval', '--timeout-sec', '--expected-agent-sha256', '--evidence-out']);
  if (argv.length % 2) failure('flags must be supplied in --key value pairs');
  const raw = Object.create(null);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!valid.has(key) || Object.hasOwn(raw, key) || !value || value.startsWith('--')) {
      failure('unknown, repeated or incomplete flag: ' + String(key));
    }
    raw[key] = value;
  }
  for (const key of ['--codex', '--adapter', '--tetherd', '--device']) {
    if (!raw[key]) failure(key + ' is required');
  }
  const mode = raw['--mode'] ?? 'preflight';
  const approval = raw['--approval'] ?? 'none';
  if (!['preflight', 'run'].includes(mode)) failure('mode must be preflight or run');
  if (!['none', 'auto-review'].includes(approval)) failure('unsupported approval mode');
  if (mode === 'run' && approval !== 'auto-review') {
    failure('model invocation requires explicit --mode run --approval auto-review');
  }
  if (mode === 'preflight' && approval !== 'none') failure('preflight must not request approval');
  const timeout = Number(raw['--timeout-sec'] ?? DEFAULT_TIMEOUT);
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 120) {
    failure('timeout-sec must be an integer 30 through 120');
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(raw['--device'])) failure('invalid device label');
  const result = {
    mode, approval, timeoutSec: timeout, device: raw['--device'],
    codex: raw['--codex'], adapter: raw['--adapter'], tetherd: raw['--tetherd'],
    node: raw['--node'] ?? process.execPath,
    expectedAgentHash: raw['--expected-agent-sha256'] ?? null,
    evidenceOut: raw['--evidence-out'] ?? null,
  };
  for (const key of ['codex', 'adapter', 'tetherd', 'node']) {
    if (!path.isAbsolute(result[key])) failure(key + ' must be an absolute file path');
  }
  if (result.expectedAgentHash !== null && !HEX64.test(result.expectedAgentHash)) {
    failure('expected-agent-sha256 must be a SHA-256 hex digest');
  }
  if (result.evidenceOut !== null && !path.isAbsolute(result.evidenceOut)) {
    failure('evidence-out must be an absolute path');
  }
  return result;
}

export function disabledMcpOverrides(entries, nodeExecutable) {
  if (!Array.isArray(entries)) failure('Codex MCP inventory must be an array');
  const seen = new Set();
  const flags = [], transportCounts = Object.create(null);
  for (const item of entries) {
    const name = item?.name, kind = item?.transport?.type;
    if (typeof name !== 'string' || !SAFE_NAME.test(name) || name === SERVER_NAME || seen.has(name)) {
      failure('unsafe, duplicate or conflicting MCP server name');
    }
    seen.add(name);
    let transport;
    if (kind === 'stdio') {
      // A disabled entry still needs a type-correct transport when replacing a table.
      transport = `{enabled=false,command=${tomlString(nodeExecutable)},args=['--version']}`;
    } else if (['streamable_http', 'http', 'sse'].includes(kind)) {
      transport = "{enabled=false,url='http://127.0.0.1:9/disabled'}";
    } else {
      failure('unrecognized existing MCP transport');
    }
    transportCounts[kind] = (transportCounts[kind] ?? 0) + 1;
    flags.push('-c', 'mcp_servers.' + name + '=' + transport);
  }
  return { flags, transportCounts, existingCount: entries.length };
}

export function tomlString(value) {
  const s = String(value);
  if (s.includes('\0') || s.includes('\r') || s.includes('\n')) failure('invalid TOML value');
  // Literal strings keep Windows path separators intact; double apostrophes
  // are not TOML escapes, so reject apostrophes in paths rather than guessing.
  if (s.includes("'")) failure('apostrophe in a configured executable/path is unsupported');
  return "'" + s + "'";
}

export function buildTrialOverride({ node, adapter, tetherd, allow, state, principal }) {
  const args = [adapter, '--tetherd', tetherd, '--allow', allow,
    '--state-dir', state, '--principal-profile', principal];
  return 'mcp_servers.' + SERVER_NAME + '={command=' + tomlString(node) +
    ',args=[' + args.map(tomlString).join(',') + '],startup_timeout_sec=' +
    DEFAULT_MCP_TIMEOUT + ',tool_timeout_sec=' + DEFAULT_MCP_TIMEOUT + '}';
}

export function requireIsolatedServer(entries) {
  if (!Array.isArray(entries)) failure('effective MCP inventory must be an array');
  const active = entries.filter(entry => entry.enabled === true);
  if (active.length !== 1 || active[0].name !== SERVER_NAME ||
      active[0].transport?.type !== 'stdio') {
    failure('effective MCP inventory must contain exactly one enabled local trial server');
  }
  return true;
}

export function summarizeCodexEvents(events, marker, requiredServer = SERVER_NAME) {
  if (!Array.isArray(events) || !marker) failure('invalid event collection');
  const all = events.filter(e => e?.item?.type === 'mcp_tool_call');
  const started = all.filter(e => e.type === 'item.started');
  const completed = all.filter(e => e.type === 'item.completed');
  const unexpectedMcp = all.filter(e => e.item.server !== requiredServer);
  const disallowedItems = events.filter(e => e.item &&
    ['command_execution', 'shell_command', 'web_search', 'web_search_call', 'file_change'].includes(e.item.type));
  const toolNames = completed.map(e => e.item.tool);
  const results = completed.map(e => ({
    tool: e.item.tool,
    status: e.item.status ?? 'unknown',
  }));
  const status = completed.filter(e => e.item.tool === 'device' && e.item.status === 'completed');
  const files = completed.filter(e => e.item.tool === 'files');
  const asJson = e => JSON.stringify([e?.item?.result ?? null, e?.item?.error ?? null]);
  const statusPass = status.some(e => asJson(e).includes('agent_version') && asJson(e).includes('background_only'));
  const fixturePass = files.some(e => e.item.status === 'completed' && asJson(e).includes(marker));
  const deniedPass = files.some(e => e.item.status === 'failed' && asJson(e).includes('permission_denied'));
  const exactlyThree = started.length === 3 && completed.length === 3 &&
    JSON.stringify(toolNames) === JSON.stringify(['device', 'files', 'files']);
  const completeTurn = events.some(e => e.type === 'turn.completed');
  return {
    started_count: started.length,
    completed_count: completed.length,
    completed_tools: results,
    unexpected_mcp_calls: unexpectedMcp.length,
    forbidden_builtin_tool_calls: disallowedItems.length,
    observed_status: statusPass,
    observed_fixture: fixturePass,
    observed_policy_denial: deniedPass,
    exact_three_calls: exactlyThree,
    turn_completed: completeTurn,
    passed: exactlyThree && completeTurn && !unexpectedMcp.length &&
      !disallowedItems.length && statusPass && fixturePass && deniedPass,
  };
}

function realFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) failure(label + ' must be a regular file');
  return file;
}
function invoke(codex, argv, cwd, timeoutMs) {
  return spawnSync(codex, argv, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_STDOUT,
  });
}
function parseJsonl(data) {
  const parsed = [];
  for (const line of String(data ?? '').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try { parsed.push(JSON.parse(line)); } catch { /* invalid line not evidence */ }
  }
  return parsed;
}
function codexInventory(codex, argv, dir) {
  const p = invoke(codex, ['mcp', 'list', '--json', ...argv], dir, 20_000);
  if (p.status !== 0) failure('Codex MCP inventory unavailable: ' + sanitize(p.stderr || p.error?.message));
  let data;
  try { data = JSON.parse(p.stdout); } catch { failure('Codex MCP inventory JSON invalid'); }
  return data;
}
function testRoot() {
  const parent = process.platform === 'win32' ? process.env.LOCALAPPDATA : os.tmpdir();
  if (!parent || !path.isAbsolute(parent)) failure('a valid local temp root is required');
  return fs.mkdtempSync(path.join(parent, 'TetherplaneCodexPhase1-'));
}
function principal(device, allow) {
  return {
    principal_id: 'model:phase1-codex-readonly', authentication: 'local_process_binding',
    allowed_devices: [device], allowed_capabilities: ['device.status', 'filesystem.read'],
    allowed_roots: [allow],
  };
}
function modelPrompt(device, allowedFixture, outside) {
  return [
    `Using only MCP server ${SERVER_NAME}, make exactly three real MCP tool calls.`,
    `First call device with {"op":"status","device":${JSON.stringify(device)}}.`,
    `Second call files with {"op":"read","device":${JSON.stringify(device)},"args":{"path":${JSON.stringify(allowedFixture)}}}.`,
    `Third call files with {"op":"read","device":${JSON.stringify(device)},"args":{"path":${JSON.stringify(outside)}}}.`,
    'The third call must return permission_denied because the file is outside the allowed root.',
    'Do not use any shell, browser, web, other MCP server, or any modifying tool.',
    'Use actual tool outputs; briefly summarize and stop.',
  ].join(' ');
}

export function runAcceptance(flags) {
  const begin = Date.now();
  const report = {
    schema: SOURCE,
    run_mode: flags.mode,
    review_mode: flags.mode === 'run' ? 'codex-auto-review-NOT-human-approval' : 'not-used',
    device: flags.device,
    platform: process.platform,
    run_date_utc: new Date().toISOString(),
    publication_authorized: false,
    clean_install_proven: false,
    signed_windows_binary_proven: false,
    model_client_success: false,
    agent_sha256: null,
    adapter_sha256: null,
  };
  let root;
  const cfgHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const savedConfig = path.join(cfgHome, 'config.toml');
  const previousConfig = digestFile(savedConfig);
  try {
    for (const [label, file] of [['codex', flags.codex], ['node', flags.node],
      ['MCP adapter', flags.adapter], ['agent binary', flags.tetherd]]) realFile(file, label);
    report.agent_sha256 = digestFile(flags.tetherd);
    report.adapter_sha256 = digestFile(flags.adapter);
    const version = invoke(flags.codex, ['--version'], process.cwd(), 15_000);
    if (version.status !== 0) failure('Codex CLI version lookup failed');
    report.codex_version = String(version.stdout ?? '').trim().slice(0, 90);
    if (!/^codex-cli [0-9]/.test(report.codex_version)) failure('unrecognized Codex CLI version');
    if (flags.mode === 'run') {
      const help = invoke(flags.codex, ['exec', '--help'], process.cwd(), 15_000);
      if (help.status !== 0 || !String(help.stdout).includes('--approve-for-me')) {
        failure('installed Codex CLI lacks supported --approve-for-me review mode');
      }
    }
    if (flags.expectedAgentHash && report.agent_sha256 !== flags.expectedAgentHash.toLowerCase()) {
      failure('installed agent digest differs from explicitly expected SHA-256');
    }
    // All temporary files are owned by this single invocation.
    root = testRoot();
    const allow = path.join(root, 'allowed');
    const control = path.join(root, 'control');
    const state = path.join(control, 'state');
    fs.mkdirSync(allow); fs.mkdirSync(control); fs.mkdirSync(state);
    const principalFile = path.join(control, 'principal.json');
    fs.writeFileSync(principalFile, JSON.stringify(principal(flags.device, allow)));
    const inventory = codexInventory(flags.codex, [], allow);
    const { flags: disabled, transportCounts, existingCount } = disabledMcpOverrides(inventory, flags.node);
    report.original_mcp_count = existingCount;
    report.original_transport_counts = transportCounts;
    const trial = buildTrialOverride({
      node: flags.node, adapter: flags.adapter, tetherd: flags.tetherd,
      allow, state, principal: principalFile,
    });
    const overrides = [...disabled, '-c', trial];
    requireIsolatedServer(codexInventory(flags.codex, overrides, allow));
    report.only_test_mcp_active = true;

    if (flags.mode === 'preflight') {
      report.status = 'PREVIEW_ONLY_NOT_MODEL_ACCEPTANCE';
      report.model_client_success = false;
    } else {
      const marker = 'TETHERPLANE_PHASE1_' + crypto.randomBytes(12).toString('hex');
      const fixture = path.join(allow, 'fixture.txt');
      fs.writeFileSync(fixture, marker + '\n');
      const outside = path.join(control, 'absent-outside-root.txt');
      const result = invoke(flags.codex, [
        'exec', '--approve-for-me', '--ephemeral', '--skip-git-repo-check',
        '--json', '-C', allow, ...overrides,
        modelPrompt(flags.device, fixture, outside),
      ], allow, flags.timeoutSec * 1_000);
      report.codex_exit_code = result.status;
      report.codex_timeout = result.error?.code === 'ETIMEDOUT';
      const events = parseJsonl(result.stdout);
      report.event_count = events.length;
      report.calls = summarizeCodexEvents(events, marker);
      report.model_client_success = result.status === 0 && report.calls.passed;
      report.status = report.model_client_success ? 'FUNCTIONAL_CLIENT_ACCEPTANCE' : 'NO_GO_CLIENT_ACCEPTANCE';
      if (result.status !== 0) {
        report.error_summary = sanitize(result.stderr || result.error?.message || 'codex exited nonzero');
      }
    }
  } catch (error) {
    report.status = 'NO_GO_SETUP';
    report.error_summary = sanitize(error instanceof Error ? error.message : String(error));
  } finally {
    report.duration_seconds = Number(((Date.now() - begin) / 1000).toFixed(1));
    report.original_codex_config_unchanged = digestFile(savedConfig) === previousConfig;
    try {
      if (root) fs.rmSync(root, { recursive: true, force: true });
      report.test_owned_directory_removed = !root || !fs.existsSync(root);
    } catch (error) {
      report.test_owned_directory_removed = false;
      report.cleanup_error = sanitize(error instanceof Error ? error.message : String(error));
    }
    if (!report.original_codex_config_unchanged || !report.test_owned_directory_removed) {
      report.model_client_success = false;
      report.status = 'NO_GO_PRESERVATION';
    }
  }
  if (flags.evidenceOut) {
    const target = path.resolve(flags.evidenceOut);
    if (!fs.existsSync(path.dirname(target)) || fs.existsSync(target)) {
      failure('evidence-out parent must exist and destination must not already exist');
    }
    fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return report;
}

const inputIsCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (inputIsCli) {
  try {
    const flags = parseFlags(process.argv.slice(2));
    const report = runAcceptance(flags);
    process.stdout.write('PHASE1_CODEX_RESULT=' + JSON.stringify(report) + '\n');
    if (report.status === 'NO_GO_SETUP' || report.status === 'NO_GO_CLIENT_ACCEPTANCE' ||
        report.status === 'NO_GO_PRESERVATION') process.exitCode = 1;
  } catch (error) {
    process.stderr.write('PHASE1_CODEX_NO_GO: ' + sanitize(error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 2;
  }
}
