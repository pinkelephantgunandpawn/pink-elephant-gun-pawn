import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../chattanooga_routes.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export function createChattanoogaRouter','function createChattanoogaRouter');
function setup({api429=false,headStatus=200}={}){
 const handlers=new Map();let apiCalls=0,headCalls=0;const logs=[];
 const router=new Proxy({},{get:(_t,method)=>(path,...hs)=>{if(method==='get')handlers.set(path,hs.at(-1));return router;}});
 const context=vm.createContext({Router:()=>router,attachChattanoogaReferenceRoutes:()=>{},createChattanoogaClient:()=>({getProductFeed:async()=>{apiCalls++;if(api429)throw Object.assign(new Error('private-token'),{name:'ChattanoogaApiError',status:429});return {product_feed:{url:'http://api.chattanoogashooting.com/rest/v6/files/customer_feeds/products/synthetic.csv?signature=private-token'}};}}),fetch:async(url,opts)=>{headCalls++;assert.equal(url.protocol,'https:');assert.equal(opts.method,'HEAD');assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,undefined);return {status:headStatus,ok:headStatus===200,headers:{get:()=> 'text/csv'}};},URL,AbortController,setTimeout,clearTimeout,console:{error:(...x)=>logs.push(x)}});
 vm.runInContext(source+'\ncreateChattanoogaRouter({query:()=>{throw Error("Database must not be used")}});',context);
 return {counts:()=>({apiCalls,headCalls}),logs,run:async(path='/product-feed/https-probe')=>{let status=200,body;const headers={};const res={set:(k,v)=>{headers[k]=v;return res},status:s=>{status=s;return res},json:b=>{body=b;return res}};await handlers.get(path)({},res);return {status,body,headers};}};
}
test('supplier API 429 prevents HEAD and suppresses repeated probe requests',async()=>{const h=setup({api429:true});const a=await h.run();const b=await h.run();assert.equal(a.status,429);assert.equal(b.status,429);assert.equal(a.headers['Retry-After'],'1800');assert.deepEqual(h.counts(),{apiCalls:1,headCalls:0});assert.doesNotMatch(JSON.stringify([a,b,h.logs]),/private-token|signature=/);});
test('HTTPS HEAD 429 propagates rate limit and suppresses another feed request',async()=>{const h=setup({headStatus:429});assert.equal((await h.run()).status,429);assert.equal((await h.run()).status,429);assert.deepEqual(h.counts(),{apiCalls:1,headCalls:1});});
test('probe cooldown also protects existing feed inspection',async()=>{const h=setup({api429:true});await h.run();assert.equal((await h.run('/product-feed/diagnostics')).status,429);assert.equal(h.counts().apiCalls,1);});
test('existing inspection cooldown also protects HTTPS probe',async()=>{const h=setup({api429:true});await h.run('/product-feed/diagnostics');await h.run();assert.equal(h.counts().apiCalls,1);});
test('successful HEAD stays bounded and does not disclose signed location',async()=>{const h=setup();const r=await h.run();assert.equal(r.status,200);assert.equal(r.body.https_head_status,200);assert.equal(r.body.read_only,true);assert.equal(r.headers['Cache-Control'],'no-store');assert.doesNotMatch(JSON.stringify(r),/private-token|signature=|synthetic.csv/);assert.deepEqual(h.counts(),{apiCalls:1,headCalls:1});});
