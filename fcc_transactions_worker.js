const CACHE_PREFIX = 'fcc:transactions:';
const JSON_HEADERS = { 'Cache-Control': 'public, max-age=900', 'Access-Control-Allow-Origin': '*' };

function dateScore(value) {
  const text = String(value ?? '').trim();
  if (!text || /1900/.test(text)) return 0;
  const time = Date.parse(text);
  return Number.isNaN(time) ? 0 : time;
}

function recentRows(rows) {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 2);
  const cutoffTime = cutoff.getTime();
  return rows.filter(row => Math.max(dateScore(row.filed), dateScore(row.statusDate)) >= cutoffTime);
}

function callMatches(row, call) {
  return !call || String(row.call || '').toLowerCase().includes(call);
}

function looksLikeRadio(row) {
  const service = String(row.service || '').toLowerCase();
  if (/am|fm|radio|translator|lpfm|booster|^fx$|^fb$/.test(service)) return true;
  const call = String(row.call || '').toUpperCase();
  return Boolean(call) && !/-D?TV$|-D?T$|-CDT$|-EDT$|-TT[VA]?$|-TV[LA]?$|-DTA$/.test(call);
}

async function readCache(env, service) {
  if (!env.FCC_CACHE) return null;
  return env.FCC_CACHE.get(`${CACHE_PREFIX}${service}`, 'json');
}

async function buildResponse(env, service, call) {
  let cached = await readCache(env, service);
  if (!cached || !Array.isArray(cached.data)) return null;

  let data = cached.data;
  if (call) {
    data = data.filter(row => callMatches(row, call));
  } else {
    data = recentRows(data);
  }

  return {
    ...cached,
    data,
    service,
    result_scope: call ? 'full cached FCC download for call-sign search' : 'FCC filings dated within the last two years'
  };
}

async function radioFallback(env, call) {
  const cached = await readCache(env, 'all');
  if (!cached || !Array.isArray(cached.data)) return null;
  let data = cached.data.filter(looksLikeRadio);
  data = call ? data.filter(row => callMatches(row, call)) : recentRows(data);
  return {
    ...cached,
    data,
    service: 'radio',
    fallback: true,
    fallback_note: 'Derived from the combined FCC cache while service metadata is normalized.',
    result_scope: call ? 'full cached FCC download for call-sign search' : 'FCC filings dated within the last two years'
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/fcc-ownership-transactions') {
      return Response.redirect(new URL('/?page=transactions', request.url).toString(), 302);
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname !== '/api/fcc/transactions') return new Response('Not found', { status: 404 });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

    const requested = url.searchParams.get('service');
    const service = ['radio', 'television', 'all', 'debug'].includes(requested) ? requested : 'radio';
    const call = String(url.searchParams.get('call') || '').trim().toLowerCase();

    if (service === 'debug') {
      const debug = await readCache(env, 'debug');
      return debug
        ? Response.json(debug, { headers: JSON_HEADERS })
        : Response.json({ connected: false, service: 'debug' }, { status: 503, headers: JSON_HEADERS });
    }

    if (service === 'all' && call) {
      const [radio, television] = await Promise.all([
        buildResponse(env, 'radio', call),
        buildResponse(env, 'television', call)
      ]);
      const sources = [radio, television].filter(Boolean);
      if (sources.length) {
        const data = sources.flatMap(source => source.data || []);
        return Response.json({
          connected: true,
          service: 'all',
          data,
          result_scope: 'full cached FCC download for call-sign search'
        }, { headers: JSON_HEADERS });
      }
    }

    const result = await buildResponse(env, service, call);
    if (result) return Response.json(result, { headers: JSON_HEADERS });

    if (service === 'radio') {
      const fallback = await radioFallback(env, call);
      if (fallback) return Response.json(fallback, { headers: JSON_HEADERS });
    }

    return Response.json({
      data: [],
      connected: false,
      service,
      error: 'FCC data cache has not been populated yet'
    }, { status: 503, headers: JSON_HEADERS });
  }
};
