#!/usr/bin/env node
// Validate an unapproved Linux package; do not execute bundled code or secrets.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
const fail = message => { throw new Error('Invalid Linux candidate package: ' + message); };
if (process.platform !== 'linux' || process.arch !== 'x64') fail('Linux x64 verifier required');
if (process.argv.length !== 3 || !process.argv[2]) {
  console.error('Usage: node scripts/verify-linux-package.mjs PACKAGE_DIRECTORY');
  process.exit(2);
}
const root = resolve(process.argv[2]);
const requireRegular = path => {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail('required entry not a regular file');
  return info;
};
if (!lstatSync(root).isDirectory()) fail('package root must be a directory');
requireRegular(join(root,'manifest.json'));
const manifest = JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
if (manifest.name !== 'Tetherplane' || manifest.version !== '0.1.0-dev' ||
    manifest.platform !== 'linux' || manifest.architecture !== 'x64' ||
    !/^[0-9a-f]{40}$/i.test(manifest.source_commit ?? '') ||
    manifest.node_runtime_required !== true) fail('manifest identity invalid');
const expectedTools = ['device','files','process','browser','desktop','batch'];
if (JSON.stringify(manifest.default_mcp_tools) !== JSON.stringify(expectedTools)) fail('tool set differs');
const expectedFiles = ['bin/tetherd','adapters/compact-mcp/dist/stdio-server.js',
                       'adapters/compact-mcp/smoke-six-tools.mjs'];
if (!manifest.sha256 || JSON.stringify(Object.keys(manifest.sha256).sort()) !==
    JSON.stringify([...expectedFiles].sort())) fail('incomplete integrity manifest');
for (const relative of expectedFiles) {
  const target = join(root, relative);
  const info = requireRegular(target);
  const checksum = createHash('sha256').update(readFileSync(target)).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256[relative]) ||
      checksum !== manifest.sha256[relative]) fail('digest mismatch: ' + relative);
  if (relative === 'bin/tetherd' && (info.mode & 0o111) === 0) fail('agent is not executable');
}
if (!existsSync(join(root,'adapters/compact-mcp/node_modules'))) fail('runtime dependencies missing');
console.log('LINUX_PACKAGE_VERIFY_OK');
