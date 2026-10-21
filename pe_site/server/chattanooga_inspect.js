// Read-only CSSI V6 field inspection. Never publishes, imports, or places orders.
// A field being present does not establish its business meaning (e.g. custom_price).
export function inspectCassiItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Expected a supplier item object');
  const id = typeof item.cssi_id === 'string' && item.cssi_id.trim() ? item.cssi_id.trim() : null;
  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : null;
  const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  // A dealer portal may display a dash when MAP is not provided.
  // Preserve missing vs malformed values without guessing what the API uses.
  const mapField = (value) => {
    if (value === null || value === undefined || (typeof value === 'string' && ['', '-'].includes(value.trim()))) {
      return {status:'missing',value:null};
    }
    if (typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value.trim())) {
      return {status:'present',value:value.trim()};
    }
    return {status:'invalid',value:null};
  };
  const map = mapField(item.map_price);
  const retailMap = mapField(item.retail_map_price);
  const inventory = Number.isSafeInteger(item.inventory) && item.inventory >= 0 ? item.inventory : null;
  return Object.freeze({
    cssi_id: id,
    name,
    inventory,
    custom_price_candidate: numeric(item.custom_price),
    map_price: map.value,
    retail_map_price: retailMap.value,
    map_field_status: map.status,
    retail_map_field_status: retailMap.status,
    drop_ship_price: numeric(item.drop_ship_price),
    retail_price: numeric(item.retail_price),
    valid_identity: Boolean(id && name),
    price_meaning_verified: false,
    safe_to_import: false
  });
}

/** Safe to expose on the isolated probe: booleans only, never supplier records. */
export function summarizeCssiReadiness(item) {
  const x = inspectCassiItem(item);
  return Object.freeze({
    identity_valid: x.valid_identity,
    inventory_field_valid: x.inventory !== null,
    custom_price_field_valid: x.custom_price_candidate !== null,
    map_field_valid: x.map_field_status === 'present',
    retail_map_field_valid: x.retail_map_field_status === 'present',
    map_field_missing: x.map_field_status === 'missing',
    retail_map_field_missing: x.retail_map_field_status === 'missing',
    price_meaning_verified: x.price_meaning_verified,
    safe_to_import: x.safe_to_import
  });
}
