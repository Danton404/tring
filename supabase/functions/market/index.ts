// TRING market data proxy with a shared cache: Twelve Data (US stocks, forex) and Yahoo Finance
// (European listings). Secret: TWELVE_DATA_API_KEY
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

async function requireUser(req: Request) {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) throw new HttpError(401, 'Not signed in.');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user?.email) throw new HttpError(401, 'Session expired. Sign in again.');
  const { data: ok } = await admin.from('allowed_emails').select('role').eq('email', data.user.email.toLowerCase()).maybeSingle();
  if (!ok) throw new HttpError(403, 'Your account does not have access yet.');
  return { ...data.user, owner: ok.role === 'owner' };
}

const SYMBOL = /^[A-Za-z0-9./:\-^=]{1,24}$/;
const RANGES = ['5d', '1y', '5y', 'max'];
const INTERVALS = ['1d', '1wk', '1mo'];

function ttlSeconds(path: string, params: Record<string, string>) {
  if (path === 'quote') return 15 * 60;
  if (path === 'yahoo_search') return 30 * 86400;
  if (path === 'yahoo_chart') return params.range === '5d' ? 15 * 60 : params.range === '1y' ? 6 * 3600 : 12 * 3600;
  return params.interval === '1month' ? 12 * 3600 : 6 * 3600;
}

function cleanParams(path: string, params: Record<string, string>) {
  if (path === 'yahoo_search') {
    if (!SYMBOL.test(params.q || '')) throw new HttpError(400, 'Invalid search.');
    return { q: String(params.q).toUpperCase() };
  }
  if (!SYMBOL.test(params.symbol || '')) throw new HttpError(400, 'Invalid symbol.');
  const clean: Record<string, string> = { symbol: String(params.symbol).toUpperCase() };
  if (path === 'yahoo_chart') {
    if (!RANGES.includes(params.range) || !INTERVALS.includes(params.interval)) throw new HttpError(400, 'Invalid range.');
    clean.range = params.range;
    clean.interval = params.interval;
  } else if (path === 'time_series') {
    if (!['1day', '1month'].includes(params.interval)) throw new HttpError(400, 'Invalid interval.');
    clean.interval = params.interval;
    clean.outputsize = String(Math.min(5000, Math.max(1, parseInt(params.outputsize, 10) || 200)));
  }
  return clean;
}

// Twelve Data (US stocks, forex). Throws on errors, including rate limits.
async function twelve(path: string, clean: Record<string, string>) {
  const apiKey = Deno.env.get('TWELVE_DATA_API_KEY');
  if (!apiKey) throw new HttpError(503, 'Market data is not configured on the server.');
  const url = new URL(`https://api.twelvedata.com/${path}`);
  Object.entries({ ...clean, apikey: apiKey }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === 'error') throw new HttpError(502, data.message || `Twelve Data error (HTTP ${res.status})`);
  return data;
}

// Yahoo Finance (unofficial, free): European listings Twelve Data's free plan doesn't cover.
const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', Accept: 'application/json' };

async function yahoo(path: string, clean: Record<string, string>) {
  if (path === 'yahoo_search') {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(clean.q)}&quotesCount=10&newsCount=0`;
    const res = await fetch(url, { headers: YAHOO_HEADERS });
    if (!res.ok) throw new HttpError(502, `Yahoo search error (HTTP ${res.status})`);
    const d = await res.json();
    // deno-lint-ignore no-explicit-any
    return { quotes: (d.quotes || []).map((q: any) => ({ symbol: q.symbol, exchange: q.exchange, name: q.shortname || q.longname, type: q.quoteType })) };
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean.symbol)}?range=${clean.range}&interval=${clean.interval}`;
  const res = await fetch(url, { headers: YAHOO_HEADERS });
  const d = await res.json().catch(() => ({}));
  const r = d.chart?.result?.[0];
  if (!res.ok || !r) throw new HttpError(res.status === 404 ? 404 : 502, d.chart?.error?.description || `Yahoo error (HTTP ${res.status})`);
  const m = r.meta || {};
  const q = r.indicators?.quote?.[0] || {};
  const ts: number[] = r.timestamp || [];
  return {
    meta: { price: m.regularMarketPrice, prevClose: m.chartPreviousClose ?? m.previousClose ?? null, currency: m.currency, high52: m.fiftyTwoWeekHigh ?? null, low52: m.fiftyTwoWeekLow ?? null },
    points: ts.map((t, i) => ({ t, high: q.high?.[i] ?? null, close: q.close?.[i] ?? null })),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    // Shared by every invited user; results are cached for everyone
    await requireUser(req);
    const { path, params = {} } = await req.json().catch(() => ({}));
    if (!['quote', 'time_series', 'yahoo_search', 'yahoo_chart'].includes(path)) throw new HttpError(400, 'Unsupported request.');
    const clean = cleanParams(path, params);

    const key = `${path}:${JSON.stringify(clean)}`;
    const { data: cached } = await admin.from('market_cache').select('data, fetched_at').eq('key', key).maybeSingle();
    const age = cached ? (Date.now() - new Date(cached.fetched_at).getTime()) / 1000 : Infinity;
    if (cached && age < ttlSeconds(path, clean)) return json(cached.data);

    let data;
    try {
      data = path.startsWith('yahoo') ? await yahoo(path, clean) : await twelve(path, clean);
    } catch (e) {
      // Rate limited or temporary failure: serve stale data rather than nothing
      if (cached && (e as HttpError).status !== 404) return json(cached.data);
      throw e;
    }
    await admin.from('market_cache').upsert({ key, data, fetched_at: new Date().toISOString() });
    return json(data);
  } catch (e) {
    return json({ error: (e as Error).message }, (e as HttpError).status || 500);
  }
});
