import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual registered handler without credentials, HTTP, or a database.
// Imports are replaced with inert route dependencies; no other route is invoked.
const source=readFileSync(new URL('../chattanooga_routes.js',import.meta.url),'utf8')
  .replace(/^import .*;\r?\n/gm,'').replace('export function createChattanoogaRouter','function createChattanoogaRouter');
function setup(items,{databaseError,supplierError}={}){
  const handlers=new Map(),queries=[];
  const router=new Proxy({}, {get:(_target,method)=>(path,...handlersForPath)=>{
    if(method==='get')handlers.set(path,handlersForPath.at(-1));
    return router;
  }});
  const pool={query:async(sql,values)=>{
    queries.push({sql,values});
    if(databaseError)throw databaseError;
    if(sql.includes('ANY(')){
      // PostgreSQL expects exactly one parameter containing the entire text array.
      assert.equal(values.length,1);
      assert.ok(Array.isArray(values[0]));
      return {rows:[{supplier_item_id:'ABC123'}]};
    }
    return {rows:[{supplier_item_id:'ABC123'}]};
  }};
  const context=vm.createContext({Router:()=>router,attachChattanoogaReferenceRoutes:()=>{},
    createChattanoogaClient:()=>({getItems:async()=>{if(supplierError)throw supplierError;return {items};}}),
    console:{error:()=>{}}});
  vm.runInContext(source+'\ncreateChattanoogaRouter(pool);',Object.assign(context,{pool}));
  let status=200,body;
  const headers={};
  const res={set:(key,value)=>{headers[key]=value;return res;},status:value=>{status=value;return res;},json:value=>{body=value;return res;}};
  return {run:async()=>{await handlers.get('/reference-format-diagnostics')({},res);return {status,body,headers};},queries};
}
test('multiple IDs bind as one array and diagnostic exposes aggregates only',async()=>{
  const h=setup([{cssi_id:'abc123'},{cssi_id:'DEF456'},{cssi_id:'abc123'}]);
  const result=await h.run();
  assert.equal(result.status,200);
  assert.equal(h.queries.length,2);
  assert.deepEqual(Array.from(h.queries[1].values[0]),['abc123','def456']);
  assert.equal(result.body.case_insensitive_only_matches,1);
  assert.equal(result.headers['Cache-Control'],'no-store');
  assert.doesNotMatch(JSON.stringify(result.body),/ABC123|abc123|DEF456/);
});
test('single ID still binds as an array',async()=>{
  const h=setup([{cssi_id:'abc123'}]);
  assert.equal((await h.run()).status,200);
  assert.deepEqual(Array.from(h.queries[1].values[0]),['abc123']);
});
test('empty supplier sample skips array matching',async()=>{
  const h=setup([]);
  const result=await h.run();
  assert.equal(result.status,200);
  assert.equal(h.queries.length,1);
  assert.equal(result.body.case_insensitive_only_matches,0);
});
test('database failure returns a sanitized error',async()=>{
  const h=setup([{cssi_id:'abc123'}],{databaseError:new Error('private connection string')});
  const result=await h.run();
  assert.equal(result.status,502);
  assert.doesNotMatch(JSON.stringify(result.body),/private connection string/);
});
test('supplier rate limit remains 429 and executes no database query',async()=>{
  const h=setup([],{supplierError:Object.assign(new Error('private credential'),{status:429})});
  const result=await h.run();
  assert.equal(result.status,429);
  assert.equal(h.queries.length,0);
  assert.doesNotMatch(JSON.stringify(result.body),/private credential/);
});
