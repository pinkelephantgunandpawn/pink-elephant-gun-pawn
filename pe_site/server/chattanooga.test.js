import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createChattanoogaClient, validateProductFeedParams } from './chattanooga_client.js';
import { inspectCassiItem, summarizeCssiReadiness, classifyCssiMapFormat, summarizeCssiProbeResponse } from './chattanooga_inspect.js';
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
  await assert.rejects(client.getProductFeed(),err=>err.status===422&&err.code===9000&&!err.message.includes('sensitive upstream detail'));
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

test('isolated CSSI readiness summary exposes booleans, not supplier values',()=>{
  const item={cssi_id:'SECRET-ITEM-123',name:'Private optic name',inventory:9,custom_price:139.99,map_price:'189.00',retail_map_price:'189.00'};
  const summary=summarizeCssiReadiness(item);
  assert.equal(summary.identity_valid,true);
  assert.equal(summary.inventory_field_valid,true);
  assert.equal(summary.custom_price_field_valid,true);
  assert.equal(summary.map_field_valid,true);
  assert.equal(summary.price_meaning_verified,false);
  assert.equal(summary.safe_to_import,false);
  assert.ok(Object.values(summary).every(x=>typeof x==='boolean'));
  const json=JSON.stringify(summary);
  for(const sensitive of ['SECRET-ITEM-123','Private optic name','139.99','189.00']) assert.ok(!json.includes(sensitive));
});

test('dealer portal examples: missing MAP is different from malformed MAP',()=>{
  // Synthetic API-shaped records based on portal displays, not captured API payloads.
  const missing=inspectCassiItem({cssi_id:'example-romeo',name:'Example Romeo optic',inventory:32,custom_price:113.88,map_price:'-',retail_map_price:'-'});
  assert.equal(missing.map_price,null);
  assert.equal(missing.map_field_status,'missing');
  assert.equal(missing.retail_map_field_status,'missing');
  const summary=summarizeCssiReadiness({cssi_id:'example-romeo',name:'Example Romeo optic',inventory:32,map_price:'-',retail_map_price:'-'});
  assert.equal(summary.map_field_missing,true);
  assert.equal(summary.retail_map_field_missing,true);
  assert.equal(summary.map_field_valid,false);
  for(const value of [null,undefined,'','  ',' - ']){
    assert.equal(inspectCassiItem({cssi_id:'1',name:'Optic',map_price:value}).map_field_status,'missing');
  }
  for(const value of ['N/A','$149.00','149.000','-149.00',149,{}]){
    assert.equal(inspectCassiItem({cssi_id:'1',name:'Optic',map_price:value}).map_field_status,'invalid');
  }
});
test('ZeroTech portal example: 20 percent markup is below displayed retail MAP',()=>{
  // Portal screenshot: cost $95.99, retail MAP $149.00. No assumption that API custom_price is dealer cost.
  const proposed=retailPriceCents(9599,20);
  assert.equal(proposed,11519);
  const result=evaluateMapPrice({costCents:9599,mapCents:parseSupplierMoneyCents('149.00')});
  assert.equal(result.proposedCents,11519);
  assert.equal(result.suggestedCents,14900);
  assert.equal(result.belowMap,true);
  const inspected=inspectCassiItem({cssi_id:'example-zerotech',name:'ZeroTech Thrive optic',inventory:9,retail_map_price:'149.00'});
  assert.equal(inspected.retail_map_price,'149.00');
  assert.equal(inspected.retail_map_field_status,'present');
  assert.equal(inspected.safe_to_import,false);
});

test('read-only MAP format classifier reports shapes, never prices',()=>{
  const samples=[
    [undefined,'absent'],[null,'absent'],['','blank'],['  ','blank'],['-','dash'],
    ['149.00','plain_money'],['0','plain_money'],['0.0000','extra_decimal_places'],
    ['$149.00','currency_symbol'],['-149.00','signed_number'],[149,'numeric_type'],
    [Infinity,'nonfinite_number'],[{},'other_type'],['N/A','other_string']
  ];
  for(const [value,expected] of samples) {
    const shape=classifyCssiMapFormat(value);
    assert.equal(shape,expected);
    assert.ok(!shape.includes('149'));
  }
});

test('isolated supplier probe distinguishes connection response from valid catalog shape',()=>{
  const good=summarizeCssiProbeResponse({pagination:{page:1},items:[{cssi_id:'ABC',name:'Sample optic'}]});
  assert.deepEqual(good,{
    items_array_present:true,
    sample_item_present:true,
    sample_identity_valid:true,
    catalog_schema_verified:true,
    safe_to_import:false
  });
  assert.equal(summarizeCssiProbeResponse({items:[]}).catalog_schema_verified,false);
  assert.equal(summarizeCssiProbeResponse({items:[{name:'Missing supplier ID'}]}).sample_identity_valid,false);
  assert.equal(summarizeCssiProbeResponse({data:[{cssi_id:'1',name:'Other shape'}]}).items_array_present,false);
  assert.equal(summarizeCssiProbeResponse(null).catalog_schema_verified,false);
  assert.ok(Object.values(good).every(x=>typeof x==='boolean'));
  assert.ok(Object.isFrozen(good));
  assert.ok(!JSON.stringify(good).includes('Sample optic'));
});

test('read-only client does not retry supplier rate-limited responses',async()=>{
  let requests=0;
  const client=createChattanoogaClient({sid:'testSid',token:'privateToken',fetchImpl:async()=>{
    requests++;
    return {ok:false,status:429,json:async()=>({error_code:'too-many-requests',message:'supplier internal details'})};
  }});
  await assert.rejects(client.getItems({page:1,per_page:1}),err=>
    err.name==='ChattanoogaApiError' &&
    err.status===429 &&
    err.code==='too-many-requests' &&
    !err.message.includes('supplier internal details')
  );
  assert.equal(requests,1);
});

test('official V6 product-feed parameter contract rejects undocumented pagination without network requests',async()=>{
  let requests=0;
  const client=createChattanoogaClient({sid:'s',token:'t',fetchImpl:async()=>{
    requests++;
    return {ok:true,status:200,json:async()=>({product_feed:{url:'https://example.invalid/feed.csv'}})};
  }});
  assert.throws(()=>validateProductFeedParams({page:1}),RangeError);
  assert.throws(()=>validateProductFeedParams({per_page:1}),RangeError);
  assert.throws(()=>validateProductFeedParams({unknown:'value'}),RangeError);
  assert.throws(()=>validateProductFeedParams(null),TypeError);
  assert.throws(()=>client.getProductFeed({page:1,per_page:1}),RangeError);
  assert.equal(requests,0);
  const allowed=validateProductFeedParams({manufacturer_ids:'AA',primary_image_only_flag:1});
  assert.equal(allowed.manufacturer_ids,'AA');
});
