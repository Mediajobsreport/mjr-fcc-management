const CACHE_PREFIX = 'fcc:transactions:';
const JSON_HEADERS = { 'Cache-Control': 'public, max-age=900', 'Access-Control-Allow-Origin': '*' };
const STATION_SEARCH_URL = 'https://www.mediajobsreport.com/station-search';

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

function transactionMatches(row, query) {
  if (!query) return true;
  const searchable = [
    row.call, row.seller, row.buyer, row.parties, row.licensee,
    row.applicant, row.assignee, row.assignor, row.file
  ];
  return searchable.some(value => String(value ?? '').toLowerCase().includes(query));
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

async function buildResponse(env, service, query) {
  let cached = await readCache(env, service);
  if (!cached || !Array.isArray(cached.data)) return null;

  let data = cached.data;
  if (query) {
    data = data.filter(row => transactionMatches(row, query));
  } else {
    data = recentRows(data);
  }

  return {
    ...cached,
    data,
    service,
    result_scope: query ? 'full cached FCC download for call-sign or party-name search' : 'FCC filings dated within the last two years'
  };
}

async function radioFallback(env, query) {
  const cached = await readCache(env, 'all');
  if (!cached || !Array.isArray(cached.data)) return null;
  let data = cached.data.filter(looksLikeRadio);
  data = query ? data.filter(row => transactionMatches(row, query)) : recentRows(data);
  return {
    ...cached,
    data,
    service: 'radio',
    fallback: true,
    fallback_note: 'Derived from the combined FCC cache while service metadata is normalized.',
    result_scope: query ? 'full cached FCC download for call-sign or party-name search' : 'FCC filings dated within the last two years'
  };
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x2F;/gi, '/').replace(/&#x27;/gi, "'");
}

function textOnly(value) {
  return decodeHtml(String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function stationField(card, label) {
  const pattern = new RegExp(`<dt[^>]*>\\s*${label}\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`, 'i');
  return textOnly(card.match(pattern)?.[1] || '');
}

function parseStationCards(html) {
  const cards = [...String(html).matchAll(/<article[^>]*class=["'][^"']*mjr-station-card[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi)].map(match => match[1]);
  return cards.map(card => {
    const title = textOnly(card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] || '');
    const location = textOnly(card.match(/class=["'][^"']*mjr-station-location[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] || '');
    const service = textOnly(card.match(/class=["'][^"']*mjr-station-badge[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] || '');
    const fccLink = card.match(/href=["'](https?:\/\/publicfiles\.fcc\.gov\/[^"']+)["']/i)?.[1] || '';
    return {
      call: title,
      location,
      city: location.split(',')[0]?.trim() || '',
      state: location.split(',').slice(-1)[0]?.trim() || '',
      service,
      frequency: stationField(card, 'Frequency'),
      facilityId: stationField(card, 'FCC Facility ID'),
      licensee: stationField(card, 'Licensee'),
      status: stationField(card, 'Status'),
      expiration: stationField(card, 'License Expires'),
      fccLink
    };
  }).filter(row => row.call);
}

function calendarText(events) {
  const escape = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\\r?\\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Media Jobs Report//FCC Management Dashboard//EN'];
  for (const event of Array.isArray(events) ? events.slice(0, 20) : []) {
    if (!event?.title || !event?.date) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${String(event.title).replace(/[^a-z0-9]/gi, '')}-${event.date}@mediajobsreport.com`,
      `DTSTART;VALUE=DATE:${String(event.date).replaceAll('-', '')}`,
      `SUMMARY:${escape(event.title)}`,
      `DESCRIPTION:${escape(event.note || 'Verify with the FCC before acting.')}`,
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\\r\\n');
}

async function stationResponse(call) {
  const query = new URLSearchParams({
    mjr_station_search: '1',
    mjr_station_page: '1',
    mjr_station_q: call,
    mjr_station_city: '',
    mjr_station_state: '',
    mjr_station_service: 'ALL',
    mjr_station_sort: 'callsign',
    mjr_station_per_page: '50'
  });
  const response = await fetch(`${STATION_SEARCH_URL}?${query.toString()}`, {
    headers: { Accept: 'text/html', 'User-Agent': 'MJR FCC Management station profile lookup' }
  });
  if (!response.ok) return { data: [], connected: false, error: `Station database returned HTTP ${response.status}` };
  const html = await response.text();
  const data = parseStationCards(html);
  return { data, connected: true, source: 'MJR monthly FCC station database', query: call, result_scope: 'station profile lookup' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/fcc-ownership-transactions') {
      return Response.redirect(new URL('/?page=transactions', request.url).toString(), 302);
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

    if (url.pathname === '/api/fcc/calendar') {
      let events = [];
      try { events = JSON.parse(url.searchParams.get('events') || '[]'); } catch {}
      const body = calendarText(events);
      return new Response(body, {
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'attachment; filename="mjr-fcc-management-reminders.ics"',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    if (url.pathname === '/api/fcc/station') {
      const call = String(url.searchParams.get('call') || '').trim();
      if (!call) return Response.json({ data: [], connected: false, error: 'Call sign is required' }, { status: 400, headers: JSON_HEADERS });
      const result = await stationResponse(call);
      return Response.json(result, { status: result.connected ? 200 : 503, headers: JSON_HEADERS });
    }

    if (url.pathname !== '/api/fcc/transactions') return new Response('Not found', { status: 404 });

    const requested = url.searchParams.get('service');
    const service = ['radio', 'television', 'all', 'debug'].includes(requested) ? requested : 'radio';
    const query = String(url.searchParams.get('search') || url.searchParams.get('call') || '').trim().toLowerCase();

    if (service === 'debug') {
      const debug = await readCache(env, 'debug');
      return debug
        ? Response.json(debug, { headers: JSON_HEADERS })
        : Response.json({ connected: false, service: 'debug' }, { status: 503, headers: JSON_HEADERS });
    }

    if (service === 'all' && query) {
      const [radio, television] = await Promise.all([
        buildResponse(env, 'radio', query),
        buildResponse(env, 'television', query)
      ]);
      const sources = [radio, television].filter(Boolean);
      if (sources.length) {
        const data = sources.flatMap(source => source.data || []);
        return Response.json({
          connected: true,
          service: 'all',
          data,
          result_scope: 'full cached FCC download for call-sign or party-name search'
        }, { headers: JSON_HEADERS });
      }
    }

    const result = await buildResponse(env, service, query);
    if (result) return Response.json(result, { headers: JSON_HEADERS });

    if (service === 'radio') {
      const fallback = await radioFallback(env, query);
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
