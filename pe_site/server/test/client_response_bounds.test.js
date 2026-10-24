import test from 'node:test';
import assert from 'node:assert/strict';
import {createChattanoogaClient,parseRetryAfterSeconds} from '../chattanooga_client.js';
const credentials={sid:'synthetic-sid',token:'synthetic-token'};
const client=fetchImpl=>createChattanoogaClient({...credentials,fetchImpl,requestTimeoutMs:15,maxResponseBytes:64});
test('timeout covers JSON parsing even when parser ignores abort',async()=>{
 const c=client(async()=>({ok:true,status:200,json:()=>new Promise(()=>{})}));
 await assert.rejects(c.getItems({page:1}),e=>e.status===504&&!/synthetic/.test(e.message));
});
test('timeout also covers stalled fetch without abort support',async()=>{
 await assert.rejects(client(()=>new Promise(()=>{})).getItems({page:1}),e=>e.status===504);
});
test('429 with an HTML body retains status and safe cooldown without parsing body',async()=>{
 let parsed=false;
 const c=client(async()=>({ok:false,status:429,headers:new Headers({'Retry-After':'2400'}),json:async()=>{parsed=true;throw Error('secret HTML')}}));
 await assert.rejects(c.getProductFeed({}),e=>e.status===429&&e.retryAfterSeconds===2400&&!/secret/.test(e.message));assert.equal(parsed,false);
});
test('Retry-After accepts seconds/date and rejects malformed/unsafe values',()=>{
 const now=Date.UTC(2026,0,1);assert.equal(parseRetryAfterSeconds('1200',now),1200);
 assert.equal(parseRetryAfterSeconds('Thu, 01 Jan 2026 00:20:00 GMT',now),1200);
 for(const value of ['',null,'secret-value','-5','999999999999999999999'])assert.equal(parseRetryAfterSeconds(value,now),undefined);
});
test('streamed oversized JSON is bounded and cancelled',async()=>{
 let cancelled=false;
 const c=client(async()=>({ok:true,status:200,json:async()=>({}),body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('x'.repeat(65)));},cancel(){cancelled=true;}})}));
 await assert.rejects(c.getItems({}),e=>e.status===502&&/safety limit/.test(e.message));assert.equal(cancelled,true);
});
test('valid streamed JSON works and malformed JSON stays sanitized',async()=>{
 for(const [raw,valid] of [['{"items":[]}',true],['secret malformed',false]]){
 const c=client(async()=>({ok:true,status:200,json:async()=>({}),body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(raw));controller.close();}})}));
 if(valid)assert.deepEqual(await c.getItems({}),{items:[]});else await assert.rejects(c.getItems({}),e=>e.status===502&&!/secret/.test(e.message));
 }
});
test('unauthorized non-JSON response is preserved without leaking body',async()=>{
 await assert.rejects(client(async()=>({ok:false,status:401,json:async()=>{throw Error('secret')}})).getItems({}),e=>e.status===401&&!/secret/.test(e.message));
});
