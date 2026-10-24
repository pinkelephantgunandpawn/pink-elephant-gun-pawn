import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../../shop.html',import.meta.url),'utf8');
const init=html.split('\n').find(l=>l.startsWith("fetch(API+'/api/public/inventory')"));
assert.ok(init,'Exercise actual inventory initialization, never a copied implementation');
async function load(search){const input={value:''};let observed;const context=vm.createContext({API:'https://example.invalid',location:{search},URLSearchParams,data:[],cart:[],activeCategory:'All',document:{getElementById:id=>id==='searchBox'?input:null},fetch:async()=>({ok:true,json:async()=>[]}),render:()=>{observed=input.value;},saveCart:()=>{},effectivePrice:()=>0});await vm.runInContext(init,context);return {input,observed};}
test('header search query is applied before first shop render',async()=>{const r=await load('?category=Music&q=guitar');assert.equal(r.observed,'guitar');});
test('missing query preserves the normal unfiltered shop',async()=>{assert.equal((await load('?category=Tools')).observed,'');});
test('search text is decoded as a literal input value',async()=>{assert.equal((await load('?category=Music&q=%3Cscript%3E')).observed,'<script>');});
