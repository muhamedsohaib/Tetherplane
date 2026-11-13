#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(root,p), 'utf8');
const json = (p) => JSON.parse(read(p));
const errors = [];
const assert = (ok, msg) => { if (!ok) errors.push(msg); };
const catalog = json('distribution/catalog.json');
const claude = json('.claude-plugin/plugin.json');
const gemini = json('gemini-extension.json');
const skill = read('skills/tetherplane/SKILL.md');
const meta = read('skills/tetherplane/agents/openai.yaml');
const docs = read('docs/distribution/README.md');
const queue = read('docs/distribution/MARKETPLACES.md');
const expectedTools = ['device','files','process','browser','desktop','batch'];
assert(catalog.schemaVersion === 1, 'catalog schemaVersion');
assert(catalog.product.license === 'MIT OR Apache-2.0','catalog license');
assert(JSON.stringify(catalog.product.tools) === JSON.stringify(expectedTools),'exactly six ordered compact tools');
assert(catalog.release.generalAvailability === false, 'release must stay blocked');
assert(catalog.release.channel === 'review-only','release channel');
assert(catalog.release.sourceCommit === '13609814029aad7f6db4889cab019ae18ccf535d','exact source SHA');
assert(skill.startsWith('---\nname: tetherplane\ndescription:'),'Skill YAML frontmatter');
assert(skill.includes('background_only') && skill.includes('permission_denied') && skill.includes('browser'),'Skill safety and tool semantics');
assert(meta.includes('display_name: "Tetherplane"'),'Skill UI metadata');
assert(claude.name === 'tetherplane' && claude.repository === catalog.product.repository,'Claude identity matches');
assert(gemini.name === 'tetherplane' && gemini.contextFileName === 'GEMINI.md','Gemini identity + context');
assert(!('mcpServers' in gemini),'Gemini may not advertise unconfigured MCP');
assert(!('mcpServers' in claude),'Claude may not advertise unconfigured MCP');
assert(!fs.existsSync(path.join(root,'server.json')), 'Do not publish an unsupported registry manifest');
assert(!/https:\/\/[^\s"'<>]*\.example\.com/.test(Object.values(catalog.links).join(' ')), 'no fake endpoints');
assert(docs.includes('unsigned') && docs.includes('independent'), 'honest release gate');
assert(queue.includes('Agent C') && queue.includes('NOT SUITABLE'), 'no Agent C duplicate');
for (const [key,url] of Object.entries(catalog.links)) {
  assert(/^https:\/\//.test(url), `catalog URL must use https: ${key}`);
}
if(errors.length){console.error(errors.map(e=> 'FAIL '+e).join('\n'));process.exit(1)}
console.log('PASS 17 distribution consistency and fail-closed guardrail checks (not official registry conformance or live installation)');
