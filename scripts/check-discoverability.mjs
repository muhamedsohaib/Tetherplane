#!/usr/bin/env node
// Validate searchable documentation without requiring network access or modifying repository state.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = ['README.md', 'docs/what-is-tetherplane.md', 'docs/discoverability-checklist.md'];
const errors = [];
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const norm = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
const docs = Object.fromEntries(tracked.map(p => [p, read(p)]));
const fail = message => errors.push(message);

if (!/^# Tetherplane\b/.test(docs['README.md'])) fail('README H1 must name Tetherplane');
for (const phrase of ['MCP', 'authorized', 'browser', 'desktop', 'remote']) {
  if (!docs['README.md'].toLowerCase().includes(phrase.toLowerCase())) fail('README missing factual search intent: ' + phrase);
}
if (!/unsigned/i.test(docs['README.md']) || !/clean-device/i.test(docs['README.md'])) fail('README must state independent Windows release gate');
if (!docs['README.md'].includes('docs/what-is-tetherplane.md')) fail('README must link detailed overview');
if (!/PR #135/.test(docs['README.md'])) fail('README must link Windows beta release caveat');
if (!docs['docs/what-is-tetherplane.md'].includes('https://github.com/muhamedsohaib/Tetherplane')) fail('Overview must link canonical source');

let verified = 0;
for (const [file, source] of Object.entries(docs)) {
  for (const match of source.matchAll(/\[[^\]\n]+\]\(([^)]+)\)/g)) {
    const url = match[1].trim();
    if (/^https?:\/\//i.test(url) || url.startsWith('mailto:')) continue;
    const [relative, anchor] = url.split('#', 2);
    const dest = relative ? path.resolve(root, path.dirname(file), decodeURIComponent(relative)) : path.join(root, file);
    if (!fs.existsSync(dest)) { fail(file + ': missing local link ' + url); continue; }
    if (anchor && dest.endsWith('.md')) {
      const targets = fs.readFileSync(dest, 'utf8').split(/\r?\n/).filter(x => /^#{1,6} /.test(x)).map(x => norm(x.replace(/^#+\s+/, '')));
      if (!targets.includes(anchor)) fail(file + ': missing heading #' + anchor);
    }
    verified++;
  }
}
if (errors.length) { for (const e of errors) console.error('FAIL ' + e); process.exit(1); }
console.log('PASS searchable README, honest release status, canonical project link, and ' + verified + ' local documentation links');
