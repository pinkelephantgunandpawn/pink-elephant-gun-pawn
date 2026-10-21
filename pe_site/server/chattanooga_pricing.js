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
