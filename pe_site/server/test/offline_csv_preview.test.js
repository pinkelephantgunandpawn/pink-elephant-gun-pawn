import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseCsvSample,previewCsvSample,inspectImageUrl,CSV_SAMPLE_LIMITS} from '../offline_csv_preview.js';
const bytes=s=>new TextEncoder().encode(s);
const options={idColumn:'Item',imageColumns:['Image']};
const preview=(s,extra={})=>previewCsvSample(bytes(s),{...options,...extra});

test('strict CSV supports BOM, CRLF, quoted commas, escaped quotes and multiline fields',()=>{
 const p=parseCsvSample(bytes('\uFEFFItem,Image,Notes\r\n001,https://images.example.com/a.jpg,"one, two"\r\n002,,"a ""quote""\nand newline"\r\n'));
 assert.deepEqual(p.headers,['Item','Image','Notes']);assert.equal(p.rows[0][0],'001');assert.equal(p.rows[1][2],'a "quote"\nand newline');
});
test('malformed CSV quoting is rejected rather than silently accepted',()=>{
 for(const s of ['Item,Image\n1,"unfinished','Item,Image\n1,un"quoted','Item,Image\n1,"done"junk'])assert.throws(()=>parseCsvSample(bytes(s)),/quote_syntax/);
});
test('duplicate, blank and malformed headers and inconsistent row widths fail closed',()=>{
 for(const s of ['Item,Item\n1,2','Item,\n1,2','"multi\nline",Image\n1,2','Item,Image\n1,2,3'])assert.throws(()=>parseCsvSample(bytes(s)));
});
test('invalid encoding, NUL and oversized input are rejected',()=>{
 assert.throws(()=>parseCsvSample(new Uint8Array([255,254])),/encoding/);
 assert.throws(()=>parseCsvSample(bytes('Item,Image\n1,\0')),/encoding/);
 assert.throws(()=>parseCsvSample(new Uint8Array(CSV_SAMPLE_LIMITS.bytes+1)),/file_limit/);
});
test('sample, column and cell limits bound owner-provided input',()=>{
 assert.throws(()=>parseCsvSample(bytes('Item,Image\n'+'x,\n'.repeat(201))),/row_limit/);
 assert.throws(()=>parseCsvSample(bytes(Array.from({length:201},(_,i)=>'col'+i).join(','))),/column_limit/);
 assert.throws(()=>parseCsvSample(bytes('Item,Image\nx,'+'a'.repeat(65537))),/cell_limit/);
});
test('exact string matching preserves leading zeros and distinguishes case, UPC-like and padded identifiers',()=>{
 const r=preview('Item,Image\n001,\n1,\nAbC,\nabc,\n 001,\n012345678901,\n',{referenceBuffer:bytes('Key\n001\nAbC\n'),referenceIdColumn:'Key'});
 assert.deepEqual(r.sample.map(s=>s.matching),['exact_match','no_exact_match','exact_match','no_exact_match','no_exact_match','no_exact_match']);
});
test('duplicate sample identifiers, missing IDs and ambiguous local references cannot become matches',()=>{
 const r=preview('Item,Image\nx,\nx,\n,\ny,\n',{referenceBuffer:bytes('Key\nx\ny\ny\n'),referenceIdColumn:'Key'});
 assert.deepEqual(r.sample.map(s=>s.matching),['duplicate_sample_id','duplicate_sample_id','missing_id','ambiguous_reference_id']);
});
test('mapping is explicit and missing or invalid selected columns are rejected',()=>{
 for(const o of [{idColumn:'id'}, {imageColumns:['Unknown']},{imageColumns:['Image','Image']},{imageColumns:['Item']},{referenceBuffer:bytes('Other\nx\n'),referenceIdColumn:'Key'}])assert.throws(()=>preview('Item,Image\nx,\n',o));
});
test('multiple selected image columns retain independent statuses without assuming gallery delimiters',()=>{
 const r=preview('Item,Image,Extra\n001,https://images.example.com/1.jpg,\n002,http://images.example.com/a.jpg,https://images.example.com/b.jpg\n',{imageColumns:['Image','Extra']});
 assert.deepEqual(r.sample.map(s=>s.images),[['https_url_present','missing'],['rejected','https_url_present']]);
});
test('HTTPS checks reject insecure schemes, credentials, ports, IP literals, internal names, fragments and controls',()=>{
 for(const s of ['http://images.example.com/a','data:image/png;base64,AAA','file:///tmp/a','javascript:alert(1)','https://user:secret@images.example.com/a','https://images.example.com:444/a','https://127.0.0.1/a','https://[::1]/a','https://localhost/a','https://image.local/a','https://images.example.com/a#secret','https://images.example.com/a\n'])assert.notEqual(inspectImageUrl(s),'https_url_present');
});
test('syntax validation never claims that a URL is accessible or makes a request',()=>{
 const saved=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw Error('Network must not be used');};
 try{const r=preview('Item,Image\n001,https://images.example.com/a.jpg\n');assert.equal(calls,0);assert.equal(r.network_requests,0);assert.match(r.image_accessibility,/Not checked/);assert.equal(r.database_writes,0);}finally{globalThis.fetch=saved;}
});
test('reports exclude raw SKUs, signed image URLs, pricing, descriptions and other cell values',()=>{
 const secret='synthetic-private-signed-value';const report=preview('Item,Image,Cost,Notes\nprivate-sku-987,https://images.example.com/private.jpg?signature='+secret+',73.21,private-description\n');
 const text=JSON.stringify(report);for(const s of [secret,'private-sku','private.jpg','73.21','private-description'])assert.equal(text.includes(s),false);
});
test('CLI uses local files only, performs no source-file mutation and sanitizes failures',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'csv-preview-'));
 try{
  const file=join(dir,'sample.csv'),content='Item,Image\n001,https://images.example.com/a.jpg\n';await writeFile(file,content);
  const script=new URL('../scripts/inspect_csv_sample.mjs',import.meta.url);
  const args=[script.pathname,'--input',file,'--id-column','Item','--image-column','Image'];
  const good=spawnSync(process.execPath,args,{encoding:'utf8',timeout:10000});assert.equal(good.status,0);assert.equal(JSON.parse(good.stdout).records,1);
  const {readFile}=await import('node:fs/promises');assert.equal(await readFile(file,'utf8'),content);
  const bad=spawnSync(process.execPath,[script.pathname,'--input','https://example.com/private?token=synthetic-secret','--id-column','Item','--image-column','Image'],{encoding:'utf8',timeout:10000});assert.equal(bad.status,1);assert.equal(bad.stderr.includes('synthetic-secret'),false);assert.equal(bad.stdout,'');
 }finally{await rm(dir,{recursive:true,force:true});}
});
