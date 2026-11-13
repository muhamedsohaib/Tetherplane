#!/usr/bin/env node
/**
 * Head-only metadata patch for the original Tetherplane Netlify index.html.
 * REVIEW ONLY: does not deploy, rebuild or modify source in place.
 * Refuses HTML whose SEO baseline differs from the inspected November 13 version.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [input, output] = process.argv.slice(2);
function die(message) { console.error('STOP: ' + message); process.exit(1); }
if (!input || !output) die('Usage: node website/netlify/seo/patch-head.mjs ORIGINAL_INDEX.html NEW_INDEX.html');
const src=path.resolve(input),dst=path.resolve(output);
if(src===dst)die('Refusing in-place edit');
if(fs.existsSync(dst))die('Refusing to overwrite existing output');
if(!fs.existsSync(src))die('Source not found');
const before=fs.readFileSync(src,'utf8');
const oldTitle='tetherplane by ARCUS Labs — Permission-Controlled AI Computer Operations & Assisted Windows Pilot';
const newTitle='Tetherplane — Open-Source MCP Computer Control | ARCUS Labs';
const oldDescription='Put AI to work on your PC on your terms. tetherplane is an open-source MCP control plane for permission-scoped computer operations. Request an ARCUS Labs assisted Windows pilot (Proposed X).';
const newDescription='Tetherplane connects AI agents to authorized Windows computers through MCP. Explore files, browser and desktop operations or request an assisted setup pilot.';
function replaceOnce(text, from, to, label) {
  if (text.split(from).length !== 2) die(label+' missing or duplicated; source drift needs review');
  return text.replace(from,to);
}
if(!before.includes('<head>')||!before.includes('</head>')||!before.includes('<body'))die('Unexpected document structure');
if(before.includes('data-netlify-site-id=') && before.includes('/.netlify/scripts/hud'))die('This is an injected CDN response, not the original source HTML. Recover the original deploy source.');
if(before.includes('application/ld+json'))die('Existing schema must be reviewed before inserting structured data');
if(!before.includes('<meta name="robots" content="index, follow" />'))die('Indexing directive changed');
if(!before.includes('<link rel="canonical" href="https://tetherplane.netlify.app/" />'))die('Canonical changed');
const jsonld={
 '@context':'https://schema.org',
 '@graph':[
  {'@type':'WebSite',name:'Tetherplane',url:'https://tetherplane.netlify.app/',description:'Open-source MCP control plane for authorized AI computer operations.'},
  {'@type':'SoftwareSourceCode',name:'Tetherplane',url:'https://tetherplane.netlify.app/',codeRepository:'https://github.com/muhamedsohaib/Tetherplane',description:'Open-source, self-hostable Model Context Protocol control plane for authorized computer workflows.',programmingLanguage:['Rust','TypeScript'],license:['https://github.com/muhamedsohaib/Tetherplane/blob/main/LICENSE-MIT','https://github.com/muhamedsohaib/Tetherplane/blob/main/LICENSE-APACHE']}
 ]};
let after=replaceOnce(before,'<title>'+oldTitle+'</title>','<title>'+newTitle+'</title>','title');
after=replaceOnce(after,'<meta name="description" content="'+oldDescription+'" />','<meta name="description" content="'+newDescription+'" />','meta description');
after=replaceOnce(after,'</head>','  <script type="application/ld+json">\n'+JSON.stringify(jsonld,null,2)+'\n  </script>\n</head>','head closing tag');
const getBody=(s)=>s.slice(s.indexOf('</head>')+'</head>'.length);
if(getBody(before)!==getBody(after))die('HTML body changed: refusing to write');
if((after.match(/<title\b/gi)||[]).length!==1)die('Title count not exactly one');
if((after.match(/<meta name="description"/gi)||[]).length!==1)die('Description count not exactly one');
fs.mkdirSync(path.dirname(dst),{recursive:true});
fs.writeFileSync(dst,after,{flag:'wx'});
const hash=(s)=>crypto.createHash('sha256').update(s).digest('hex');
console.log(JSON.stringify({status:'STAGED_REVIEW_ONLY',sourceSha256:hash(before),outputSha256:hash(after),changedContent:'head-only',bodyByteIdentity:true,title:newTitle,description:newDescription},null,2));
