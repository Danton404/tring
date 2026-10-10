// Market data: Twelve Data (US stocks, ETFs, gold, FX), CoinGecko (crypto, no key) and,
// through the server, Yahoo Finance for European listings Twelve Data's free plan doesn't cover.
import { store } from './store.js';
import { hosted, callFn } from './cloud.js';

const CACHE_KEY = 'tring.market.v1';
// Quotes refresh every 15 minutes: a dozen holdings would otherwise exceed Twelve Data's 800 free credits/day
const TTL = { quote: 15 * 60e3, ath: 12 * 3600e3, series: 6 * 3600e3 };

const cache = (() => {
  try { return { quotes: {}, ath: {}, series: {}, fx: {}, logos: {}, ...JSON.parse(localStorage.getItem(CACHE_KEY)) }; }
  catch { return { quotes: {}, ath: {}, series: {}, fx: {}, logos: {} }; }
})();
const persist = () => {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* ignore */ }
};

const errors = {};
const loading = new Set();
const stale = (entry, ttl) => !entry || Date.now() - entry.ts > ttl;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

export const quote = (id) => cache.quotes[id] || null;
export const logo = (id) => cache.logos?.[id] || null;
export const ath = (id) => cache.ath[id] || null;
export const error = (id) => errors[id] || null;
export const isLoading = (id) => loading.has(id);

// ---------- Twelve Data (free tier: 8 credits per minute, 800 per day)

const recent = [];
async function twelveSlot() {
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0] > 60e3) recent.shift();
    if (recent.length < 8) { recent.push(now); return; }
    await sleep(60e3 - (now - recent[0]) + 250);
  }
}

async function twelve(path, params) {
  await twelveSlot();
  // Shared mode: the server's Twelve Data key serves every invited user, with a shared cache
  if (hosted) return callFn('market', { path, params });
  const key = store.settings.twelveKey;
  if (!key) throw new Error('Add a Twelve Data API key in Settings.');
  const url = new URL(`https://api.twelvedata.com/${path}`);
  Object.entries({ ...params, apikey: key }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === 'error') throw new Error(data.message || `Twelve Data error (HTTP ${res.status})`);
  return data;
}

async function refreshTwelve(a, force) {
  if (force || stale(cache.quotes[a.id], TTL.quote)) {
    const d = await twelve('quote', { symbol: a.symbol });
    cache.quotes[a.id] = {
      price: +d.close,
      change: +d.change,
      changePct: +d.percent_change,
      high52: d.fifty_two_week ? +d.fifty_two_week.high : null,
      low52: d.fifty_two_week ? +d.fifty_two_week.low : null,
      ts: Date.now(),
    };
  }
  if (stale(cache.ath[a.id], TTL.ath)) {
    // Monthly bars cover the full history in one call; the max monthly high is the all-time high.
    const s = await twelve('time_series', { symbol: a.symbol, interval: '1month', outputsize: 5000 });
    let best = null;
    for (const v of s.values || []) {
      const hi = +v.high;
      if (!best || hi > best.ath) best = { ath: hi, athDate: v.datetime.slice(0, 10) };
    }
    if (best) cache.ath[a.id] = { ...best, ts: Date.now() };
  }
  bumpAth(a.id);
}

// A new high between ATH refreshes should count immediately.
function bumpAth(id) {
  const p = cache.quotes[id]?.price;
  const at = cache.ath[id];
  if (p && at && p > at.ath) cache.ath[id] = { ...at, ath: p, athDate: today() };
}

export async function lookupTwelve(symbol) {
  const d = await twelve('quote', { symbol });
  return { name: d.name, symbol: d.symbol };
}

// ---------- Yahoo Finance (server only: Yahoo blocks browser requests)

async function yahoo(path, params) {
  if (!hosted) throw new Error('European prices need shared mode (signed in to TRING).');
  return callFn('market', { path, params });
}
// { meta: { price, prevClose, currency, high52, low52 }, points: [{ t, high, close }] }
const yahooChart = (symbol, range, interval) => yahoo('yahoo_chart', { symbol, range, interval });

async function refreshYahoo(a, force) {
  if (force || stale(cache.quotes[a.id], TTL.quote)) {
    const { meta } = await yahooChart(a.yahoo, '5d', '1d');
    cache.quotes[a.id] = {
      price: meta.price,
      change: meta.prevClose ? meta.price - meta.prevClose : null,
      changePct: meta.prevClose ? (meta.price / meta.prevClose - 1) * 100 : null,
      high52: meta.high52,
      low52: meta.low52,
      ts: Date.now(),
    };
  }
  if (stale(cache.ath[a.id], TTL.ath)) {
    const { points } = await yahooChart(a.yahoo, 'max', '1mo');
    let best = null;
    for (const p of points) if (p.high && (!best || p.high > best.ath)) best = { ath: p.high, athDate: new Date(p.t * 1000).toISOString().slice(0, 10) };
    // Some listings (e.g. Stuttgart ISIN quotes) have no history; fall back to the current price
    cache.ath[a.id] = best ? { ...best, ts: Date.now() } : { ath: cache.quotes[a.id]?.price, athDate: today(), partial: true, ts: Date.now() };
  }
  bumpAth(a.id);
}

const US_EXCHANGES = new Set(['NMS', 'NYQ', 'NGM', 'NCM', 'ASE', 'PCX', 'BTS', 'NYS', 'NAS']);
const EUR_SUFFIXES = ['.DE', '.AS', '.PA', '.MI', '.F', '.BR', '.MC', '.VI', '.LS'];

// Finds a price source for an ISIN. US listings use Twelve Data (free); everything else uses a
// Yahoo EUR listing, checked against a recent EUR trade price so we never pick the wrong instrument.
export async function resolveIsin({ isin, tickers, refPriceEur, yahooOnly = false }) {
  const { quotes = [] } = await yahoo('yahoo_search', { q: isin });
  const us = quotes.find((q) => US_EXCHANGES.has(q.exchange) && !q.symbol.includes('.'));
  if (us) return yahooOnly ? { source: 'yahoo', symbol: us.symbol, yahoo: us.symbol, currency: 'USD' } : { source: 'twelve', symbol: us.symbol, currency: 'USD' };

  const plausible = (p) => !refPriceEur || (p > refPriceEur * 0.5 && p < refPriceEur * 2);
  const candidates = [
    ...tickers.map((t) => `${t}.DE`),
    ...quotes.map((q) => q.symbol).filter((s) => EUR_SUFFIXES.some((x) => s.endsWith(x))),
    `${isin}.SG`,
  ];
  for (const sym of [...new Set(candidates)]) {
    try {
      const { meta } = await yahooChart(sym, '5d', '1d');
      if (meta.currency === 'EUR' && meta.price && plausible(meta.price)) return { source: 'yahoo', symbol: sym, yahoo: sym, currency: 'EUR' };
    } catch { /* try the next listing */ }
  }
  // Last resort: a listing in another currency (e.g. Cameco only on Toronto, in CAD), converted with live FX
  for (const q of quotes) {
    try {
      const { meta } = await yahooChart(q.symbol, '5d', '1d');
      const ccy = meta.currency;
      if (!meta.price || !/^[A-Z]{3}$/.test(ccy || '')) continue; // skips minor units such as GBp
      const rate = ccy === 'EUR' ? 1 : (await yahooChart(`EUR${ccy}=X`, '5d', '1d')).meta.price;
      if (rate && plausible(meta.price / rate)) return { source: 'yahoo', symbol: q.symbol, yahoo: q.symbol, currency: ccy };
    } catch { /* try the next listing */ }
  }
  return null;
}

// Daily closes for the history chart and exposure: { ccy, points: [{ date, v }] }, shared per session
const dailyMemo = new Map();
export function dailyHistory(symbol) {
  if (!dailyMemo.has(symbol)) {
    const p = fetchDaily(symbol);
    dailyMemo.set(symbol, p);
    p.catch(() => dailyMemo.delete(symbol));
  }
  return dailyMemo.get(symbol);
}
async function fetchDaily(symbol) {
  const { meta, points } = await yahooChart(symbol, '5y', '1d');
  // London quotes in pence
  const pence = meta.currency === 'GBp' || meta.currency === 'GBX';
  return {
    ccy: pence ? 'GBP' : meta.currency,
    points: points.filter((p) => p.close).map((p) => ({ date: new Date(p.t * 1000).toISOString().slice(0, 10), v: pence ? p.close / 100 : p.close })),
  };
}

// ---------- FX (Twelve Data forex is free)

// Units of `base` per 1 unit of `ccy`, e.g. fxRate('USD', 'EUR') ~ 0.86
export function fxRate(ccy, base) {
  if (!ccy || !base || ccy === base) return 1;
  const r = cache.fx[`${base}/${ccy}`];
  return r ? 1 / r.rate : null;
}

async function refreshFx(currencies, base, force) {
  for (const ccy of currencies) {
    if (ccy === base) continue;
    const pair = `${base}/${ccy}`;
    if (!force && !stale(cache.fx[pair], TTL.quote)) continue;
    const d = await twelve('quote', { symbol: pair });
    cache.fx[pair] = { rate: +d.close, ts: Date.now() };
  }
}

// Daily `${base}/${ccy}` closes keyed by date, for converting historical trades
export async function fxHistory(base, ccy, days = 1200) {
  const d = await twelve('time_series', { symbol: `${base}/${ccy}`, interval: '1day', outputsize: Math.min(days, 5000) });
  return Object.fromEntries((d.values || []).map((v) => [v.datetime.slice(0, 10), +v.close]));
}

// ---------- CoinGecko (public API, no key)

async function gecko(path, params = {}) {
  const url = new URL(`https://api.coingecko.com/api/v3/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  if (res.status === 429) throw new Error('CoinGecko rate limit reached. Try again in a minute.');
  if (!res.ok) throw new Error(`CoinGecko error (HTTP ${res.status})`);
  return res.json();
}

async function refreshCrypto(list, force) {
  if (!force && list.every((a) => !stale(cache.quotes[a.id], TTL.quote))) return;
  const rows = await gecko('coins/markets', { vs_currency: 'usd', ids: list.map((a) => a.cgId).join(',') });
  const now = Date.now();
  for (const a of list) {
    const r = rows.find((x) => x.id === a.cgId);
    if (!r) { errors[a.id] = `CoinGecko has no data for "${a.cgId}".`; continue; }
    cache.quotes[a.id] = {
      price: r.current_price,
      change: r.price_change_24h,
      changePct: r.price_change_percentage_24h,
      high52: null,
      low52: null,
      ts: now,
    };
    cache.ath[a.id] = { ath: r.ath, athDate: (r.ath_date || '').slice(0, 10), ts: now };
    if (r.image) (cache.logos ||= {})[a.id] = r.image.replace('/large/', '/small/');
    bumpAth(a.id);
  }
}

export async function searchCrypto(query) {
  const d = await gecko('search', { query });
  return (d.coins || []).slice(0, 6).map((c) => ({ id: c.id, name: c.name, symbol: c.symbol }));
}

// ---------- Public refresh

async function run(list, fn, onUpdate) {
  list.forEach((a) => loading.add(a.id));
  try {
    await fn();
    list.forEach((a) => { if (cache.quotes[a.id]) delete errors[a.id]; });
  } catch (e) {
    list.forEach((a) => { errors[a.id] = e.message; });
  } finally {
    list.forEach((a) => loading.delete(a.id));
    persist();
    onUpdate?.();
  }
}

export async function refreshAll(assets, { force = false, onUpdate, base = 'USD' } = {}) {
  assets = assets.filter((a) => !a.archived);
  const crypto = assets.filter((a) => a.source === 'coingecko');
  const currencies = new Set(assets.map((a) => a.currency || 'USD'));
  const jobs = [refreshFx(currencies, base, force).catch(() => {}).finally(() => { persist(); onUpdate?.(); })];
  if (crypto.length) jobs.push(run(crypto, () => refreshCrypto(crypto, force), onUpdate));
  for (const a of assets.filter((x) => x.source === 'twelve')) jobs.push(run([a], () => refreshTwelve(a, force), onUpdate));
  for (const a of assets.filter((x) => x.source === 'yahoo')) jobs.push(run([a], () => refreshYahoo(a, force), onUpdate));
  await Promise.allSettled(jobs);
}

// Yahoo symbol for an asset's price history
export function historySymbol(a) {
  if (a.yahoo) return a.yahoo;
  if (a.histSymbol) return a.histSymbol;
  if (a.source === 'coingecko') return `${a.symbol}-USD`;
  if (a.source === 'twelve') return a.symbol === 'XAU/USD' ? 'GC=F' : a.symbol.replace('/', '') + (a.symbol.includes('/') ? '=X' : '');
  return null;
}

const toPoints = (pts) => pts.filter((x) => x.close).map((x) => ({ date: new Date(x.t * 1000).toISOString().slice(0, 10), close: x.close }));

// Daily closes, oldest first: [{ date, close }]
export async function getSeries(asset, days = 365) {
  const hit = cache.series[asset.id];
  if (hit && !stale(hit, TTL.series)) return hit.points;
  let points;
  if (asset.source === 'coingecko') {
    const d = await gecko(`coins/${asset.cgId}/market_chart`, { vs_currency: 'usd', days, interval: 'daily' });
    points = (d.prices || []).map(([t, p]) => ({ date: new Date(t).toISOString().slice(0, 10), close: p }));
  } else if (asset.source === 'yahoo' || asset.histSymbol) {
    const { points: p } = await yahooChart(asset.yahoo || asset.histSymbol, '1y', '1d');
    points = toPoints(p).slice(-days);
  } else if (asset.source === 'twelve') {
    const d = await twelve('time_series', { symbol: asset.symbol, interval: '1day', outputsize: days });
    points = (d.values || []).map((v) => ({ date: v.datetime.slice(0, 10), close: +v.close })).reverse();
  } else throw new Error('No price history for this listing.');
  cache.series[asset.id] = { points, ts: Date.now() };
  persist();
  return points;
}

// Longer history for the detail chart: '5y' (daily) or 'max' (weekly). Kept in memory only, it's large.
const longMemo = new Map();
export function getLongSeries(asset, range) {
  const k = `${asset.id}:${range}`;
  if (!longMemo.has(k)) {
    const p = fetchLong(asset, range);
    longMemo.set(k, p);
    p.catch(() => longMemo.delete(k));
  }
  return longMemo.get(k);
}
async function fetchLong(asset, range) {
  const sym = historySymbol(asset);
  if (hosted && sym) {
    const { meta, points } = await yahooChart(sym, range, range === 'max' ? '1wk' : '1d');
    const pence = meta.currency === 'GBp' || meta.currency === 'GBX';
    return toPoints(points).map((p) => (pence ? { ...p, close: p.close / 100 } : p));
  }
  if (asset.source === 'twelve') {
    const d = await twelve('time_series', { symbol: asset.symbol, interval: '1day', outputsize: 5000 });
    const pts = (d.values || []).map((v) => ({ date: v.datetime.slice(0, 10), close: +v.close })).reverse();
    return range === '5y' ? pts.slice(-1265) : pts;
  }
  if (asset.source === 'coingecko') {
    // The free CoinGecko API may refuse more than a year; fall back to what it allows
    const d = await gecko(`coins/${asset.cgId}/market_chart`, { vs_currency: 'usd', days: range === '5y' ? 1826 : 'max', interval: 'daily' }).catch(() => null);
    if (d) return (d.prices || []).map(([t, p]) => ({ date: new Date(t).toISOString().slice(0, 10), close: p }));
  }
  return getSeries(asset, 365);
}

// ---------- Instrument search (by name or ticker)

const YAHOO_KINDS = { EQUITY: 'stock', ETF: 'etf', INDEX: 'index', FUTURE: 'commodity', CURRENCY: 'fx', MUTUALFUND: 'etf' };

// [{ key, name, symbol, kind, where, pick }]; pick() resolves to a new asset object (no id yet)
export async function searchInstruments(q) {
  q = q.trim();
  if (q.length < 2) return [];
  const jobs = [
    searchCrypto(q).then((coins) => coins.slice(0, 3).map((c) => ({
      key: `cg:${c.id}`, name: c.name, symbol: c.symbol.toUpperCase(), kind: 'crypto', where: 'Crypto',
      pick: async () => ({ name: c.name, symbol: c.symbol.toUpperCase(), kind: 'crypto', source: 'coingecko', cgId: c.id }),
    }))).catch(() => []),
  ];
  if (hosted) {
    jobs.push(yahoo('yahoo_search', { q }).then(({ quotes = [] }) => quotes
      .filter((x) => YAHOO_KINDS[x.type] && x.symbol)
      .slice(0, 8)
      .map((x) => {
        const kind = YAHOO_KINDS[x.type];
        const us = US_EXCHANGES.has(x.exchange) && !/[.=^]/.test(x.symbol) && (kind === 'stock' || kind === 'etf');
        return {
          key: us ? `td:${x.symbol}` : `y:${x.symbol}`, name: x.name || x.symbol, symbol: x.symbol, kind, where: x.exch || x.exchange || '',
          pick: async () => {
            if (us) return { name: x.name || x.symbol, symbol: x.symbol, kind, source: 'twelve', currency: 'USD' };
            const { meta } = await yahooChart(x.symbol, '5d', '1d');
            if (!/^[A-Z]{3}$/.test(meta.currency || '')) throw new Error(`${x.symbol} is quoted in ${meta.currency || 'an unknown currency'}. Pick another listing.`);
            return { name: x.name || x.symbol, symbol: x.symbol, kind, source: 'yahoo', yahoo: x.symbol, currency: meta.currency };
          },
        };
      })).catch(() => []));
  } else if (store.settings.twelveKey) {
    jobs.push(twelve('symbol_search', { symbol: q, outputsize: 10 }).then((d) => (d.data || [])
      .filter((x) => x.country === 'United States')
      .slice(0, 6)
      .map((x) => ({
        key: `td:${x.symbol}`, name: x.instrument_name, symbol: x.symbol, kind: /etf/i.test(x.instrument_type) ? 'etf' : 'stock', where: x.exchange,
        pick: async () => ({ name: x.instrument_name, symbol: x.symbol, kind: /etf/i.test(x.instrument_type) ? 'etf' : 'stock', source: 'twelve' }),
      }))).catch(() => []));
  }
  const [crypto, rest = []] = await Promise.all(jobs);
  // Listings first (Yahoo ranks them by relevance), then coins
  return [...rest, ...crypto];
}

export function forget(id) {
  delete cache.quotes[id];
  delete cache.ath[id];
  delete cache.series[id];
  delete errors[id];
  persist();
}
