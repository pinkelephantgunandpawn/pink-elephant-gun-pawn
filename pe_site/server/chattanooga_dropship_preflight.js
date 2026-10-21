// Pure Chattanooga drop-ship order preflight. No supplier requests or order placement.
const OPTIONS = new Set(['best','fastest','economy','ground','next_day_air','second_day_air']);
export function validateDropShipDraft(draft, {accountAuthorized=false, fflVerified=false, paymentCaptured=false}={}) {
 const errors=[];
 if (!draft || typeof draft!=='object' || Array.isArray(draft)) return {ready:false,errors:['invalid_draft']};
 if (!accountAuthorized) errors.push('supplier_drop_ship_authorization_required');
 if (!paymentCaptured) errors.push('payment_not_confirmed');
 if (!draft.purchase_order_number || typeof draft.purchase_order_number!=='string' || draft.purchase_order_number.length>24) errors.push('invalid_purchase_order_number');
 if (!OPTIONS.has(draft.delivery_option)) errors.push('invalid_delivery_option');
 const a=draft.ship_to_address;
 if (!a || !['name','line_1','city','state_code','zip'].every(k=>String(a[k]??'').trim())) errors.push('incomplete_shipping_address');
 if (!Array.isArray(draft.order_items) || !draft.order_items.length || draft.order_items.length>250 ||
    draft.order_items.some(i=>!i || typeof i.item_number!=='string'||!i.item_number.trim()||!Number.isSafeInteger(i.order_quantity)||i.order_quantity<1)) errors.push('invalid_items');
 const hasFFL=draft.contains_ffl_items===true;
 if (draft.contains_ffl_items!==true && draft.contains_ffl_items!==false) errors.push('item_ffl_classification_required');
 if (draft.contains_mixed_ffl_and_non_ffl===true) errors.push('split_ffl_and_non_ffl_orders');
 if (hasFFL && (!fflVerified || !/^[A-Za-z0-9]{15}$/.test(String(draft.federal_firearms_license_number||'')))) errors.push('receiving_ffl_not_verified');
 if (!hasFFL && draft.federal_firearms_license_number) errors.push('ffl_number_not_applicable');
 if (draft.drop_ship_flag!==1) errors.push('not_a_drop_ship_order');
 if (!String(draft.customer||'').trim()) errors.push('customer_reference_required');
 // Separate checkout policy, state/item restrictions, shipment costs, and idempotency must be verified upstream.
 errors.push('shipping_quote_and_item_restrictions_not_verified');
 errors.push('idempotent_order_submission_not_implemented');
 return Object.freeze({ready:false,errors:Object.freeze(errors),supplier_submission_enabled:false});
}
