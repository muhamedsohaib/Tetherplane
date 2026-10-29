// Local checks verify downloaded hashes; gh attestation verify authenticates the signature.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [root, source, ref, runId, runAttempt, signedResultPath, ...extra] = process.argv.slice(2);
const reject = (reason) => { throw new Error('QUARANTINE_EVIDENCE_NO_GO: ' + reason); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

try {
  if (extra.length || !root || !/^[0-9a-f]{40}$/.test(source ?? '') ||
      ref !== 'refs/heads/test/windows-provenance-quarantine-20261030' ||
      !/^\d+$/.test(runId ?? '') || !/^\d+$/.test(runAttempt ?? '')) reject('invalid expected source/ref/run');
  const archive = `tetherplane-windows-x64-unsigned-${source}.zip`;
  const expected = [archive, 'candidate-inventory.json', 'build-evidence.json'].sort();
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify(expected)) reject('unexpected evidence contents');
  const record = JSON.parse(readFileSync(join(root, 'build-evidence.json'), 'utf8'));
  const fields = {
    schema: 'tetherplane.windows-unsigned-quarantine.v1',
    source_commit: source, source_ref: ref,
    workflow: '.github/workflows/windows-candidate-provenance.yml',
    run_id: runId, run_attempt: runAttempt, archive,
    inventory: 'candidate-inventory.json', release: 'NO_GO',
    windows_code_signature: 'NOT_SIGNED', windows_acceptance: 'NOT_RUN',
    build_attestation: 'PENDING_INDEPENDENT_VERIFICATION',
  };
  for (const [key, value] of Object.entries(fields)) if (record[key] !== value) reject('invalid ' + key);
  if (!/^[0-9a-f]{64}$/.test(record.archive_sha256 ?? '') || !/^[0-9a-f]{64}$/.test(record.inventory_sha256 ?? '')) reject('invalid digest format');
  if (sha256(readFileSync(join(root, archive))) !== record.archive_sha256) reject('archive hash mismatch');
  const inventory = readFileSync(join(root, 'candidate-inventory.json'));
  if (sha256(inventory) !== record.inventory_sha256) reject('inventory hash mismatch');
  const inv = JSON.parse(inventory.toString('utf8'));
  if (inv.schema !== 'tetherplane.windows-candidate-digests.v1' || inv.source_commit !== source ||
      inv.build_provenance !== 'UNVERIFIED' || inv.authenticode !== 'UNVERIFIED' ||
      inv.windows_acceptance !== 'NOT_RUN' || inv.release !== 'NO_GO') reject('unsupported inventory claim');
  if (!signedResultPath) {
    process.stdout.write('QUARANTINE_DOWNLOADED_HASHES_MATCH_UNATTESTED_NO_GO\n');
  } else {
    const results = JSON.parse(readFileSync(signedResultPath, 'utf8'));
    if (!Array.isArray(results) || !results.some((entry) => {
      const statement = entry?.verificationResult?.statement;
      return statement?.predicateType === 'https://slsa.dev/provenance/v1' &&
        Array.isArray(statement.subject) &&
        statement.subject.some((item) => item?.digest?.sha256 === record.archive_sha256);
    })) reject('cryptographically verified attestation subject mismatch');
    process.stdout.write('QUARANTINE_ATTESTED_ARCHIVE_MATCH_NO_GO\n');
  }
} catch (error) {
  process.stderr.write(String(error.message) + '\n');
  process.exitCode = 1;
}
