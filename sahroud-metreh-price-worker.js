/**
 * SAHROUD METREH - Cloudflare Worker price gateway
 *
 * Required Worker variables/secrets:
 *   PRICE_PROVIDER_URL  : HTTPS JSON API URL of a licensed/verified price provider
 *   PRICE_PROVIDER_KEY  : optional secret/token for that provider
 *   ALLOWED_ORIGIN      : exact GitHub Pages origin, e.g. https://sahroud.github.io
 *
 * The upstream provider must return the SAHROUD schema documented below.
 * This Worker is a secure CORS gateway; it does not scrape websites or invent prices.
 */
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '';
    const corsOrigin = origin === allowed ? origin : 'null';
    const cors = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, cors);
    if (!allowed || origin !== allowed) return json({ error: 'Origin not allowed' }, 403, cors);
    if (!env.PRICE_PROVIDER_URL) return json({ error: 'PRICE_PROVIDER_URL is not configured' }, 503, cors);

    const incoming = new URL(request.url);
    const city = (incoming.searchParams.get('city') || '').trim();
    const currency = (incoming.searchParams.get('currency') || '').trim();
    if (!city || !currency) return json({ error: 'city and currency are required' }, 400, cors);

    try {
      const upstream = new URL(env.PRICE_PROVIDER_URL);
      if (upstream.protocol !== 'https:') throw new Error('Provider URL must use HTTPS');
      upstream.searchParams.set('city', city);
      upstream.searchParams.set('currency', currency);

      const headers = { 'Accept': 'application/json' };
      if (env.PRICE_PROVIDER_KEY) headers['Authorization'] = `Bearer ${env.PRICE_PROVIDER_KEY}`;
      const response = await fetch(upstream.toString(), { headers, cf: { cacheTtl: 0, cacheEverything: false } });
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
      const data = await response.json();

      // Strictly preserve provenance; the browser independently validates each timestamp and unit.
      if (!Array.isArray(data.items) || data.city !== city || data.currency !== currency) {
        throw new Error('Provider response does not match requested city/currency or items schema');
      }
      const payload = {
        city: data.city,
        currency: data.currency,
        source: data.source || null,
        updatedAt: data.updatedAt || null,
        transportIncluded: data.transportIncluded === true,
        taxIncluded: data.taxIncluded === true,
        items: data.items.map(item => ({
          name: item.name,
          unit: item.unit,
          material: item.material,
          labor: item.labor,
          source: item.source || data.source || null,
          updatedAt: item.updatedAt || data.updatedAt || null,
          city: item.city || data.city,
          currency: item.currency || data.currency,
          transportIncluded: item.transportIncluded ?? data.transportIncluded ?? false,
          taxIncluded: item.taxIncluded ?? data.taxIncluded ?? false
        }))
      };
      return json(payload, 200, { ...cors, 'Cache-Control': 'no-store' });
    } catch (error) {
      return json({ error: String(error.message || error) }, 502, cors);
    }
  }
};

function json(value, status, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}

/* Expected upstream JSON:
{
  "city": "شاهرود",
  "currency": "تومان",
  "source": "نام منبع واقعی",
  "updatedAt": "2026-11-19T07:00:00+03:30",
  "transportIncluded": false,
  "taxIncluded": false,
  "items": [
    { "name": "بتن آماده", "unit": "m³", "material": 0, "labor": 0,
      "source": "نام فروشنده/مرجع", "updatedAt": "2026-11-19T07:00:00+03:30" }
  ]
}
*/