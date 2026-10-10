// Cash and income from Trading 212 imports, money-weighted return, and exposure look-through.
import * as market from './market.js';
import { historySymbol } from './history.js';

const DAY = 864e5;
const sum = (arr, f = (x) => x) => arr.reduce((s, x) => s + f(x), 0);
const isT212 = (t) => t.extId?.startsWith('t212:');

// ---------- Cash and income

// Cash implied by the imports: money in and out, plus every Trading 212 buy and sell
export function t212Cash(state) {
  const flows = state.cashflows || [];
  if (!flows.length) return null;
  let cash = sum(flows, (f) => f.amount);
  for (const t of state.transactions) {
    if (!isT212(t)) continue;
    if (t.type === 'buy') cash -= t.qty * t.price + (+t.fee || 0);
    else if (t.type === 'sell') cash += t.qty * t.price - (+t.fee || 0);
  }
  return cash;
}

// Annualised money-weighted return. flows: [{ date, amount }] from the investor's side (paid in < 0)
export function xirr(flows) {
  if (flows.length < 2 || !flows.some((f) => f.amount < 0) || !flows.some((f) => f.amount > 0)) return null;
  const t0 = new Date(flows[0].date).getTime();
  const yrs = flows.map((f) => (new Date(f.date).getTime() - t0) / (365.25 * DAY));
  const npv = (r) => flows.reduce((s, f, i) => s + f.amount / (1 + r) ** yrs[i], 0);
  // Bisection: robust for the sign pattern deposits-then-value
  let lo = -0.99, hi = 10;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
  }
  return ((lo + hi) / 2) * 100;
}

/**
 * Everything the Cash and income panel shows. t212Value is today's value of holdings bought on Trading 212.
 */
export function incomeSummary(state, t212Value) {
  const flows = [...(state.cashflows || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (!flows.length) return null;
  const by = (k) => flows.filter((f) => f.kind === k);
  const yearAgo = new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10);
  const deposits = sum(by('deposit'), (f) => f.amount);
  const outflows = -sum([...by('withdrawal'), ...by('spend')], (f) => f.amount);
  const dividends = by('dividend');
  const t212Txs = state.transactions.filter(isT212);
  const cash = t212Cash(state);

  const divByYear = {};
  for (const d of dividends) divByYear[d.date.slice(0, 4)] = (divByYear[d.date.slice(0, 4)] || 0) + d.amount;
  const divByAsset = {};
  for (const d of dividends) if (d.assetId) divByAsset[d.assetId] = (divByAsset[d.assetId] || 0) + d.amount;

  // The history is complete only if money went in before the first trade
  const firstTrade = t212Txs.map((t) => t.date).sort()[0];
  const firstDeposit = by('deposit')[0]?.date;
  const complete = !!firstDeposit && (!firstTrade || firstDeposit <= firstTrade) && cash > -1;

  const netIn = deposits - outflows;
  const now = t212Value != null && cash != null ? t212Value + cash : null;
  const external = flows.filter((f) => ['deposit', 'withdrawal', 'spend'].includes(f.kind)).map((f) => ({ date: f.date, amount: -f.amount }));
  return {
    cash,
    complete,
    deposits,
    outflows,
    netIn,
    totalGain: now != null ? now - netIn : null,
    totalGainPct: now != null && netIn > 0 ? ((now - netIn) / netIn) * 100 : null,
    mwr: complete && now != null ? xirr([...external, { date: new Date().toISOString().slice(0, 10), amount: now }]) : null,
    dividends: sum(dividends, (f) => f.amount),
    dividends12m: sum(dividends.filter((f) => f.date >= yearAgo), (f) => f.amount),
    divByYear,
    divByAsset,
    interest: sum(by('interest'), (f) => f.amount),
    fees: sum(t212Txs, (t) => +t.fee || 0),
    since: flows[0].date,
  };
}

// ---------- Exposure look-through

export const FACTORS = [
  { id: 'btc', label: 'Bitcoin', symbol: 'BTC-USD' },
  { id: 'ndx', label: 'US tech (Nasdaq 100)', symbol: '^NDX' },
  { id: 'spx', label: 'US market (S&P 500)', symbol: '^GSPC' },
  { id: 'gold', label: 'Gold', symbol: 'GC=F' },
];
const MIN_CORR = 0.5;

// Daily log returns on the dates two series share (crypto trades on weekends, stocks don't)
function pairedReturns(a, b, days = 260) {
  const mb = new Map(b.map((p) => [p.date, p.v]));
  const common = a.filter((p) => mb.has(p.date) && p.v > 0 && mb.get(p.date) > 0).slice(-(days + 1));
  const x = [], y = [];
  for (let i = 1; i < common.length; i++) {
    x.push(Math.log(common[i].v / common[i - 1].v));
    y.push(Math.log(mb.get(common[i].date) / mb.get(common[i - 1].date)));
  }
  return [x, y];
}
function corrBeta(x, y) {
  const n = x.length;
  if (n < 40) return null;
  const mx = sum(x) / n, my = sum(y) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  if (!sxx || !syy) return null;
  return { corr: sxy / Math.sqrt(sxx * syy), beta: sxy / syy }; // beta of x against y
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
let memo = { key: null, promise: null };

/**
 * Groups open holdings by what moves them. rows: [{ assetId, value }] in the base currency.
 * Returns { groups: [{ id, label, value, pct, equiv, holdings: [{ assetId, value, corr, beta }] }], concentration }
 */
export function exposure(rows, assetById) {
  const priced = rows.filter((r) => r.value > 0);
  const key = priced.map((r) => r.assetId).sort().join(',') + new Date().toISOString().slice(0, 10);
  if (memo.key === key) return memo.promise.then((res) => withValues(res, priced));
  memo = { key, promise: buildExposure(priced, assetById) };
  memo.promise.catch(() => { memo = { key: null, promise: null }; });
  return memo.promise.then((res) => withValues(res, priced));
}

async function buildExposure(priced, assetById) {
  const load = (sym) => withTimeout(market.dailyHistory(sym), 15e3).then((h) => h.points).catch(() => null);
  const factors = await Promise.all(FACTORS.map((f) => load(f.symbol)));
  if (factors.every((f) => !f)) throw new Error('Price history is unavailable right now.');
  const links = {};
  await Promise.all(priced.map(async (r) => {
    const a = assetById(r.assetId);
    const sym = a && historySymbol(a);
    const pts = sym ? await load(sym) : null;
    let best = null;
    if (pts) FACTORS.forEach((f, i) => {
      if (!factors[i]) return;
      const cb = corrBeta(...pairedReturns(pts, factors[i]));
      if (cb && (!best || cb.corr > best.corr)) best = { factor: f.id, ...cb };
    });
    links[r.assetId] = best && best.corr >= MIN_CORR ? best : { factor: 'own', ...(best || {}) };
  }));
  return links;
}

function withValues(links, priced) {
  const total = sum(priced, (r) => r.value);
  const groups = [...FACTORS, { id: 'own', label: 'Own drivers' }].map((f) => {
    const holdings = priced.filter((r) => links[r.assetId]?.factor === f.id)
      .map((r) => ({ assetId: r.assetId, value: r.value, corr: links[r.assetId].corr ?? null, beta: links[r.assetId].beta ?? null }))
      .sort((a, b) => b.value - a.value);
    const value = sum(holdings, (h) => h.value);
    return {
      id: f.id, label: f.label, value, pct: total ? (value / total) * 100 : 0, holdings,
      // How much of the factor itself this group moves like
      equiv: f.id === 'own' ? null : sum(holdings, (h) => h.value * (h.beta ?? 1)),
    };
  }).filter((g) => g.holdings.length).sort((a, b) => b.value - a.value);

  const w = priced.map((r) => r.value / total).sort((a, b) => b - a);
  const hhi = sum(w, (x) => x * x);
  return {
    groups,
    concentration: { top1: (w[0] || 0) * 100, top3: sum(w.slice(0, 3)) * 100, effective: hhi ? 1 / hhi : 0, count: w.length },
  };
}
