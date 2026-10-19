import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const pub = new URL('../public/', import.meta.url);
const contents = (path: string) => readFileSync(new URL(path, pub), 'utf8');
const artwork = () => contents('assets/ascii/approved-background.txt');

test('approved source is byte-identical, 400 by 460', () => {
  const original = artwork();
  assert.equal(createHash('sha256').update(original).digest('hex'),
    '62a3ea8172093100422ea4543694441caf93e4368794d9f4104851c07b601e6f');
  const rows = original.trimEnd().split('\n');
  assert.equal(rows.length, 460);
  assert.ok(rows.every(row => row.length === 400));
});

test('one SVG background preserves every ASCII character', () => {
  const rows = artwork().trimEnd().split('\n');
  const svg = contents('assets/ascii/approved-background.svg');
  const renderRows = [...svg.matchAll(/<tspan x="0" dy="1">([+#*]+)<\/tspan>/g)]
    .map(m => m[1]);
  assert.deepEqual(renderRows, rows);
  assert.ok(svg.includes('viewBox="0 0 240 460"'));
  const html = contents('index.html');
  assert.match(html, /<div id="brand-field" class="brand-field" aria-hidden="true"><\/div>/);
  assert.doesNotMatch(html, /brand-pattern|brand-master|loading-base|loading-overlay|pause-motion/);
  const css = contents('style.css');
  assert.match(css, /\.brand-field\{[^}]*approved-background\.svg/);
  assert.match(css, /\.loading-cover\{[^}]*approved-background\.svg/);
});

test('glass treatment replaces opaque cards and old loader', () => {
  const css = contents('style.css');
  assert.match(css, /\.glass-surface/);
  assert.match(css, /backdrop-filter:blur\(/);
  assert.doesNotMatch(css, /\.view-intro\{[^}]*margin:0 0:52px/);
  const js = contents('app.js');
  assert.doesNotMatch(js, /mountAsciiLoader|sampleAsciiCycle|pause-motion/);
  assert.match(js, /mountStaticLoader/);
});
