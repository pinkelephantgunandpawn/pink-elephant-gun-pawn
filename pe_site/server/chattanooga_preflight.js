// Chattanooga catalog preflight. Pure, read-only decisions; never imports or publishes.
const cents = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const s=String(value).trim();
  if (!/^(?:0|[1-9]\\d*)(?:\\.\\d{1,2})?$/.test(s)) return null;
  const [whole, fractional='']=s.split('.');
  const n=Number(whole)*100+Number(fractional.padEnd(2,'0'));
  return Number.isSafeInteger(n)?n:null;
};
export function preflightCatalogItem(item, {markupPercent=20, shippingCents=null, requireMapConfirmation=true}={}) {
  const reasons=[];
  if (!item || typeof item!=='object' || Array.isArray(item)) return Object.freeze({eligible:false,reasons:['invalid_item']});
  if (typeof item.cssi_id!=='string'||!item.cssi_id.trim()||typeof item.name!=='string'||!item.name.trim()) reasons.push('invalid_identity');
  if (!Number.isSafeInteger(item.inventory)||item.inventory<1) reasons.push('unavailable_inventory');
  const cost=cents(item.drop_ship_price);
  if (cost===null||cost===0) reasons.push('unverified_cost');
  if (!Number.isFinite(markupPercent)||markupPercent<0||markupPercent>1000) reasons.push('invalid_markup');
  if (!Number.isSafeInteger(shippingCents)||shippingCents<0) reasons.push('shipping_not_confirmed');
  const rawMap=item.retail_map_price;
  const map=cents(rawMap);
  if (map===null && requireMapConfirmation) reasons.push('map_not_confirmed');
  // Cost and MAP matching two portal screenshots does not establish supplier policy.
  reasons.push('supplier_price_semantics_not_confirmed');
  return Object.freeze({
    eligible:false,
    reasons:Object.freeze(reasons),
    inventory_valid:Number.isSafeInteger(item.inventory)&&item.inventory>0,
    cost_field_present:cost!==null,
    map_field_present:map!==null,
    // No suggested selling price until acquisition costs and MAP policy are verified.
    proposed_price_cents:null
  });
}
export function summarizeCatalogPreflight(items, options={}) {
  if (!Array.isArray(items)||items.length>50) throw new RangeError('Expected at most 50 items');
  const results=items.map(item=>preflightCatalogItem(item,options));
  const counts={};
  for (const result of results) for(const reason of result.reasons) counts[reason]=(counts[reason]||0)+1;
  return Object.freeze({checked:results.length,eligible:0,blocked:results.length,reason_counts:counts,import_enabled:false});
}
