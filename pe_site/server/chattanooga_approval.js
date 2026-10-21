// Pure approval decisions for a future authenticated admin workflow.
// The calling application must persist approval records and enforce admin authorization.
export function reviewSupplierProduct(product, action, {actorId, reviewedAt, currentRevision}={}) {
 if (!product || typeof product!=='object' || !String(product.sku||'').trim()) throw new TypeError('Invalid supplier product');
 if (!['approve','reject'].includes(action)) throw new RangeError('Invalid review action');
 if (!String(actorId||'').trim()) throw new TypeError('Reviewer required');
 if (!Number.isSafeInteger(currentRevision)||currentRevision<0||product.revision!==currentRevision) throw new Error('Stale product revision');
 if (!reviewedAt || Number.isNaN(Date.parse(reviewedAt))) throw new TypeError('Review timestamp required');
 if (product.approval_status!=='pending') throw new Error('Product already reviewed');
 return Object.freeze({...product,approval_status:action==='approve'?'approved':'rejected',
  approved_by:action==='approve'?actorId:null,reviewed_by:actorId,reviewed_at:reviewedAt,
  revision:currentRevision+1,publishable:false});
}
export function canPublishSupplierProduct(product,{shippingVerified=false,costVerified=false,mapVerified=false,restrictionsVerified=false}={}) {
 const blockers=[];
 if(product?.approval_status!=='approved') blockers.push('admin_approval_required');
 if(!shippingVerified) blockers.push('shipping_not_verified');
 if(!costVerified) blockers.push('supplier_cost_not_verified');
 if(!mapVerified) blockers.push('map_policy_not_verified');
 if(!restrictionsVerified) blockers.push('shipping_restrictions_not_verified');
 if(!Number.isSafeInteger(product?.supplier_quantity)||product.supplier_quantity<1) blockers.push('out_of_stock');
 if(!Number.isSafeInteger(product?.provisional_price_cents)||product.provisional_price_cents<1) blockers.push('price_not_ready');
 return Object.freeze({publishable:blockers.length===0,blockers:Object.freeze(blockers)});
}
