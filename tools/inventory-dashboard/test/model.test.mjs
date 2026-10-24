import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {demoItems,selectItems,qualityWarnings,imageSource,decodeSample,validateMapped} from '../model.mjs';
const bytes=s=>new TextEncoder().encode(s);
test('search combines with category and availability filters without mutating source records',()=>{
 const original=JSON.stringify(demoItems);const r=selectItems(demoItems,{query:'HEADPHONES',category:'Music',stock:'in'});assert.equal(r.total,1);assert.equal(r.items[0].name,'Recording headphones');assert.equal(JSON.stringify(demoItems),original);
});
test('pagination clamps to available pages and a search with no matches remains empty',()=>{
 const r=selectItems(demoItems,{page:999,pageSize:8});assert.equal(r.page,3);assert.equal(r.items.length,8);
 const empty=selectItems(demoItems,{query:'not-a-merchandise-record',page:5});assert.equal(empty.total,0);assert.equal(empty.page,1);assert.deepEqual(empty.items,[]);
});
test('numeric sorting is numeric and missing-image filters retain all matching records',()=>{
 const r=selectItems(demoItems,{sort:'quantity',direction:-1,pageSize:24});for(let i=1;i<r.items.length;i++)assert.ok(r.items[i-1].quantity>=r.items[i].quantity);
 assert.equal(selectItems(demoItems,{image:'missing'}).total,5);assert.equal(demoItems.length,24);
});
test('repeated synthetic identifiers produce warnings for both records without merging',()=>{
 const repeated=demoItems.filter(x=>x.sku==='DEMO-011');assert.equal(repeated.length,2);assert.ok(repeated.every(x=>qualityWarnings(x).some(w=>w.includes('repeated'))));
});
test('image source validation rejects credentialed, insecure and unapproved sources',()=>{
 for(const url of ['http://images.unsplash.com/a.jpg','javascript:alert(1)','data:image/svg+xml,test','https://user:password@images.unsplash.com/a.jpg','https://images.unsplash.com:444/a.jpg','https://images.unsplash.com/a#secret','assets/../secret.svg','https://127.0.0.1/a','https://arbitrary.example.com/a'])assert.ok(['invalid','host_review'].includes(imageSource(url).status));
 assert.equal(imageSource('assets/watch.svg').status,'local');assert.equal(imageSource('https://images.unsplash.com/a.jpg').status,'external');assert.equal(imageSource('').status,'missing');
});
test('explicit encoding converts a small Windows-1252 sample in memory and rejects an incorrect encoding',()=>{
 const content=new Uint8Array([...bytes('ID,Name\n001,Example '),0xae,10]);assert.throws(()=>decodeSample(content),/encoding/);assert.equal(decodeSample(content,'windows-1252').rows[0][1],'Example ®');assert.equal(content.at(-2),0xae);
});
test('oversized input and invalid encoding selectors are rejected before parsing',()=>{
 assert.throws(()=>decodeSample(new Uint8Array(1024*1024+1)),/limit/);assert.throws(()=>decodeSample(bytes('A,B\n1,2'),'utf-16'),/supported/);
});
test('mapped validation preserves IDs and rows, and reports duplicate/missing fields',()=>{
 const csv=decodeSample(bytes('ID,Name,Photo\n001,Example A,\n001,Example B,\n,Example C,\n004,,\n'));
 const r=validateMapped(csv,{idColumn:'ID',nameColumn:'Name'});assert.equal(r.records,4);assert.equal(r.repeatedGroups,1);assert.equal(r.missing,2);assert.equal(r.attention,4);assert.equal(r.rows[0].id,'001');assert.equal(csv.rows.length,4);
});
test('invalid column mappings fail and HTML-like cell content stays a string',()=>{
 const csv=decodeSample(bytes('ID,Name\n001,<img src=x onerror=alert(1)>\n'));assert.throws(()=>validateMapped(csv,{idColumn:'ID',nameColumn:'ID'}),/separate/);assert.equal(validateMapped(csv,{idColumn:'ID',nameColumn:'Name'}).rows[0].name,'<img src=x onerror=alert(1)>');
});
test('prototype has no persistence, transaction endpoints or automatic external fetches',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');assert.doesNotMatch(app,/localStorage|sessionStorage|indexedDB|\bfetch\s*\(|XMLHttpRequest|\/api\//);const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');assert.match(html,/connect-src 'none'/);assert.match(html,/form-action 'none'/);assert.doesNotMatch(app,/eval\s*\(|new Function/);
});
