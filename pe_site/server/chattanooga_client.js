import { createHash } from 'node:crypto';

// Read-only Chattanooga V6 client. Never expose SID/token in browser responses.
const BASE_URL = 'https://api.chattanoogashooting.com/rest/v6/';
export class ChattanoogaApiError extends Error {
  constructor(message, status, code) { super(message); this.name = 'ChattanoogaApiError'; this.status = status; this.code = code; }
}
export function createChattanoogaClient({ sid = process.env.CHATTANOOGA_SID, token = process.env.CHATTANOOGA_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  if (!sid || !token) throw new Error('Chattanooga credentials are not configured');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
  const hashedToken = createHash('md5').update(token, 'utf8').digest('hex');
  // CSSI documentation literally specifies "Basic [SID]:[MD5 token]".
  // Confirm against a real read-only request before enabling scheduled imports.
  const authorization = `Basic ${sid}:${hashedToken}`;
  async function get(endpoint, params = {}) {
    if (!['items','items/product-feed','item-properties'].includes(endpoint)) throw new Error('Endpoint not allowed');
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
    getItems: params => get('items', params),
    getProductFeed: params => get('items/product-feed', params),
    getItemProperties: params => get('item-properties', params)
  });
}
