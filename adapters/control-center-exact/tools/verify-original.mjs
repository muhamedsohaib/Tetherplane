import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const expected='4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8';
const file=new URL('../public/index.html',import.meta.url);
const actual=createHash('sha256').update(await readFile(file)).digest('hex');
if(actual!==expected)throw new Error('Exact HTML checksum mismatch. Original visual baseline must not be modified.');
console.log(`Exact HTML baseline verified: ${actual}`);
