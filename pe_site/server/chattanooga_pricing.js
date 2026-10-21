// Chattanooga draft catalog helpers (no network requests or ordering).
export const CHATTANOOGA_DEFAULT_MARKUP = 20;
export function retailPriceCents(costCents, markupPercent = CHATTANOOGA_DEFAULT_MARKUP, overrideCents = null) {
  if (overrideCents !== null && overrideCents !== undefined) {
    if (!Number.isSafeInteger(overrideCents) || overrideCents < 0) throw new RangeError('Invalid override');
    return overrideCents;
  }
  if (!Number.isSafeInteger(costCents) || costCents < 0) throw new RangeError('Invalid cost');
  if (!Number.isFinite(markupPercent) || markupPercent < 0) throw new RangeError('Invalid markup');
  const price = Math.round(costCents * (1 + markupPercent / 100));
  if (!Number.isSafeInteger(price)) throw new RangeError('Price too large');
  return price;
}
export function normalizeCatalogStatus(value) {
  if (!['draft','published','hidden'].includes(value)) throw new RangeError('Invalid catalog status');
  return value;
}

/**
 * Read-only pricing validation. CSSI returns MAP fields as strings, so accept
 * numeric strings and reject malformed or negative amounts instead of silently
 * treating them as zero. This helper does not publish or order products.
 */
export function parseSupplierMoneyCents(value) {
  if (typeof value !== 'number' && typeof value !== 'string') throw new RangeError('Invalid supplier amount');
  const normalized = typeof value === 'string' ? value.trim() : String(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) throw new RangeError('Invalid supplier amount');
  const [whole, fraction = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2,'0'));
  if (!Number.isSafeInteger(cents)) throw new RangeError('Supplier amount too large');
  return cents;
}
export function evaluateMapPrice({costCents, mapCents, markupPercent=CHATTANOOGA_DEFAULT_MARKUP, overrideCents=null}) {
  if (!Number.isSafeInteger(mapCents) || mapCents < 0) throw new RangeError('Invalid MAP');
  const proposedCents = retailPriceCents(costCents, markupPercent, overrideCents);
  return Object.freeze({ proposedCents, mapCents, suggestedCents: Math.max(proposedCents,mapCents), belowMap: proposedCents < mapCents });
}
