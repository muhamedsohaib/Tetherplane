import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const source = 'a'.repeat(40);
const helper = resolve('scripts/release/github_candidate.py');
function run(...args) { return spawnSync('python', [helper, ...args], { encoding: 'utf8' }); }
function fixture(root, lane) {
  const stage = join(root, lane + '-stage');
  const out = join(root, lane);
  mkdirSync(join(stage, 'bin'), { recursive: true });
  writeFileSync(join(stage, 'bin/tetherd.exe'), 'inert CLI fixture');
  writeFileSync(join(stage, 'bin/tetherd-agentw.exe'), 'inert GUI fixture');
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ source_commit: source, platform: 'windows', architecture: 'x64' }));
  const inputs = join(root, lane + '-inputs.json');
  writeFileSync(inputs, JSON.stringify({ source_commit: source, rustc: 'fixed-test-compiler', image: 'fixed-test-image' }));
  return { stage, out, inputs };
}
function record(f) { return run('record', f.stage, source, f.out, f.inputs); }
function success(result) { assert.equal(result.status, 0, result.stderr + result.stdout); }

test('two independent payloads produce identical archive bytes despite file mtimes and paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-github-candidate-'));
  try {
    const a = fixture(root, 'first'), b = fixture(root, 'second');
    success(record(a)); success(record(b));
    assert.deepEqual(readFileSync(join(a.out, `tetherplane-windows-x64-unsigned-${source}.zip`)),
      readFileSync(join(b.out, `tetherplane-windows-x64-unsigned-${source}.zip`)));
    success(run('verify', a.out, source));
    const compared = run('compare', a.out, b.out, source);
    success(compared);
    assert.match(compared.stdout, /REPRODUCIBLE_UNSIGNED_PAYLOADS_MATCH_NO_GO/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reject tampered bytes, missing checksums, wrong source and different rebuilt payload', () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-github-candidate-'));
  try {
    const a = fixture(root, 'first'), b = fixture(root, 'second');
    writeFileSync(join(b.stage, 'bin/tetherd.exe'), 'different compiled output');
    success(record(a)); success(record(b));
    const mismatch = run('compare', a.out, b.out, source);
    assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /rebuild mismatch/);
    assert.notEqual(run('verify', a.out, 'b'.repeat(40)).status, 0);
    writeFileSync(join(a.out, 'candidate-inventory.json'), '{}');
    const tampered = run('verify', a.out, source);
    assert.notEqual(tampered.status, 0); assert.match(tampered.stderr, /checksum mismatch/);
    rmSync(join(b.out, 'SHA256SUMS'));
    assert.notEqual(run('verify', b.out, source).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a verified-attestation result must bind archive digest AND the exact run attempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-github-candidate-'));
  try {
    const a = fixture(root, 'first'); success(record(a));
    const sums = readFileSync(join(a.out, 'SHA256SUMS'), 'utf8');
    const archiveHash = sums.split('\n').find(s => s.includes('.zip')).split(' ')[0];
    const signed = join(root, 'gh-verified.json');
    const result = [{ verificationResult: { statement: {
      predicateType: 'https://slsa.dev/provenance/v1', subject: [{ digest: { sha256: archiveHash } }],
      predicate: { runDetails: { metadata: { invocationId: 'https://github.com/muhamedsohaib/Tetherplane/actions/runs/123/attempts/1' } } }
    } } }];
    writeFileSync(signed, JSON.stringify(result));
    const verified = run('attested', a.out, source, signed, '123', '1');
    success(verified); assert.match(verified.stdout, /ATTESTED_ARCHIVE_RUN_MATCH_NO_GO/);
    assert.notEqual(run('attested', a.out, source, signed, '123', '2').status, 0);
    result[0].verificationResult.statement.subject[0].digest.sha256 = '0'.repeat(64);
    writeFileSync(signed, JSON.stringify(result));
    assert.notEqual(run('attested', a.out, source, signed, '123', '1').status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('archive verification rejects recomputed-checksum ZIPs with extra/traversal members', () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-github-candidate-'));
  try {
    const a = fixture(root, 'first'); success(record(a));
    const archive = join(a.out, `tetherplane-windows-x64-unsigned-${source}.zip`);
    const changed = spawnSync('python', ['-c',
      'import sys,zipfile,hashlib,pathlib; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(p,"a"); z.writestr("../escape.exe",b"bad"); z.close(); d=p.parent; (d/"SHA256SUMS").write_bytes("".join(hashlib.sha256(f.read_bytes()).hexdigest()+"  "+f.name+"\\n" for f in sorted(d.iterdir()) if f.name!="SHA256SUMS").encode())', archive], { encoding: 'utf8' });
    success(changed);
    const checked = run('verify', a.out, source);
    assert.notEqual(checked.status, 0); assert.match(checked.stderr, /archive members/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
