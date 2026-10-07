// TRING market data proxy: Twelve Data with a shared cache.
// Secret: TWELVE_DATA_API_KEY
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

function ttlSeconds(path: string, params: Record<string, string>) {
  if (path === 'quote') return 5 * 60;
  return params.interval === '1month' ? 12 * 3600 : 6 * 3600;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    // The Twelve Data key is shared by every invited user (results are cached for everyone)
    await requireUser(req);
    const { path, params = {} } = await req.json().catch(() => ({}));

    if (path !== 'quote' && path !== 'time_series') throw new HttpError(400, 'Unsupported request.');
    if (!SYMBOL.test(params.symbol || '')) throw new HttpError(400, 'Invalid symbol.');
    const clean: Record<string, string> = { symbol: String(params.symbol).toUpperCase() };
    if (path === 'time_series') {
      if (!['1day', '1month'].includes(params.interval)) throw new HttpError(400, 'Invalid interval.');
      clean.interval = params.interval;
      clean.outputsize = String(Math.min(5000, Math.max(1, parseInt(params.outputsize, 10) || 200)));
    }

    const key = `${path}:${JSON.stringify(clean)}`;
    const { data: cached } = await admin.from('market_cache').select('data, fetched_at').eq('key', key).maybeSingle();
    const age = cached ? (Date.now() - new Date(cached.fetched_at).getTime()) / 1000 : Infinity;
    if (cached && age < ttlSeconds(path, clean)) return json(cached.data);

    const apiKey = Deno.env.get('TWELVE_DATA_API_KEY');
    if (!apiKey) throw new HttpError(503, 'Market data is not configured on the server.');
    const url = new URL(`https://api.twelvedata.com/${path}`);
    Object.entries({ ...clean, apikey: apiKey }).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.status === 'error') {
      // Rate limited or temporary failure: serve stale data rather than nothing
      if (cached) return json(cached.data);
      throw new HttpError(502, data.message || `Twelve Data error (HTTP ${res.status})`);
    }
    await admin.from('market_cache').upsert({ key, data, fetched_at: new Date().toISOString() });
    return json(data);
  } catch (e) {
    return json({ error: (e as Error).message }, (e as HttpError).status || 500);
  }
});
