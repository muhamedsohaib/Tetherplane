#!/usr/bin/env node
// Validate Phase 1 receipt structure and attached evidence hashes, not claims of real-world success.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const baseGates = [
  'source_artifact_integrity',
  'clean_device_install',
  'exact_six_tool_discovery',
  'real_client_device_status',
  'authorized_local_read',
  'outside_root_permission_denied',
  'restart_reconnect_without_replay',
  'uninstall_rollback_state_preserved',
  'independent_security_acceptance',
];
const windowsGates = ['signed_binary_trust', 'background_human_coexistence'];
const sha40 = /^[0-9a-f]{40}$/i;
const sha64 = /^[0-9a-f]{64}$/i;
const clients = new Set(['opencode', 'claude-code', 'codex']);
const platforms = new Set(['windows', 'linux']);

function fail(reason) { throw new Error(`PHASE1_NO_GO: ${reason}`); }
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function strictKeys(object, keys, field) {
  if (!record(object)) fail(`${field} must be an object`);
  const actual = Object.keys(object).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) {
    fail(`${field} fields differ from contract`);
  }
}
function safeString(value, field, length = 120) {
  if (typeof value !== 'string' || !value || value.length > length || /[\r\n\0]/.test(value)) {
    fail(`${field} is missing, oversized or unsafe`);
  }
}
function regularFile(file, field) {
  let stat;
  try { stat = lstatSync(file); } catch { fail(`${field} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${field} is not a regular file`);
  if (stat.size > 1024 * 1024) fail(`${field} exceeds the 1 MiB evidence limit`);
  return readFileSync(file);
}

export function checkReceipt(receiptPath) {
  if (typeof receiptPath !== 'string' || !isAbsolute(receiptPath)) {
    fail('receipt path must be absolute');
  }
  const root = dirname(resolve(receiptPath));
  const raw = regularFile(receiptPath, 'receipt');
  let receipt;
  try { receipt = JSON.parse(raw.toString('utf8')); } catch { fail('receipt JSON invalid'); }
  strictKeys(receipt, ['schema','source_commit','artifact_sha256','client','device',
    'observed_at_utc','setup_seconds','operator','reviewer','gates'], 'receipt');
  if (receipt.schema !== 'tetherplane.phase1.acceptance.v1') fail('schema version mismatch');
  if (!sha40.test(receipt.source_commit)) fail('source commit must be SHA-1 hex');
  if (!sha64.test(receipt.artifact_sha256)) fail('artifact digest must be SHA-256 hex');
  strictKeys(receipt.client, ['name','version','transport'], 'client');
  if (!clients.has(receipt.client.name) || receipt.client.transport !== 'stdio') fail('unsupported client or transport');
  safeString(receipt.client.version, 'client version');
  strictKeys(receipt.device, ['id','os','arch','agent_version'], 'device');
  if (!platforms.has(receipt.device.os) || receipt.device.arch !== 'x64') fail('unsupported platform');
  safeString(receipt.device.id, 'device id');
  safeString(receipt.device.agent_version, 'agent version');
  safeString(receipt.operator, 'operator');
  safeString(receipt.reviewer, 'reviewer');
  if (receipt.operator === receipt.reviewer) fail('independent reviewer must differ from operator');
  if (!Number.isInteger(receipt.setup_seconds) || receipt.setup_seconds < 0 ||
      receipt.setup_seconds > 300) fail('setup exceeded five-minute target or was not measured');
  if (typeof receipt.observed_at_utc !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(receipt.observed_at_utc) ||
      !Number.isFinite(Date.parse(receipt.observed_at_utc))) fail('UTC observation timestamp invalid');

  const gates = receipt.device.os === 'windows' ? [...baseGates, ...windowsGates] : baseGates;
  strictKeys(receipt.gates, gates, 'gates');
  const evidenceRoot = resolve(root, 'evidence');
  let evidenceStat;
  try { evidenceStat = lstatSync(evidenceRoot); } catch { fail('evidence directory missing'); }
  if (evidenceStat.isSymbolicLink() || !evidenceStat.isDirectory()) {
    fail('evidence directory must be a real directory');
  }
  const seenEvidence = new Set();
  for (const gate of gates) {
    const entry = receipt.gates[gate];
    strictKeys(entry, ['status', 'evidence_path', 'sha256'], `gate ${gate}`);
    if (entry.status !== 'pass') fail(`${gate} has not passed`);
    if (!sha64.test(entry.sha256)) fail(`${gate} evidence digest invalid`);
    if (typeof entry.evidence_path !== 'string' ||
      !/^evidence\/[a-zA-Z0-9][a-zA-Z0-9._/-]{0,180}$/.test(entry.evidence_path) ||
      entry.evidence_path.split('/').some(part => part === '' || part === '.' || part === '..')) {
      fail(`${gate} evidence path must be a bounded, safe relative path under evidence/`);
    }
    if (seenEvidence.has(entry.evidence_path)) fail(`${gate} reuses another gate's evidence path`);
    seenEvidence.add(entry.evidence_path);
    const fullPath = resolve(root, ...entry.evidence_path.split('/'));
    if (!fullPath.startsWith(evidenceRoot + sep)) fail(`${gate} evidence escapes root`);
    // Reject symlinked intermediate directories as well as symlinked evidence files.
    let current = evidenceRoot;
    const relativeParts = entry.evidence_path.split('/').slice(1);
    for (const part of relativeParts.slice(0, -1)) {
      current = resolve(current, part);
      let directoryStat;
      try { directoryStat = lstatSync(current); } catch { fail(`${gate} evidence parent missing`); }
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        fail(`${gate} evidence parent is not a real directory`);
      }
    }
    const bytes = regularFile(fullPath, `${gate} evidence`);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== entry.sha256.toLowerCase()) fail(`${gate} evidence changed`);
  }
  return {
    status: 'PHASE1_EVIDENCE_FORMAT_VALID_UNVERIFIED',
    client: receipt.client.name,
    platform: receipt.device.os,
    checked_gate_count: gates.length,
    publication_authorized: false,
    note: 'Receipt format and evidence hashes checked, but assertions, source provenance, installed artifact digest and real-client operation are NOT independently verified.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) fail('usage: node scripts/release/check-phase1-evidence.mjs /absolute/path/receipt.json');
    console.log(JSON.stringify(checkReceipt(process.argv[2]), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
