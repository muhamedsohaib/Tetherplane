import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const expected='4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8';
const file=new URL('../public/index.html',import.meta.url);
const actual=createHash('sha256').update(await readFile(file)).digest('hex');
if(actual!==expected)throw new Error('Exact HTML checksum mismatch. Original visual baseline must not be modified.');
console.log(`Exact HTML baseline verified: ${actual}`);
// The owner HTML loads this private binary; CSS fallbacks hide a missing font.
// Verify only in the owner's local runtime. Never commit or redistribute the font.
const expectedFont='18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e';
let font;
try{font=await readFile(new URL('../public/tp-font.woff2',import.meta.url));}
catch{throw new Error('Approved private font missing; source HTML must remain unchanged.');}
const actualFont=createHash('sha256').update(font).digest('hex');
if(actualFont!==expectedFont)throw new Error('Approved private font checksum mismatch.');
console.log(`Private font baseline verified: ${actualFont}`);
