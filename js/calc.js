// Pure calculations: portfolio holdings, DCA plan schedule, technical indicators.

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

export function buyDates(plan) {
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
    if (plan.frequency === 'daily' && (d.getDay() === 0 || d.getDay() === 6)) continue;
    out.push(toISO(d));
  }
  return out;
}

export function planSummary(plan, priceOf) {
  const dates = buyDates(plan);
  const n = dates.length;
  const perBuy = n ? (plan.mode === 'fixed' ? +plan.amount || 0 : (+plan.capital || 0) / n) : 0;
  const allocated = sum(plan.allocations, (a) => +a.pct || 0);
  const allocations = plan.allocations.map((al) => {
    const amount = (perBuy * (+al.pct || 0)) / 100;
    const price = priceOf(al.assetId);
    return { ...al, amount, total: amount * n, price, units: price ? amount / price : null };
  });
  return { dates, n, perBuy, total: perBuy * n, allocated, allocations, end: dates[n - 1] || null };
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
