import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareStartup} from '../startup_policy.js';
const schema={users:['id','email','password_hash','role','active'],inventory:['id','quantity','regulated','public_visible','image_url','image_urls','price_cents'],distributor_catalog:['supplier','supplier_item_id','status','review_status'],chattanooga_reference:['supplier_item_id','category']};
const rows=Object.entries(schema).flatMap(([table_name,cs])=>cs.map(column_name=>({table_name,column_name})));
test('read-only startup performs metadata SELECT only and disables image migration',async()=>{let calls=0;const r=await prepareStartup({mode:'read-only',pool:{query:async(sql,params)=>{assert.match(sql,/^SELECT /);assert.doesNotMatch(sql,/INSERT|UPDATE|DELETE|ALTER|CREATE/);assert.ok(Array.isArray(params[0]));calls++;return {rows};}},initializeSchema:()=>{throw Error('Schema write attempted')},bootstrapAdmin:()=>{throw Error('Credential write attempted')}});assert.equal(calls,1);assert.equal(r.allowImageMigration,false);});
test('missing existing schema fails without repairing it',async()=>{await assert.rejects(prepareStartup({mode:'read-only',pool:{query:async()=>({rows:[]})},initializeSchema:()=>{throw Error('No repair permitted')},bootstrapAdmin:()=>{throw Error('No bootstrap permitted')}}),/not ready/);});
test('database failure does not fall back to writable startup',async()=>{await assert.rejects(prepareStartup({mode:'read-only',pool:{query:async()=>{throw Error('offline')}},initializeSchema:()=>{throw Error('No fallback')},bootstrapAdmin:()=>{throw Error('No fallback')}}),/offline/);});
test('normal mode preserves schema/bootstrap order and migration permission',async()=>{const calls=[];const r=await prepareStartup({initializeSchema:async()=>calls.push('schema'),bootstrapAdmin:async()=>calls.push('admin')});assert.deepEqual(calls,['schema','admin']);assert.equal(r.allowImageMigration,true);});
test('misspelled startup mode fails before any operation',async()=>{await assert.rejects(prepareStartup({mode:'readonly',initializeSchema:()=>{throw Error('must not run')}}),/Invalid startup mode/);});
test('actual entrypoint skips every startup writer and deferred image timer',async()=>{
 const {readFileSync}=await import('node:fs');const {default:vm}=await import('node:vm');
 const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
 const entry=source.split('\n').find(line=>line.startsWith('prepareStartup({'));
 assert.ok(entry);let listening=0,queries=0;
 const context=vm.createContext({prepareStartup,process:{env:{PE_STARTUP_MODE:'read-only'},exit:()=>{throw Error('startup exited')}},pool:{query:async()=>{queries++;return {rows};}},ensureSchema:()=>{throw Error('schema called')},ensureBootstrapAdmin:()=>{throw Error('bootstrap called')},port:10000,app:{listen:(_port,_host,callback)=>{listening++;callback();}},console:{log:()=>{},error:()=>{}},r2Config:()=>true,setTimeout:()=>{throw Error('migration timer created')},migrateImagesToR2:()=>{throw Error('migration called')}});
 await vm.runInContext(entry,context);assert.equal(listening,1);assert.equal(queries,1);
});
