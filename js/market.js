// Market data: Twelve Data (stocks, ETFs, indices, gold, FX) and CoinGecko (crypto, no key).
import { store } from './store.js';
import { hosted, callFn } from './cloud.js';

const CACHE_KEY = 'tring.market.v1';
const TTL = { quote: 5 * 60e3, ath: 12 * 3600e3, series: 6 * 3600e3 };

const cache = (() => {
  try { return { quotes: {}, ath: {}, series: {}, ...JSON.parse(localStorage.getItem(CACHE_KEY)) }; }
  catch { return { quotes: {}, ath: {}, series: {} }; }
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
  // Shared mode: the server holds the key and caches results for everyone
  if (hosted) return callFn('market', { path, params });
  const key = store.settings.twelveKey;
  if (!key) throw new Error('Add a Twelve Data API key in Settings.');
  await twelveSlot();
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

export async function refreshAll(assets, { force = false, onUpdate } = {}) {
  const crypto = assets.filter((a) => a.source === 'coingecko');
  const jobs = [];
  if (crypto.length) jobs.push(run(crypto, () => refreshCrypto(crypto, force), onUpdate));
  for (const a of assets.filter((x) => x.source === 'twelve')) jobs.push(run([a], () => refreshTwelve(a, force), onUpdate));
  await Promise.allSettled(jobs);
}

// Daily closes, oldest first: [{ date, close }]
export async function getSeries(asset, days = 200) {
  const hit = cache.series[asset.id];
  if (hit && !stale(hit, TTL.series)) return hit.points;
  let points;
  if (asset.source === 'coingecko') {
    const d = await gecko(`coins/${asset.cgId}/market_chart`, { vs_currency: 'usd', days, interval: 'daily' });
    points = (d.prices || []).map(([t, p]) => ({ date: new Date(t).toISOString().slice(0, 10), close: p }));
  } else {
    const d = await twelve('time_series', { symbol: asset.symbol, interval: '1day', outputsize: days });
    points = (d.values || []).map((v) => ({ date: v.datetime.slice(0, 10), close: +v.close })).reverse();
  }
  cache.series[asset.id] = { points, ts: Date.now() };
  persist();
  return points;
}

export function forget(id) {
  delete cache.quotes[id];
  delete cache.ath[id];
  delete cache.series[id];
  delete errors[id];
  persist();
}
