import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import multer from 'multer';
import {gzipSync} from 'node:zlib';
import {once} from 'node:events';
async function fixture(t){
 const app=express();app.use(express.json({limit:'1kb'}));app.get('/health',(_q,r)=>r.json({ok:true}));app.post('/json',(q,r)=>r.json(q.body));
 app.post('/upload',multer({storage:multer.memoryStorage(),limits:{fileSize:32,files:1}}).single('file'),(q,r)=>r.json({bytes:q.file?.size}));
 app.use((e,_q,r,_next)=>r.status(e.code==='LIMIT_FILE_SIZE'?413:400).json({error:'Invalid request'}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});return 'http://127.0.0.1:'+server.address().port;
}
test('patched parser preserves valid compressed JSON behavior',async t=>{const base=await fixture(t);const r=await fetch(base+'/json',{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:gzipSync('{"fixture":true}')});assert.equal(r.status,200);assert.deepEqual(await r.json(),{fixture:true});});
test('compressed body with trailing bytes does not terminate the isolated server',async t=>{const base=await fixture(t);const r=await fetch(base+'/json',{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:Buffer.concat([gzipSync('{"fixture":true}'),Buffer.from('trailing-synthetic-bytes')])});assert.ok([200,400].includes(r.status));await r.text();const health=await fetch(base+'/health');assert.equal(health.status,200);});
test('patched multipart parser preserves successful uploads and file-size rejection',async t=>{const base=await fixture(t);for(const [size,status] of [[8,200],[64,413]]){const form=new FormData();form.set('file',new Blob(['x'.repeat(size)]),'synthetic.txt');const r=await fetch(base+'/upload',{method:'POST',body:form});assert.equal(r.status,status);const body=await r.json();if(status===200)assert.equal(body.bytes,size);else assert.deepEqual(body,{error:'Invalid request'});}});
