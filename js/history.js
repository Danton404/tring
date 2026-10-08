// Portfolio value over time, rebuilt from transactions and daily historical prices (Yahoo via the server).
import * as market from './market.js';

const DAY = 864e5;
const iso = (d) => new Date(d).toISOString().slice(0, 10);

// Last value at or before `date` in a date-sorted [{ date, v }] list
function at(series, date) {
  let lo = 0, hi = series.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) { best = series[mid].v; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// Yahoo symbol for an asset's price history
function historySymbol(a) {
  if (a.yahoo) return a.yahoo;
  if (a.histSymbol) return a.histSymbol;
  if (a.source === 'coingecko') return `${a.symbol}-USD`;
  if (a.source === 'twelve') return a.symbol === 'XAU/USD' ? 'GC=F' : a.symbol.replace('/', '') + (a.symbol.includes('/') ? '=X' : '');
  return null;
}

let memo = { key: null, promise: null };

/**
 * Daily points [{ date, value, invested, realized }] in the base currency (realized is cumulative).
 * remember(assetId, patch) stores history symbols found for closed holdings, so they're looked up once.
 */
export function portfolioHistory({ transactions, assets, base, livePrice, remember }) {
  const key = `d|${base}|${transactions.length}|${iso(Date.now())}`;
  if (memo.key === key) return memo.promise;
  memo = { key, promise: build({ transactions, assets, base, livePrice, remember }) };
  memo.promise.catch(() => { memo = { key: null, promise: null }; });
  return memo.promise;
}

async function build({ transactions, assets, base, livePrice, remember }) {
  const txs = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  if (!txs.length) return [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const ids = [...new Set(txs.map((t) => t.assetId))];

  // Trade prices (base currency) as a fallback where no market history exists
  const tradePx = new Map();
  for (const t of txs) if (t.price > 0) (tradePx.get(t.assetId) || tradePx.set(t.assetId, []).get(t.assetId)).push({ date: t.date, v: t.price });

  // Daily closes per asset, a few at a time
  const series = new Map(); // assetId -> { ccy, points }
  const queue = [...ids];
  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      const a = byId.get(id);
      if (!a) continue;
      let sym = historySymbol(a);
      if (!sym && a.isin) {
        try {
          const found = await market.resolveIsin({ isin: a.isin, tickers: [a.symbol], refPriceEur: base === 'EUR' ? a.lastPrice : null, yahooOnly: true });
          if (found?.yahoo) { sym = found.yahoo; remember?.(id, { histSymbol: sym }); }
        } catch { /* falls back to trade prices */ }
      }
      if (!sym) continue;
      try {
        const h = await market.dailyHistory(sym);
        if (h.points.length) series.set(id, h);
      } catch { /* falls back to trade prices */ }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));

  // Exchange rates for every currency involved
  const start = txs[0].date;
  const days = Math.ceil((Date.now() - new Date(start).getTime()) / DAY) + 15;
  const fx = new Map();
  for (const ccy of new Set([...series.values()].map((s) => s.ccy))) {
    if (ccy === base) continue;
    try {
      const rates = await market.fxHistory(base, ccy, days); // ccy per 1 base
      fx.set(ccy, Object.entries(rates).map(([date, r]) => ({ date, v: 1 / r })).sort((a, b) => a.date.localeCompare(b.date)));
    } catch { /* this currency's assets use trade prices */ }
  }

  const priceAt = (id, date) => {
    const s = series.get(id);
    if (s) {
      const p = at(s.points, date);
      const rate = s.ccy === base ? 1 : fx.has(s.ccy) ? at(fx.get(s.ccy), date) : null;
      if (p != null && rate != null) return p * rate;
    }
    return at(tradePx.get(id) || [], date);
  };

  // Replay trades day by day (average-cost, same rules as the holdings table)
  const pos = new Map();
  const out = [];
  let realized = 0;
  let i = 0;
  const today = iso(Date.now());
  const dates = [];
  for (let d = new Date(`${start}T00:00:00Z`); iso(d) < today; d = new Date(d.getTime() + DAY)) dates.push(iso(d));
  dates.push(today);

  for (const date of dates) {
    for (; i < txs.length && txs[i].date <= date; i++) {
      const t = txs[i];
      const p = pos.get(t.assetId) || { qty: 0, cost: 0 };
      if (t.type === 'split') p.qty = Math.max(0, p.qty + t.qty);
      else if (t.type === 'buy') { p.qty += t.qty; p.cost += t.qty * t.price + (+t.fee || 0); }
      else {
        const q = Math.min(t.qty, p.qty);
        const avg = p.qty ? p.cost / p.qty : 0;
        realized += q * t.price - (+t.fee || 0) - avg * q;
        p.cost -= avg * q;
        p.qty -= q;
      }
      if (p.qty < 1e-9) { p.qty = 0; p.cost = 0; }
      pos.set(t.assetId, p);
    }
    let value = 0, invested = 0;
    for (const [id, p] of pos) {
      if (!p.qty) continue;
      const px = date === today ? livePrice(id) ?? priceAt(id, date) : priceAt(id, date);
      value += p.qty * (px ?? 0);
      invested += p.cost;
    }
    out.push({ date, value, invested, realized });
  }
  return out;
}
