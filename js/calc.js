// Pure calculations: portfolio holdings, DCA plan schedule, technical indicators.
import { isTradingDay, nextTradingDay } from './calendar.js';

const sum = (arr, f = (x) => x) => arr.reduce((s, x) => s + f(x), 0);

// ---------- Holdings (average-cost method)

export function holdings(transactions, priceOf, athOf = () => null) {
  const by = new Map();
  const txs = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  for (const t of txs) {
    const h = by.get(t.assetId) || { assetId: t.assetId, qty: 0, cost: 0, realized: 0, deposited: 0 };
    const fee = +t.fee || 0;
    if (t.type === 'split') {
      // Share count changes, cost basis doesn't (stock splits, spin-offs)
      h.qty = Math.max(0, h.qty + t.qty);
      if (h.qty < 1e-12) { h.qty = 0; h.cost = 0; }
    } else if (t.type === 'buy') {
      h.qty += t.qty;
      h.cost += t.qty * t.price + fee;
      h.deposited += t.qty * t.price + fee;
    } else {
      const avg = h.qty ? h.cost / h.qty : 0;
      const q = Math.min(t.qty, h.qty);
      h.cost -= avg * q;
      h.realized += q * t.price - fee - avg * q;
      h.qty -= q;
      if (h.qty < 1e-12) { h.qty = 0; h.cost = 0; }
    }
    by.set(t.assetId, h);
  }

  const rows = [...by.values()].map((h) => {
    const price = priceOf(h.assetId);
    const ath = athOf(h.assetId);
    const value = price != null ? h.qty * price : null;
    const pl = value != null ? value - h.cost : null;
    return {
      ...h,
      avg: h.qty ? h.cost / h.qty : 0,
      price,
      value,
      pl,
      plPct: pl != null && h.cost ? (pl / h.cost) * 100 : null,
      valueAtAth: ath != null ? h.qty * ath : null,
    };
  });

  const open = rows.filter((r) => r.qty > 0);
  const pricedRows = open.filter((r) => r.value != null);
  const totals = {
    // Cost and value cover the same priced holdings, so P/L stays meaningful while prices load
    cost: sum(pricedRows, (r) => r.cost),
    totalCost: sum(open, (r) => r.cost),
    unpriced: open.length - pricedRows.length,
    value: pricedRows.length ? sum(pricedRows, (r) => r.value) : null,
    realized: sum(rows, (r) => r.realized),
    deposited: sum(rows, (r) => r.deposited),
    valueAtAth: open.every((r) => r.valueAtAth != null) ? sum(open, (r) => r.valueAtAth) : null,
  };
  totals.pl = totals.value != null ? totals.value - totals.cost : null;
  totals.plPct = totals.pl != null && totals.cost ? (totals.pl / totals.cost) * 100 : null;
  return { rows, open, totals };
}

// ---------- DCA plan

export function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addMonths(d, n) {
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(d.getDate(), last));
  return r;
}

const STEP_DAYS = { daily: 1, weekly: 7, biweekly: 14 };

// Buy dates on trading days only: daily plans skip closed days, the others move to the next open day.
// markets: calendars of the plan's assets (see calendar.js); weekends are always skipped.
export function buyDates(plan, markets = []) {
  const value = Math.max(0, Math.floor(+plan.durationValue || 0));
  if (!value || !plan.startDate) return [];
  const start = parseISO(plan.startDate);
  const end = plan.durationUnit === 'months' ? addMonths(start, value) : new Date(start.getTime() + value * 7 * 864e5);
  const out = [];
  for (let k = 0; out.length < 1000; k++) {
    const d = plan.frequency === 'monthly'
      ? addMonths(start, k)
      : new Date(start.getFullYear(), start.getMonth(), start.getDate() + k * (STEP_DAYS[plan.frequency] || 7));
    if (d >= end) break;
    if (plan.frequency === 'daily') {
      if (isTradingDay(d, markets)) out.push(toISO(d));
      continue;
    }
    const s = toISO(nextTradingDay(d, markets));
    if (s !== out[out.length - 1]) out.push(s);
  }
  return out;
}

// targetOf(assetId, allocation) -> { method: 'target', price, target } (asset's own currency) or { method: 'cagr', cagr } (% a year).
// Both follow every scheduled buy through time up to the horizon (plan.horizonYears after the first buy):
// - CAGR: the price grows at the CAGR, so each buy compounds from its own date to the horizon.
// - Target: the price climbs at a steady rate from today's price to the target at the horizon, so later
//   buys cost more and get fewer units. Value at the horizon = units bought x target.
export function planSummary(plan, priceOf, { markets = [], targetOf = () => null, today = new Date() } = {}) {
  const dates = buyDates(plan, markets);
  const n = dates.length;
  const horizon = plan.startDate ? addMonths(parseISO(plan.startDate), Math.round(12 * (+plan.horizonYears || 5))) : null;
  const YEAR = 365.25 * 864e5;
  const years = dates.map((d) => (horizon ? Math.max(0, (horizon - parseISO(d)) / YEAR) : 0));
  // Share of the way from today to the horizon at each buy (0 = today's price, 1 = the target)
  const span = horizon ? Math.max(1, horizon - today) : 1;
  const along = dates.map((d) => Math.min(1, Math.max(0, (parseISO(d) - today) / span)));
  const perBuy = n ? (plan.mode === 'fixed' ? +plan.amount || 0 : (+plan.capital || 0) / n) : 0;
  const allocated = sum(plan.allocations, (a) => +a.pct || 0);
  const allocations = plan.allocations.map((al) => {
    const amount = (perBuy * (+al.pct || 0)) / 100;
    const price = priceOf(al.assetId);
    const total = amount * n;
    const t = targetOf(al.assetId, al) || {};
    const method = t.method === 'cagr' ? 'cagr' : 'target';
    let upside = null, atTarget = null;
    if (method === 'cagr') {
      if (t.cagr != null && isFinite(t.cagr) && t.cagr > -100 && total > 0) {
        atTarget = amount * sum(years, (y) => (1 + t.cagr / 100) ** y);
        upside = (atTarget / total - 1) * 100;
      }
    } else if (t.price > 0 && t.target > 0 && total > 0) {
      const ratio = t.target / t.price;
      // Each buy: amount / price on its date, worth `target` per unit at the horizon
      atTarget = amount * sum(along, (f) => ratio / ratio ** f);
      upside = (atTarget / total - 1) * 100;
    }
    return { ...al, method, amount, total, price, units: price ? amount / price : null, target: method === 'target' ? t.target ?? null : null, cagr: method === 'cagr' ? t.cagr ?? null : null, upside, atTarget, gain: atTarget != null ? atTarget - total : null };
  });
  const funded = allocations.filter((a) => a.total > 0);
  const priced = funded.filter((a) => a.atTarget != null);
  const pricedCost = sum(priced, (a) => a.total);
  const atTarget = priced.length ? sum(priced, (a) => a.atTarget) : null;
  return {
    dates, n, perBuy, total: perBuy * n, allocated, allocations, end: dates[n - 1] || null, horizon: horizon ? toISO(horizon) : null,
    atTarget, gain: atTarget != null ? atTarget - pricedCost : null, gainPct: atTarget != null && pricedCost ? (atTarget / pricedCost - 1) * 100 : null,
    missingTargets: funded.length - priced.length,
    covered: pricedCost,
  };
}

// ---------- Indicators from daily closes (oldest first)

export function indicators(points, { crypto = false } = {}) {
  const c = points.map((p) => p.close).filter((x) => x > 0);
  const n = c.length;
  if (n < 2) return null;
  const last = c[n - 1];
  // Lookbacks in bars: crypto trades every day, stocks ~21 sessions per month
  const L = crypto ? { w: 7, m: 30, q: 90, h: 180 } : { w: 5, m: 21, q: 63, h: 126 };
  const ret = (d) => (n > d ? (last / c[n - 1 - d] - 1) * 100 : null);
  const sma = (d) => (n >= d ? sum(c.slice(-d)) / d : null);

  let rsi = null;
  if (n > 15) {
    let g = 0, l = 0;
    for (let i = 1; i <= 14; i++) { const ch = c[i] - c[i - 1]; if (ch > 0) g += ch; else l -= ch; }
    g /= 14; l /= 14;
    for (let i = 15; i < n; i++) {
      const ch = c[i] - c[i - 1];
      g = (g * 13 + Math.max(ch, 0)) / 14;
      l = (l * 13 + Math.max(-ch, 0)) / 14;
    }
    rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }

  const lr = [];
  for (let i = Math.max(1, n - L.m); i < n; i++) lr.push(Math.log(c[i] / c[i - 1]));
  const mean = sum(lr) / lr.length;
  const sd = lr.length > 1 ? Math.sqrt(sum(lr, (x) => (x - mean) ** 2) / (lr.length - 1)) : 0;

  return {
    last,
    r1w: ret(L.w), r1m: ret(L.m), r3m: ret(L.q), r6m: ret(L.h),
    sma20: sma(20), sma50: sma(50), sma100: sma(100),
    rsi,
    vol1m: sd * Math.sqrt(crypto ? 365 : 252) * 100,
    high: Math.max(...c),
    low: Math.min(...c),
    bars: n,
  };
}
