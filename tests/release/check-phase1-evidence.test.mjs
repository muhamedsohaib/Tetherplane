import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkReceipt } from '../../scripts/release/check-phase1-evidence.mjs';

const base = [
  'source_artifact_integrity','clean_device_install','exact_six_tool_discovery',
  'real_client_device_status','authorized_local_read','outside_root_permission_denied',
  'restart_reconnect_without_replay','uninstall_rollback_state_preserved',
  'independent_security_acceptance',
];
const win = ['signed_binary_trust','background_human_coexistence'];
const hash = content => createHash('sha256').update(content).digest('hex');

function sample(platform = 'linux') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tetherplane-phase1-receipt-'));
  mkdirSync(path.join(root, 'evidence'));
  const gates = Object.fromEntries([...base, ...(platform === 'windows' ? win : [])].map(gate => {
    const content = `SYNTHETIC TEST FIXTURE: ${gate}\n`;
    writeFileSync(path.join(root, 'evidence', `${gate}.txt`), content);
    return [gate, { status: 'pass', evidence_path: `evidence/${gate}.txt`, sha256: hash(content) }];
  }));
  const receipt = {
    schema: 'tetherplane.phase1.acceptance.v1',
    source_commit: 'a'.repeat(40), artifact_sha256: 'b'.repeat(64),
    client: { name: 'opencode', version: 'test-fixture', transport: 'stdio' },
    device: { id: 'TEST_DEVICE', os: platform, arch: 'x64', agent_version: 'test-fixture' },
    observed_at_utc: '2026-10-20T10:00:00Z', setup_seconds: 240,
    operator: 'fixture-operator', reviewer: 'fixture-independent-reviewer', gates,
  };
  const file = path.join(root, 'receipt.json');
  const save = () => writeFileSync(file, JSON.stringify(receipt, null, 2));
  save();
  return { root, file, receipt, save, cleanup: () => rmSync(root, {recursive:true, force:true}) };
}

for (const platform of ['linux', 'windows']) {
  test(`synthetic ${platform} receipt contract verifies referenced hashes without authorizing release`, () => {
    const f = sample(platform);
    try {
      const output = checkReceipt(f.file);
      assert.equal(output.publication_authorized, false);
      assert.equal(output.status, 'PHASE1_EVIDENCE_FORMAT_VALID_UNVERIFIED');
      assert.equal(output.checked_gate_count, platform === 'windows' ? 11 : 9);
    } finally { f.cleanup(); }
  });
}

test('pending security review fails closed', () => {
  const f = sample();
  try {
    f.receipt.gates.independent_security_acceptance.status = 'pending'; f.save();
    assert.throws(() => checkReceipt(f.file), /has not passed/);
  } finally { f.cleanup(); }
});

test('missing real client evidence fails closed', () => {
  const f = sample();
  try {
    delete f.receipt.gates.real_client_device_status; f.save();
    assert.throws(() => checkReceipt(f.file), /gates fields differ/);
  } finally { f.cleanup(); }
});

test('tampered evidence fails closed', () => {
  const f = sample();
  try {
    writeFileSync(path.join(f.root, 'evidence','clean_device_install.txt'), 'CHANGED');
    assert.throws(() => checkReceipt(f.file), /evidence changed/);
  } finally { f.cleanup(); }
});

test('path traversal evidence fails closed', () => {
  const f = sample();
  try {
    f.receipt.gates.clean_device_install.evidence_path = 'evidence/../escape'; f.save();
    assert.throws(() => checkReceipt(f.file), /evidence path/);
  } finally { f.cleanup(); }
});

test('symlink evidence fails closed', { skip: process.platform === 'win32' }, () => {
  const f = sample();
  try {
    const link = path.join(f.root, 'evidence', 'link.txt');
    symlinkSync(path.join(f.root,'evidence','clean_device_install.txt'), link);
    f.receipt.gates.clean_device_install.evidence_path = 'evidence/link.txt'; f.save();
    assert.throws(() => checkReceipt(f.file), /not a regular file/);
  } finally { f.cleanup(); }
});

test('symlinked evidence directory fails closed', { skip: process.platform === 'win32' }, () => {
  const f = sample();
  const sibling = mkdtempSync(path.join(os.tmpdir(), 'tetherplane-phase1-external-'));
  try {
    rmSync(path.join(f.root, 'evidence'), { recursive: true, force: true });
    symlinkSync(sibling, path.join(f.root, 'evidence'), 'dir');
    assert.throws(() => checkReceipt(f.file), /evidence directory must be a real directory/);
  } finally { f.cleanup(); rmSync(sibling, { recursive: true, force: true }); }
});

test('same reviewer and operator fails closed', () => {
  const f = sample();
  try {
    f.receipt.reviewer = f.receipt.operator; f.save();
    assert.throws(() => checkReceipt(f.file), /independent reviewer/);
  } finally { f.cleanup(); }
});

test('over-five-minute setup fails target', () => {
  const f = sample();
  try {
    f.receipt.setup_seconds = 301; f.save();
    assert.throws(() => checkReceipt(f.file), /five-minute target/);
  } finally { f.cleanup(); }
});

test('Windows cannot omit trust gate', () => {
  const f = sample('windows');
  try {
    delete f.receipt.gates.signed_binary_trust; f.save();
    assert.throws(() => checkReceipt(f.file), /gates fields differ/);
  } finally { f.cleanup(); }
});

test('unexpected receipt fields are rejected', () => {
  const f = sample();
  try {
    f.receipt.token = 'should-not-be-collected'; f.save();
    assert.throws(() => checkReceipt(f.file), /receipt fields differ/);
  } finally { f.cleanup(); }
});

test('missing evidence is rejected', () => {
  const f = sample();
  try {
    f.receipt.gates.clean_device_install.evidence_path = 'evidence/missing-file.txt'; f.save();
    assert.throws(() => checkReceipt(f.file), /evidence is missing/);
  } finally { f.cleanup(); }
});

test('duplicate evidence files cannot claim two distinct gates', () => {
  const f = sample();
  try {
    f.receipt.gates.clean_device_install.evidence_path = f.receipt.gates.exact_six_tool_discovery.evidence_path;
    f.receipt.gates.clean_device_install.sha256 = f.receipt.gates.exact_six_tool_discovery.sha256;
    f.save();
    assert.throws(() => checkReceipt(f.file), /reuses another gate/);
  } finally { f.cleanup(); }
});

test('empty evidence path segment is rejected', () => {
  const f = sample();
  try {
    f.receipt.gates.clean_device_install.evidence_path = 'evidence//clean_device_install.txt';
    f.save();
    assert.throws(() => checkReceipt(f.file), /evidence path/);
  } finally { f.cleanup(); }
});

test('missing setup timing is not treated as acceptance', () => {
  const f = sample();
  try {
    f.receipt.setup_seconds = null;
    f.save();
    assert.throws(() => checkReceipt(f.file), /five-minute target/);
  } finally { f.cleanup(); }
});
