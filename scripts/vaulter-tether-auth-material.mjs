#!/usr/bin/env node
// Create *local* signing material. Never emit a credential or private JWK field.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);

export function stageMaterial(directory) {
  if (!directory || typeof directory !== 'string') {
    throw new Error('A state directory is required');
  }
  const stateDir = path.resolve(directory);
  if (!statSync(stateDir).isDirectory()) {
    throw new Error('State destination must be a directory');
  }
  const jwksPath = path.join(stateDir, 'tether-auth-jwks.json');
  const bridgePath = path.join(stateDir, 'bridge-token.secret');
  if (existsSync(jwksPath) || existsSync(bridgePath)) {
    throw new Error('Auth material already exists; never replace an existing signer or bridge credential');
  }

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const jwk = privateKey.export({ format: 'jwk' });
  const key = {
    ...jwk,
    kid: randomBytes(18).toString('base64url'),
    alg: 'RS256',
    use: 'sig',
  };
  const bridgeToken = randomBytes(48).toString('base64url');

  // Exclusive creation prevents accidental key rotation and preserves the audit trail.
  // Windows ACLs are applied to the containing directory by the PowerShell launcher.
  writeFileSync(jwksPath, JSON.stringify({ keys: [key] }, null, 2) + '\n', {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
  writeFileSync(bridgePath, bridgeToken + '\n', {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
  return { created: true };
}

function cli(argv) {
  if (argv.length !== 2 || argv[0] !== '--directory' || !argv[1]) {
    throw new Error('Usage: node scripts/vaulter-tether-auth-material.mjs --directory <private-state-directory>');
  }
  stageMaterial(argv[1]);
  process.stdout.write('Key material staged (secret values omitted)\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try { cli(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'Failed to stage key material') + '\n');
    process.exitCode = 1;
  }
}
