import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createChattanoogaClient } from './chattanooga_client.js';
import { retailPriceCents, normalizeCatalogStatus } from './chattanooga_pricing.js';

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
