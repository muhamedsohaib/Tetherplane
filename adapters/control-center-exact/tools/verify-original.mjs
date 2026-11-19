import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const expected='36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82';
const file=new URL('../public/index.html',import.meta.url);
const actual=createHash('sha256').update(await readFile(file)).digest('hex');
if(actual!==expected)throw new Error('Exact HTML checksum mismatch. Original visual baseline must not be modified.');
console.log(`Exact HTML baseline verified: ${actual}`);
