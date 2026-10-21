import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createChattanoogaClient } from './chattanooga_client.js';
import { inspectCassiItem } from './chattanooga_inspect.js';
import { retailPriceCents, normalizeCatalogStatus, parseSupplierMoneyCents, evaluateMapPrice } from './chattanooga_pricing.js';

test('default 20 percent markup and override', () => {
  assert.equal(retailPriceCents(50000),60000);
  assert.equal(retailPriceCents(50000,20,55555),55555);
  assert.throws(() => retailPriceCents(-1));
  assert.equal(normalizeCatalogStatus('draft'),'draft');
  assert.throws(() => normalizeCatalogStatus('unreviewed'));
});
test('read-only client sends documented auth and does not expose secrets', async () => {
  const sid='exampleSid', token='exampleToken';
  const calls=[];
  const client=createChattanoogaClient({sid,token,fetchImpl:async (url,options)=>{
    calls.push({url:String(url),options});
    return {ok:true,status:200,json:async()=>({items:[]})};
  }});
  assert.deepEqual(await client.getItems({page:2,per_page:50}),{items:[]});
  assert.equal(calls[0].url,'https://api.chattanoogashooting.com/rest/v6/items?page=2&per_page=50');
  assert.equal(calls[0].options.headers.Authorization,'Basic '+sid+':'+createHash('md5').update(token).digest('hex'));
  assert.equal(typeof client.getOrders,'undefined');
});
test('API error does not leak credentials', async () => {
  const client=createChattanoogaClient({sid:'s',token:'secret',fetchImpl:async()=>({ok:false,status:401,json:async()=>({error_code:4001})})});
  await assert.rejects(client.getItems(),err=>err.code===4001 && !err.message.includes('secret'));
});

test('supplier MAP string parsing and reference optic price',()=>{
  assert.equal(parseSupplierMoneyCents('189.00'),18900);
  assert.equal(parseSupplierMoneyCents(139.99),13999);
  assert.equal(parseSupplierMoneyCents('0'),0);
  for(const bad of ['',null,'N/A','-1','$189.00','189.001',Infinity]) assert.throws(()=>parseSupplierMoneyCents(bad));
  const result=evaluateMapPrice({costCents:13999,mapCents:parseSupplierMoneyCents('189.00')});
  assert.deepEqual(result,{proposedCents:16799,mapCents:18900,suggestedCents:18900,belowMap:true});
  const override=evaluateMapPrice({costCents:13999,mapCents:18900,overrideCents:20000});
  assert.equal(override.belowMap,false);
  assert.equal(override.suggestedCents,20000);
});

test('read-only API client preserves supplier error status without exposing response secrets',async()=>{
  const client=createChattanoogaClient({sid:'testSid',token:'privateToken',fetchImpl:async()=>({ok:false,status:422,json:async()=>({error_code:9000,message:'sensitive upstream detail'})})});
  await assert.rejects(client.getProductFeed({page:1,per_page:1}),err=>err.status===422&&err.code===9000&&!err.message.includes('sensitive upstream detail'));
});
test('read-only API client rejects invalid JSON',async()=>{
  const client=createChattanoogaClient({sid:'testSid',token:'privateToken',fetchImpl:async()=>({ok:true,status:200,json:async()=>{throw Error('bad JSON');}})});
  await assert.rejects(client.getItems(),err=>err.status===200&&err.name==='ChattanoogaApiError');
});
test('read-only client allows only documented GET endpoints',async()=>{
  const calls=[];
  const client=createChattanoogaClient({sid:'s',token:'t',fetchImpl:async(url,options)=>{calls.push({url:String(url),method:options.method});return {ok:true,status:200,json:async()=>({items:[]})};}});
  await client.getProductFeed();
  await client.getItemProperties();
  assert.equal(calls.length,2);
  assert.ok(calls.every(c=>c.method==='GET'));
  assert.ok(calls[0].url.endsWith('/items/product-feed'));
  assert.ok(calls[1].url.endsWith('/item-properties'));
  assert.equal(client.getOrders,undefined);
});

test('read-only client treats supplier error codes in HTTP 200 as failures',async()=>{
  const client=createChattanoogaClient({sid:'s',token:'privateToken',fetchImpl:async()=>({ok:true,status:200,json:async()=>({error_code:9000,message:'private supplier detail'})})});
  await assert.rejects(client.getItems(),err=>err.name==='ChattanoogaApiError'&&err.code===9000&&!err.message.includes('private supplier detail'));
});
test('read-only client encodes item filters without modifying endpoint or HTTP method',async()=>{
  const calls=[];
  const client=createChattanoogaClient({sid:'s',token:'t',fetchImpl:async(url,options)=>{calls.push({url:String(url),method:options.method});return {ok:true,status:200,json:async()=>({items:[]})};}});
  await client.getItems({item_ids:'ABC & 123',page:1,per_page:1});
  assert.equal(calls.length,1);
  const url=new URL(calls[0].url);
  assert.equal(url.origin,'https://api.chattanoogashooting.com');
  assert.equal(url.pathname,'/rest/v6/items');
  assert.equal(url.searchParams.get('item_ids'),'ABC & 123');
  assert.equal(url.searchParams.get('page'),'1');
  assert.equal(calls[0].method,'GET');
});

test('CSSI V6 field inspection is read-only and does not assume custom_price is dealer cost',()=>{
  const sample={cssi_id:'123',name:'Sample optic',custom_price:139.99,inventory:9,map_price:'189.00',retail_map_price:'189.00',drop_ship_price:145,retail_price:210};
  const result=inspectCassiItem(sample);
  assert.equal(result.cssi_id,'123');
  assert.equal(result.inventory,9);
  assert.equal(result.map_price,'189.00');
  assert.equal(result.custom_price_candidate,139.99);
  assert.equal(result.price_meaning_verified,false);
  assert.equal(result.safe_to_import,false);
  assert.equal(sample.name,'Sample optic');
  assert.ok(Object.isFrozen(result));
});
test('CSSI inspection fails closed on absent identity, invalid quantities and malformed prices',()=>{
  const result=inspectCassiItem({cssi_id:'',name:'Item',inventory:-1,custom_price:'139.99',map_price:'N/A'});
  assert.equal(result.valid_identity,false);
  assert.equal(result.inventory,null);
  assert.equal(result.custom_price_candidate,null);
  assert.equal(result.map_price,null);
  assert.equal(result.safe_to_import,false);
  assert.throws(()=>inspectCassiItem(null),TypeError);
});
