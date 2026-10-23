import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {z} from 'zod';
// Instantiate existing schema declarations only. Never load/start index.js,
// execute handlers, connect a database, or send an order/payment request.
const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
function schema(name){const match=source.match(new RegExp('const '+name+'=([\\s\\S]*?);\\r?\\n'));assert.ok(match);return vm.runInNewContext(match[1],{z});}
const id='123e4567-e89b-42d3-a456-426614174000';
const customer={name:'Synthetic Example',email:'test@example.invalid',phone:'5550100000'};
const shipping={address1:'123 Example Street',city:'Example',state:'KY',postal:'00000'};
const item={inventory_id:id,quantity:1};
test('patched validation preserves general shipping quote acceptance and limits',()=>{const s=schema('shippingQuoteSchema');assert.ok(s.safeParse({customer,shipping,items:[item]}).success);assert.equal(s.safeParse({customer,shipping,items:Array(26).fill(item)}).success,false);assert.equal(s.safeParse({customer,shipping,items:[{...item,quantity:-1}]}).success,false);});
test('patched validation preserves general order schema defaults and rejects invalid quantity',()=>{const s=schema('publicOrderSchema');const r=s.safeParse({customer,fulfillment:'pickup',items:[item]});assert.ok(r.success);assert.equal(r.data.notes,'');assert.equal(s.safeParse({customer,fulfillment:'pickup',items:[{...item,quantity:0}]}).success,false);});
test('patched validation preserves non-regulated inventory schema bounds',()=>{const s=schema('inventorySchema');const x={title:'Synthetic tool',category:'Tools',quantity:1,cost_cents:100,item_type:'quantity',low_stock:0,description:''};assert.ok(s.safeParse(x).success);assert.equal(s.safeParse({...x,quantity:-1}).success,false);assert.equal(s.safeParse({...x,image_urls:Array(5).fill('https://example.invalid/image.jpg')}).success,false);});
test('patched validation preserves general offer schema validation',()=>{const s=schema('publicOfferSchema');assert.ok(s.safeParse({inventory_id:id,customer,offer_cents:100}).success);assert.equal(s.safeParse({inventory_id:'invalid',customer,offer_cents:100}).success,false);assert.equal(s.safeParse({inventory_id:id,customer,offer_cents:99}).success,false);});
