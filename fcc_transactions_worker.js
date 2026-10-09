// MJR FCC transaction adapter
// Deploy as /api/fcc/transactions. Set FCC_LMS_TRANSACTIONS_URL to an approved
// FCC LMS export or an MJR-controlled normalized feed. Bind a KV namespace as
// FCC_CACHE for scheduled refresh and low-volume public reads.

const ALIASES = {
  call: ['callsign','call sign','station','station callsign'], city: ['city','community','station city'],
  state: ['state','state code'], service: ['service','service code','facility type'],
  file: ['file number','filenumber','application number','app number','id'],
  type: ['purpose','transaction type','application purpose','form'], seller: ['assignor','seller','transferor','licensee'],
  buyer: ['assignee','buyer','transferee','applicant'], status: ['status','application status'],
  filed: ['date filed','filed date','filing date'], statusDate: ['status date','action date']
};
const CACHE_PREFIX = 'fcc:transactions:';

function key(value) { return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''); }
function value(row, names) { const found = Object.keys(row).find(k => names.map(key).includes(key(k))); return found ? String(row[found] ?? '').trim() : ''; }
function normalize(row) {
  const record = Object.fromEntries(Object.entries(ALIASES).map(([name, names]) => [name, value(row, names)]));
  record.review = !record.file || !record.call || !record.status || !record.statusDate;
  record.isTransaction = /assign|transfer|sale|control/i.test(`${record.type} ${record.status}`);
  return record;
}
function matchesService(row, service) {
  if (!service || service === 'all') return true;
  const text = row.service.toLowerCase();
  if (service === 'television') return /tv|television|class ?a|lptv/.test(text);
  return /am|fm|radio|translator|lpfm/.test(text);
}
function parseCsv(text) {
  const rows = [], current = []; let cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (c === '"' && quoted && next === '"') { cell += '"'; i++; continue; }
    if (c === '"') { quoted = !quoted; continue; }
    if (c === ',' && !quoted) { current.push(cell); cell = ''; continue; }
    if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && next === '\n') i++; current.push(cell); cell = ''; if (current.some(Boolean)) rows.push(current.splice(0)); continue; }
    cell += c;
  }
  if (cell || current.length) { current.push(cell); rows.push(current.splice(0)); }
  const headers = (rows.shift() || []).map(x => x.trim());
  return rows.map(row => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ''])));
}
async function getRows(response) {
  const type = response.headers.get('content-type') || '', text = await response.text();
  if (type.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('[')) { const data = JSON.parse(text); return Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : []); }
  return parseCsv(text);
}
async function fetchDataset(env) {
  if (!env.FCC_LMS_TRANSACTIONS_URL) throw new Error('FCC_LMS_TRANSACTIONS_URL is not configured');
  const upstream = await fetch(env.FCC_LMS_TRANSACTIONS_URL, { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!upstream.ok) throw new Error(`FCC source returned HTTP ${upstream.status}`);
  const rows = (await getRows(upstream)).map(normalize).filter(row => row.isTransaction);
  return { fetched_at: new Date().toISOString(), source: 'FCC LMS export', all: rows, radio: rows.filter(row => matchesService(row, 'radio')), television: rows.filter(row => matchesService(row, 'television')) };
}
async function cacheDataset(env, dataset) {
  if (!env.FCC_CACHE) return;
  await Promise.all(['all', 'radio', 'television'].map(service => env.FCC_CACHE.put(`${CACHE_PREFIX}${service}`, JSON.stringify({ data: dataset[service], connected: true, service, source: dataset.source, fetched_at: dataset.fetched_at, review_count: dataset[service].filter(row => row.review).length }), { expirationTtl: 172800 })));
}
async function responseFromCache(env, service) {
  if (!env.FCC_CACHE) return null;
  const cached = await env.FCC_CACHE.get(`${CACHE_PREFIX}${service}`, 'json');
  return cached ? Response.json(cached, { headers: { 'Cache-Control': 'public, max-age=900' } }) : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/fcc/transactions') return new Response('Not found', { status: 404 });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const requested = url.searchParams.get('service');
    const service = ['radio', 'television', 'all'].includes(requested) ? requested : 'radio';
    try {
      const cached = await responseFromCache(env, service); if (cached) return cached;
      const dataset = await fetchDataset(env); await cacheDataset(env, dataset);
      const rows = dataset[service];
      return Response.json({ data: rows, connected: true, service, source: dataset.source, fetched_at: dataset.fetched_at, review_count: rows.filter(row => row.review).length }, { headers: { 'Cache-Control': 'public, max-age=900' } });
    } catch (error) { return Response.json({ data: [], connected: false, service, error: error.message }, { status: 502 }); }
  },
  async scheduled(controller, env) {
    try { const dataset = await fetchDataset(env); await cacheDataset(env, dataset); console.log(`FCC refresh completed at ${dataset.fetched_at}`); }
    catch (error) { console.error(`FCC refresh failed: ${error.message}`); }
  }
};
