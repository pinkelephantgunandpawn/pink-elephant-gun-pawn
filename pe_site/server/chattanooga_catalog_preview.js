// Admin-only catalog preview transforms. No database writes, supplier orders or public dealer costs.
const money=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.round(value*100):null;
export function catalogPreview(items,{marginPercent=20}={}) {
 if(!Array.isArray(items)||items.length>50) throw new RangeError('Maximum 50 items per preview');
 if(!Number.isFinite(marginPercent)||marginPercent<0||marginPercent>500) throw new RangeError('Invalid margin');
 return items.map(item=>{
  const cost=money(item?.drop_ship_price);
  const mapRaw=item?.retail_map_price;
  const map=typeof mapRaw==='string'&&/^\\d+(?:\\.\\d{1,2})?$/.test(mapRaw.trim())?Math.round(Number(mapRaw)*100):null;
  const quantity=Number.isSafeInteger(item?.inventory)&&item.inventory>=0?item.inventory:null;
  const candidate=cost===null?null:Math.ceil(cost*(1+marginPercent/100));
  const suggested= candidate===null?null:Math.max(candidate,map??0);
  return {sku:String(item?.cssi_id??''),name:String(item?.name??''),supplier_quantity:quantity,
    drop_ship_eligible:item?.drop_ship_flag===1,
    ffl_required:item?.ffl_flag===1||item?.serialized_flag===1,
    dealer_cost_cents:cost,map_cents:map,provisional_price_cents:suggested,
    publishable:false,approval_status:'pending',blockers:['shipping_cost_unverified','supplier_cost_semantics_unverified','manual_approval_required']};
 });
}
