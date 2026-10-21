import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogPreview} from './chattanooga_catalog_preview.js';
import {reviewSupplierProduct,canPublishSupplierProduct} from './chattanooga_approval.js';
test('20 percent markup and MAP floor, approval initially pending',()=>{
 const [p]=catalogPreview([{cssi_id:'SKU1',name:'Optic',drop_ship_price:100,retail_map_price:'149.00',inventory:9,drop_ship_flag:1}]);
 assert.equal(p.provisional_price_cents,14900);
 assert.equal(p.approval_status,'pending');
 assert.equal(p.publishable,false);
 assert.equal(p.revision,0);
});
test('20 percent markup without MAP',()=>{
 const [p]=catalogPreview([{cssi_id:'SKU2',name:'Mount',drop_ship_price:50,inventory:3}]);
 assert.equal(p.provisional_price_cents,6000);
});
test('per-item approval cannot publish without safety gates',()=>{
 const [p]=catalogPreview([{cssi_id:'SKU3',name:'Part',drop_ship_price:20,inventory:1}]);
 const reviewed=reviewSupplierProduct(p,'approve',{actorId:'admin',reviewedAt:'2026-10-21T00:00:00Z',currentRevision:0});
 assert.equal(reviewed.approval_status,'approved');
 assert.equal(canPublishSupplierProduct(reviewed).publishable,false);
 assert.throws(()=>reviewSupplierProduct(reviewed,'approve',{actorId:'admin',reviewedAt:'2026-10-21T00:00:00Z',currentRevision:0}));
 assert.equal(canPublishSupplierProduct(reviewed,{shippingVerified:true,costVerified:true,mapVerified:true,restrictionsVerified:true}).publishable,true);
});
test('reject prevents publication',()=>{
 const [p]=catalogPreview([{cssi_id:'SKU4',name:'Part',drop_ship_price:20,inventory:1}]);
 const rejected=reviewSupplierProduct(p,'reject',{actorId:'admin',reviewedAt:'2026-10-21T00:00:00Z',currentRevision:0});
 assert.equal(canPublishSupplierProduct(rejected,{shippingVerified:true,costVerified:true,mapVerified:true,restrictionsVerified:true}).publishable,false);
});
