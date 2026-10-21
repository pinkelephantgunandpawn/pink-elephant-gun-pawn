// Read-only CSSI V6 field inspection. Never publishes, imports, or places orders.
// A field being present does not establish its business meaning (e.g. custom_price).
export function inspectCassiItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Expected a supplier item object');
  const id = typeof item.cssi_id === 'string' && item.cssi_id.trim() ? item.cssi_id.trim() : null;
  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : null;
  const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const moneyString = (value) => typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value.trim()) ? value.trim() : null;
  const inventory = Number.isSafeInteger(item.inventory) && item.inventory >= 0 ? item.inventory : null;
  return Object.freeze({
    cssi_id: id,
    name,
    inventory,
    custom_price_candidate: numeric(item.custom_price),
    map_price: moneyString(item.map_price),
    retail_map_price: moneyString(item.retail_map_price),
    drop_ship_price: numeric(item.drop_ship_price),
    retail_price: numeric(item.retail_price),
    valid_identity: Boolean(id && name),
    price_meaning_verified: false,
    safe_to_import: false
  });
}
