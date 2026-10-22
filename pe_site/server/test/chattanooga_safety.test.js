import test from 'node:test';
import assert from 'node:assert/strict';
import { draftAdvertisedPrice, retailPriceCents, parseSupplierMoneyCents } from '../chattanooga_pricing.js';
import { createChattanoogaClient, validateItemsParams, validateProductFeedParams, normalizeFflNumber, evaluateFflStatus } from '../chattanooga_client.js';

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

test('FFL eligibility requires both explicit positive on-file and negative opt-out flags',()=>{
  const ffl_number='122333445A66666';
  const check=(on_file_flag,drop_ship_opted_out_flag)=>evaluateFflStatus({federal_firearms_licenses:[{ffl_number,on_file_flag,drop_ship_opted_out_flag}]},ffl_number);
  assert.equal(check('1','0').eligible_for_supplier_drop_ship,true);
  assert.equal(check('1','1').eligible_for_supplier_drop_ship,false);
  assert.equal(check('0','0').eligible_for_supplier_drop_ship,false);
  assert.equal(check('1',undefined).eligible_for_supplier_drop_ship,false);
  assert.equal(check('true','0').eligible_for_supplier_drop_ship,false);
  assert.equal(check('1','false').eligible_for_supplier_drop_ship,false);
  assert.throws(()=>evaluateFflStatus({federal_firearms_licenses:[]},ffl_number));
  assert.throws(()=>evaluateFflStatus({federal_firearms_licenses:[{ffl_number:'999999999999999'}]},ffl_number));
  assert.throws(()=>evaluateFflStatus({federal_firearms_licenses:[{ffl_number:'bad'}]},ffl_number),e=>e.status===502);
});

test('supplier network failures are sanitized and do not expose transport details',async()=>{
  const client=createChattanoogaClient({sid:'test',token:'test',fetchImpl:async()=>{throw new Error('private upstream URL or token');}});
  await assert.rejects(client.getItems({page:1}),e=>e.status===502&&!e.message.includes('private upstream'));
});

test('supplier FFL response rejects missing, multiple, or nonmatching license records',()=>{
  const license='122333445A66666';
  const valid={ffl_number:license,on_file_flag:1,drop_ship_opted_out_flag:0};
  for(const records of [null,[],[valid,valid],[{...valid,ffl_number:'999999999999999'}]]) {
    assert.throws(()=>evaluateFflStatus({federal_firearms_licenses:records},license));
  }
});

test('supplier FFL eligibility remains blocked when either status is unknown',()=>{
  const license='122333445A66666';
  for(const flags of [{on_file_flag:null,drop_ship_opted_out_flag:0},{on_file_flag:1,drop_ship_opted_out_flag:null}]) {
    const result=evaluateFflStatus({federal_firearms_licenses:[{ffl_number:license,...flags}]},license);
    assert.equal(result.eligible_for_supplier_drop_ship,false);
    assert.equal(result.requires_manual_review,true);
  }
});
