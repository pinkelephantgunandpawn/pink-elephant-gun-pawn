import { createHash } from 'node:crypto';

// Read-only Chattanooga V6 client. Never expose SID/token in browser responses.
const BASE_URL = 'https://api.chattanoogashooting.com/rest/v6/';
export class ChattanoogaApiError extends Error {
  constructor(message, status, code) { super(message); this.name = 'ChattanoogaApiError'; this.status = status; this.code = code; }
}

// Reject undocumented product-feed query keys locally. This is validation only;
// it does not trigger a supplier request or enable scheduled downloads.
const PRODUCT_FEED_KEYS = new Set([
  'manufacturer_ids', 'optional_columns', 'custom_properties',
  'return_custom_properties', 'primary_image_only_flag'
]);
export function validateProductFeedParams(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('Invalid product-feed parameters');
  for (const key of Object.keys(params)) {
    if (!PRODUCT_FEED_KEYS.has(key)) throw new RangeError('Undocumented product-feed parameter');
  }
  return params;
}


const ITEM_QUERY_KEYS = new Set([
  'item_ids','upc_codes','manufacturer_ids','serialized_flag',
  'qas_last_updated_after','return_custom_properties','page','per_page'
]);
/** Validate documented read-only item query limits before sending any request. */
export function validateItemsParams(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('Invalid item parameters');
  for (const [key,value] of Object.entries(params)) {
    if (!ITEM_QUERY_KEYS.has(key)) throw new RangeError('Undocumented item parameter');
    if (value === undefined || value === null || value === '') continue;
    if (key === 'page' || key === 'per_page') {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1 || (key === 'per_page' && number > 50)) {
        throw new RangeError('Invalid item pagination');
      }
    }
    if (key === 'item_ids' || key === 'upc_codes' || key === 'manufacturer_ids') {
      if (typeof value !== 'string') throw new TypeError('Expected comma-separated item filter');
      const parts = value.split(',').map(x => x.trim());
      const max = key === 'manufacturer_ids' ? 10 : 50;
      const maxLength = key === 'item_ids' ? 24 : key === 'upc_codes' ? 13 : 80;
      if (parts.length > max || parts.some(x => !x || x.length > maxLength)) {
        throw new RangeError('Invalid item filter');
      }
    }
  }
  return params;
}

// V6 FFL identifiers are 15 characters, without hyphens. Never accept path fragments.
export function normalizeFflNumber(value) {
  if (typeof value !== 'string') throw new TypeError('FFL number must be a string');
  const normalized = value.trim().replace(/-/g, '').toUpperCase();
  if (!/^[A-Z0-9]{15}$/.test(normalized)) throw new RangeError('FFL number must be 15 alphanumeric characters without hyphens');
  return normalized;
}

export function createChattanoogaClient({ sid = process.env.CHATTANOOGA_SID, token = process.env.CHATTANOOGA_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  if (!sid || !token) throw new Error('Chattanooga credentials are not configured');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
  const hashedToken = createHash('md5').update(token, 'utf8').digest('hex');
  // CSSI documentation literally specifies "Basic [SID]:[MD5 token]".
  // Confirm against a real read-only request before enabling scheduled imports.
  const authorization = `Basic ${sid}:${hashedToken}`;
  async function get(endpoint, params = {}) {
    if (!['items','items/product-feed','item-properties'].includes(endpoint) && !/^federal-firearms-licenses\/[A-Z0-9]{15}$/.test(endpoint)) throw new Error('Endpoint not allowed');
    const url = new URL(endpoint, BASE_URL);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetchImpl(url, { method:'GET', headers:{ Authorization:authorization, Accept:'application/json' }, signal:controller.signal });
    } finally { clearTimeout(timer); }
    let body;
    try { body = await response.json(); } catch { throw new ChattanoogaApiError('Invalid JSON from Chattanooga', response.status); }
    if (!response.ok || body?.error_code) {
      throw new ChattanoogaApiError('Chattanooga API request failed', response.status, body?.error_code);
    }
    return body;
  }
  return Object.freeze({
    getItems: params => get('items', validateItemsParams(params)),
    getProductFeed: params => get('items/product-feed', validateProductFeedParams(params)),
    getItemProperties: params => get('item-properties', params),
    getFflStatus: fflNumber => get('federal-firearms-licenses/' + normalizeFflNumber(fflNumber))
  });
}
