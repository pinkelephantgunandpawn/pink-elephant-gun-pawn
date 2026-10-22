import test from 'node:test';
import assert from 'node:assert/strict';
import { draftAdvertisedPrice, retailPriceCents, parseSupplierMoneyCents } from '../chattanooga_pricing.js';
import { createChattanoogaClient, validateItemsParams, validateProductFeedParams, normalizeFflNumber } from '../chattanooga_client.js';

test('advertised price never falls below a verified MAP',()=>{
  const x=draftAdvertisedPrice({costCents:10000,mapCents:15000,markupPercent:20});
  assert.equal(x.proposedCents,12000);
  assert.equal(x.advertisedCents,15000);
  assert.equal(x.belowMap,true);
  assert.equal(x.readyForAdvertising,true);
});
test('missing MAP blocks advertising readiness',()=>{
  const x=draftAdvertisedPrice({costCents:10000,mapCents:null});
  assert.equal(x.advertisedCents,null);
  assert.equal(x.readyForAdvertising,false);
});
test('money parser rejects malformed and negative values',()=>{
  assert.equal(parseSupplierMoneyCents('19.95'),1995);
  for(const bad of ['-1','1.999','1e3','',null])assert.throws(()=>parseSupplierMoneyCents(bad));
});
test('override and cost checks reject invalid amounts',()=>{
  assert.throws(()=>retailPriceCents(1000,20,-1));
  assert.throws(()=>retailPriceCents(-1));
});
test('supplier query rejects undocumented and oversized requests',()=>{
  assert.throws(()=>validateItemsParams({item_ids:'x,'.repeat(51)}));
  assert.throws(()=>validateItemsParams({per_page:51}));
  assert.throws(()=>validateProductFeedParams({secret:'x'}));
});
test('supplier client allows GET items but never POST or order endpoints',async()=>{
  const calls=[];
  const client=createChattanoogaClient({sid:'test-sid',token:'test-token',fetchImpl:async(url,opts)=>{
    calls.push({url:String(url),method:opts.method});
    return {ok:true,status:200,json:async()=>({items:[]})};
  }});
  await client.getItems({page:1,per_page:5});
  assert.equal(calls.length,1);
  assert.equal(calls[0].method,'GET');
  assert.match(calls[0].url,/\/rest\/v6\/items\?/);
  assert.equal('createOrder' in client,false);
});

test('FFL number normalization accepts documented format',()=>{
  assert.equal(normalizeFflNumber('12-233-3445A66666'),'122333445A66666');
  for(const value of ['123','1234567890123456','not a license',''])assert.throws(()=>normalizeFflNumber(value));
});
test('FFL status lookup uses GET and does not enable supplier writes',async()=>{
  const calls=[];
  const client=createChattanoogaClient({sid:'test',token:'test',fetchImpl:async(url,opts)=>{
    calls.push({url:String(url),method:opts.method});
    return {ok:true,status:200,json:async()=>({federal_firearms_licenses:[]})};
  }});
  await client.getFflStatus('122333445A66666');
  assert.equal(calls[0].method,'GET');
  assert.match(calls[0].url,/federal-firearms-licenses\/122333445A66666$/);
  assert.equal('createOrder' in client,false);
});
