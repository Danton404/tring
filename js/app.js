import { store, uid, pull, push, syncEnabled, clearLocal } from './store.js';
import { hosted, cloud, initAuth, signInWithGoogle, signOut, loadInfo, serverKeys } from './cloud.js';
import * as market from './market.js';
import { holdings, planSummary, indicators } from './calc.js';
import { parseCsv, isT212, summarize, buildTransactions } from './importer.js';
import { portfolioHistory } from './history.js';
import { ask, PROVIDERS, modelFor, availableProviders, activeProvider } from './ai.js';
import {
  $, $$, esc, icon, fmtMoney, fmtSignedMoney, fmtPct, fmtNum, fmtDate, todayISO, tone,
  toast, openSheet, donut, lineChart, bindScrub, bigMoney, countUp, colorAt, md,
} from './ui.js';

const TABS = [
  { id: 'markets', label: 'Markets', icon: 'trending' },
  { id: 'portfolio', label: 'Portfolio', icon: 'wallet' },
  { id: 'plan', label: 'Plan', icon: 'pie' },
  { id: 'ai', label: 'AI', icon: 'bot' },
  { id: 'settings', label: 'Settings', icon: 'sliders' },
];
const KINDS = { stock: 'Stock', etf: 'ETF', index: 'Index', commodity: 'Commodity', fx: 'FX', crypto: 'Crypto' };
const FREQS = { daily: 'Daily (weekdays)', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' };
const CHAT_KEY = 'tring.chat.v1';

const ui = { tab: 'markets', sort: 'default', planId: null, busy: false };
let chat = loadChat();

// Portfolio maths runs in the base currency (EUR after a Trading 212 import, USD otherwise).
const base = () => store.state.baseCurrency || 'USD';
const money = (n) => fmtMoney(n, base());
const smoney = (n) => fmtSignedMoney(n, base());
const toBase = (id, n) => {
  if (n == null) return null;
  const fx = market.fxRate(assetById(id)?.currency || 'USD', base());
  return fx == null ? null : n * fx;
};
// Live price in the base currency; imported holdings without a live source fall back to their last trade price
const priceOf = (id) => toBase(id, market.quote(id)?.price ?? null) ?? assetById(id)?.lastPrice ?? null;
const athOf = (id) => (market.ath(id)?.partial ? null : toBase(id, market.ath(id)?.ath ?? null));
const assetById = (id) => store.state.assets.find((a) => a.id === id);
const assetName = (id) => assetById(id)?.name || 'Removed asset';
const assetColor = (id) => colorAt(store.state.assets.findIndex((a) => a.id === id));
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// =====================================================================
// Shell
// =====================================================================

function buildNav() {
  $('#nav').innerHTML = TABS.map((t) => `<a href="#${t.id}" data-tab="${t.id}">${icon(t.icon, 22)}<span>${t.label}</span></a>`).join('');
}

function route() {
  const id = location.hash.slice(1);
  ui.tab = TABS.some((t) => t.id === id) ? id : 'markets';
  $$('#nav a').forEach((a) => (a.dataset.tab === ui.tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  $('#view-title').textContent = TABS.find((t) => t.id === ui.tab).label;
  document.title = `TRING · ${TABS.find((t) => t.id === ui.tab).label}`;
  render();
  window.scrollTo(0, 0);
}

const VIEWS = { markets: renderMarkets, portfolio: renderPortfolio, plan: renderPlan, ai: renderAI, settings: renderSettings };
function render() {
  VIEWS[ui.tab]($('#view'));
}

function renderSyncStatus() {
  const el = $('#sync-status');
  const { status, message } = store.sync;
  const text = { off: '', syncing: 'Syncing', ok: 'Synced', error: 'Sync error' }[status];
  el.hidden = status === 'off';
  el.className = `sync-pill ${status}`;
  el.innerHTML = `${icon('cloud', 16)}<span>${text}</span>`;
  el.title = message || text;
  if (ui.tab === 'settings') { const s = $('#sync-detail'); if (s) s.textContent = syncDetail(); }
}

async function refresh(force = false) {
  const btn = $('#refresh-btn');
  btn.classList.add('spinning');
  btn.disabled = true;
  await market.refreshAll(store.state.assets, { force, onUpdate: onMarket, base: base() });
  btn.classList.remove('spinning');
  btn.disabled = false;
  recordSnapshot();
}

function onMarket() {
  // Don't re-render while the user is typing in the transaction search
  if (ui.tab === 'portfolio' && ['tx-q', 'hold-q'].includes(document.activeElement?.id)) return;
  if (ui.tab === 'markets' || ui.tab === 'portfolio') render();
  else if (ui.tab === 'plan') updatePlanResults();
}

// One portfolio snapshot per day, used for the performance chart.
function recordSnapshot() {
  const { open, totals } = holdings(store.state.transactions, priceOf);
  if (!open.length || totals.value == null || totals.unpriced) return;
  const snap = { date: todayISO(), value: round(totals.value), invested: round(totals.cost) };
  const prev = store.state.snapshots.find((s) => s.date === snap.date);
  if (prev && prev.value === snap.value && prev.invested === snap.invested) return;
  store.update((s) => {
    s.snapshots = s.snapshots.filter((x) => x.date !== snap.date).concat(snap).sort((a, b) => a.date.localeCompare(b.date)).slice(-1500);
  }, { silent: ui.tab !== 'portfolio' });
}

function emptyState(title, text, action = '') {
  return `<div class="empty card"><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>${action}</div>`;
}

const assetOptions = (selected, list = store.state.assets.filter((a) => !a.archived || a.id === selected)) =>
  list.map((a) => `<option value="${a.id}"${a.id === selected ? ' selected' : ''}>${esc(a.name)} (${esc(a.symbol)})</option>`).join('');

// =====================================================================
// Markets
// =====================================================================

function assetView(a) {
  const q = market.quote(a.id), at = market.ath(a.id);
  const price = q?.price ?? null, ath = at?.ath ?? null;
  return {
    a, q, at, price, ath,
    toAth: price && ath ? Math.max(0, (ath / price - 1) * 100) : null,
    ofAth: price && ath ? Math.min(100, (price / ath) * 100) : null,
    err: market.error(a.id),
    loading: market.isLoading(a.id),
  };
}

function renderMarkets(el) {
  const needsKey = !hosted && !store.settings.twelveKey && store.state.assets.some((a) => a.source === 'twelve');
  let rows = store.state.assets.filter((a) => !a.archived).map(assetView);
  const sorters = {
    closest: (x, y) => (x.toAth ?? Infinity) - (y.toAth ?? Infinity),
    furthest: (x, y) => (y.toAth ?? -1) - (x.toAth ?? -1),
    today: (x, y) => (y.q?.changePct ?? -Infinity) - (x.q?.changePct ?? -Infinity),
  };
  if (sorters[ui.sort]) rows = [...rows].sort(sorters[ui.sort]);
  const sortOpts = { default: 'My order', closest: 'Closest to ATH', furthest: 'Furthest from ATH', today: 'Best today' };

  el.innerHTML = `
    ${needsKey ? `<div class="banner">${icon('alert')}<div><strong>Connect market data</strong><p>Add a free Twelve Data key for stocks, ETFs and gold.</p></div><a class="btn" href="#settings">Open Settings</a></div>` : ''}
    <div class="toolbar">
      <div class="field inline"><label for="sort">Sort</label>
        <select id="sort">${Object.entries(sortOpts).map(([k, v]) => `<option value="${k}"${k === ui.sort ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
      <button class="btn primary" type="button" data-act="add-asset">${icon('plus')}Add asset</button>
    </div>
    ${rows.length ? `<div class="grid">${rows.map(assetCard).join('')}</div>`
      : emptyState('No assets yet', 'Add a stock, ETF, gold or crypto.', `<button class="btn primary" data-act="add-asset">${icon('plus')}Add asset</button>`)}`;
  $('#sort', el).onchange = (e) => { ui.sort = e.target.value; renderMarkets(el); };
}

function assetCard(v) {
  const { a, q, at, price, ath, toAth, ofAth, err, loading } = v;
  const cmoney = (n) => fmtMoney(n, a.currency || 'USD');
  const priceBlock = price != null
    ? `<div class="price num">${cmoney(price)}</div>${q.changePct != null && isFinite(q.changePct) ? `<div class="small num ${tone(q.changePct)}">${fmtPct(q.changePct)}</div>` : ''}`
    : loading ? '<div class="skeleton" style="width:96px;height:24px"></div>' : '';
  let body;
  if (price == null && err) {
    const fix = /API key/.test(err)
      ? `<a class="btn small" href="#settings">Open Settings</a>`
      : `<button class="btn small" type="button" data-act="retry">${icon('refresh', 16)}Retry</button>`;
    body = `<div class="card-error" role="alert"><p>${esc(err)}</p>${fix}</div>`;
  } else if (a.source === 'none') {
    body = `<p class="muted small">No live price. Using last trade${a.lastPrice ? ` ${money(a.lastPrice)}, ${fmtDate(a.lastPriceDate)}` : ''}.</p>`;
  } else if (price != null && at?.partial) {
    body = `<p class="muted small">No ATH for this listing.</p>`;
  } else if (price == null || ath == null) {
    body = `<div class="skeleton" style="height:56px"></div><div class="skeleton" style="height:8px;margin-top:12px"></div>`;
  } else {
    const range = q.low52 && q.high52 ? ` · 52W ${cmoney(q.low52)}–${cmoney(q.high52)}` : '';
    body = `
      <div class="ath-row">
        <div><span class="eyebrow">To ATH</span><strong class="big num">${toAth < 0.01 ? 'At ATH' : fmtPct(toAth)}</strong></div>
        <div class="right"><span class="eyebrow">All-time high</span><span class="num strong">${cmoney(ath)}</span><span class="muted small">${fmtDate(at.athDate)}</span></div>
      </div>
      <div class="meter" role="meter" aria-label="Price as a share of all-time high" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${ofAth.toFixed(1)}"><span style="width:${ofAth}%;background:${assetColor(a.id)}"></span></div>
      <p class="muted small num">${ofAth.toFixed(1)}% of ATH${range}</p>`;
  }
  return `<article class="card asset" data-id="${a.id}">
    <header class="asset-head">
      <button type="button" class="asset-id" data-act="open-asset">${avatar(a.id)}<span><h3>${esc(a.name)}</h3><span class="muted small">${esc(a.symbol)} · ${KINDS[a.kind] || esc(a.kind)}</span></span></button>
      <div class="price-block">${priceBlock}</div>
    </header>
    ${body}
    <footer class="card-actions">
      <button class="btn ghost small" type="button" data-act="analyze">${icon('sparkles', 16)}Analyze</button>
      <button class="btn ghost small" type="button" data-act="buy">${icon('plus', 16)}Log buy</button>
      <button class="icon-btn" type="button" data-act="remove-asset" aria-label="Remove ${esc(a.name)}">${icon('trash', 18)}</button>
    </footer>
  </article>`;
}

function openAddAsset() {
  const kinds = Object.entries(KINDS).map(([k, v], i) =>
    `<label><input type="radio" name="kind" value="${k}"${i === 0 ? ' checked' : ''}><span>${v}</span></label>`).join('');
  openSheet('Add asset', `
    <form class="form" id="asset-form" novalidate>
      <div class="field"><span class="label" id="kind-label">Type</span><div class="seg wrap" role="radiogroup" aria-labelledby="kind-label">${kinds}</div></div>
      <div class="field"><label for="as-symbol" id="as-symbol-label">Ticker symbol</label>
        <input id="as-symbol" name="symbol" autocomplete="off" autocapitalize="characters" spellcheck="false" required placeholder="AAPL">
        <p class="hint" id="as-hint"></p></div>
      <div class="field"><label for="as-name">Display name (optional)</label><input id="as-name" name="name" autocomplete="off"></div>
      <div id="as-results" class="pick-list"></div>
      <p class="form-error" id="as-error" role="alert"></p>
      <button class="btn primary block" type="submit">Add asset</button>
    </form>`, (body, close) => {
    const form = $('#asset-form', body);
    const hints = {
      stock: ['Ticker symbol', 'AAPL', 'Any US or international ticker on Twelve Data, e.g. NVDA, MSFT, ASML.'],
      etf: ['Ticker symbol', 'VOO', 'For example VOO, VWCE, QQQ, SPY.'],
      index: ['Symbol', 'SPX', 'Free Twelve Data plans may not include raw indices. If it fails, track the ETF instead (SPY, QQQ, DIA).'],
      commodity: ['Symbol', 'XAG/USD', 'Metals use FX-style pairs: XAU/USD (gold), XAG/USD (silver).'],
      fx: ['Pair', 'EUR/USD', 'Currency pair, e.g. EUR/USD, GBP/USD.'],
      crypto: ['Coin name or ticker', 'ethereum', 'Searches CoinGecko. No API key needed.'],
    };
    const sync = () => {
      const [label, ph, hint] = hints[form.kind.value];
      $('#as-symbol-label', body).textContent = label;
      form.symbol.placeholder = ph;
      $('#as-hint', body).textContent = hint;
      $('#as-results', body).innerHTML = '';
    };
    form.addEventListener('change', (e) => { if (e.target.name === 'kind') sync(); });
    sync();

    const add = (asset) => {
      store.update((s) => s.assets.push(asset));
      close();
      toast(`${asset.name} added`);
      market.refreshAll([asset], { onUpdate: onMarket, base: base() });
    };

    form.onsubmit = async (e) => {
      e.preventDefault();
      const kind = form.kind.value;
      const q = form.symbol.value.trim();
      const err = $('#as-error', body);
      err.textContent = '';
      if (!q) { err.textContent = 'Enter a symbol.'; form.symbol.focus(); return; }
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Checking...';
      try {
        if (kind === 'crypto') {
          const coins = await market.searchCrypto(q);
          if (!coins.length) throw new Error('No coin found. Try the full name, e.g. "solana".');
          $('#as-results', body).innerHTML = `<p class="label">Pick the coin</p>` + coins.map((c, i) =>
            `<button type="button" class="pick" data-i="${i}"><strong>${esc(c.name)}</strong><span class="muted">${esc(c.symbol.toUpperCase())} · ${esc(c.id)}</span></button>`).join('');
          $$('.pick', body).forEach((b) => (b.onclick = () => {
            const c = coins[+b.dataset.i];
            add({ id: uid(), name: form.name.value.trim() || c.name, symbol: c.symbol.toUpperCase(), kind, source: 'coingecko', cgId: c.id });
          }));
        } else {
          const symbol = q.toUpperCase();
          if (store.state.assets.some((a) => a.source === 'twelve' && a.symbol === symbol)) throw new Error(`${symbol} is already on your list.`);
          const found = await market.lookupTwelve(symbol);
          add({ id: uid(), name: form.name.value.trim() || found.name || symbol, symbol: found.symbol || symbol, kind, source: 'twelve' });
        }
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Add asset';
      }
    };
    form.symbol.focus();
  });
}

function removeAsset(id) {
  const a = assetById(id);
  if (!a) return;
  if (store.state.transactions.some((t) => t.assetId === id)) {
    toast(`${a.name} has transactions. Delete them in Portfolio first.`, { kind: 'error' });
    return;
  }
  const before = structuredClone({ assets: store.state.assets, plans: store.state.plans });
  store.update((s) => {
    s.assets = s.assets.filter((x) => x.id !== id);
    s.plans.forEach((p) => (p.allocations = p.allocations.filter((al) => al.assetId !== id)));
  });
  toast(`${a.name} removed`, {
    action: 'Undo',
    onAction: () => store.update((s) => { s.assets = before.assets; s.plans = before.plans; }),
  });
}

// =====================================================================
// Portfolio
// =====================================================================

// ---------- Portfolio view state (not synced)

const TX_PAGE = 15;
const RANGES = [['1w', '1W'], ['1m', '1M'], ['3m', '3M'], ['6m', '6M'], ['ytd', 'YTD'], ['1y', '1Y'], ['all', 'All']];
const RANGE_LABEL = { '1w': 'Past week', '1m': 'Past month', '3m': 'Past 3 months', '6m': 'Past 6 months', ytd: 'Year to date', '1y': 'Past year', all: 'All time' };
const port = { range: '1y', sort: 'value', hq: '', txOpen: false, page: 1, q: '', asset: '', type: '', txSort: 'new', shown: null };
const perf = { promise: null, points: null, error: null };

function loadPerf() {
  const { transactions, assets } = store.state;
  const p = portfolioHistory({
    transactions, assets, base: base(), livePrice: priceOf,
    // Remember history symbols found for closed holdings so they're looked up once
    remember: (id, patch) => store.update((s) => { const a = s.assets.find((x) => x.id === id); if (a) Object.assign(a, patch); }, { silent: true }),
  });
  if (p === perf.promise) return;
  perf.promise = p;
  perf.points = null;
  perf.error = null;
  p.then((pts) => { if (perf.promise === p) { perf.points = pts; if (ui.tab === 'portfolio') renderPerf(); } })
    .catch((e) => { if (perf.promise === p) { perf.error = e.message; if (ui.tab === 'portfolio') renderPerf(); } });
}

const toAthPct = (id) => {
  const q = market.quote(id)?.price, at = market.ath(id);
  return q && at?.ath && !at.partial ? Math.max(0, (at.ath / q - 1) * 100) : null;
};

const isoDaysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
function rangeFrom(r) {
  if (r === 'ytd') return `${new Date().getFullYear() - 1}-12-31`;
  const d = { '1w': 7, '1m': 30, '3m': 91, '6m': 182, '1y': 365 }[r];
  return d ? isoDaysAgo(d) : '';
}
// Points from the last one on or before `from` (the baseline) to today
function sliceFrom(points, from) {
  if (!from) return points;
  let k = 0;
  for (let i = 0; i < points.length; i++) if (points[i].date <= from) k = i;
  return points.slice(k);
}
// Market gain between two points: change in value, minus money added, plus profits taken
function gainBetween(a, b) {
  const gain = (b.value - a.value) - (b.invested - a.invested) + (b.realized - a.realized);
  const basis = a.value + Math.max(0, b.invested - a.invested);
  return { gain, pct: basis > 0 ? (gain / basis) * 100 : null };
}
// Today's move from live quotes (day change × quantity, in the base currency)
function dayPnl(open) {
  let gain = 0, prev = 0, any = false;
  for (const r of open) {
    const ch = toBase(r.assetId, market.quote(r.assetId)?.change ?? null);
    if (ch == null || !isFinite(ch) || r.value == null) continue;
    any = true;
    gain += ch * r.qty;
    prev += r.value - ch * r.qty;
  }
  return any ? { gain, pct: prev > 0 ? (gain / prev) * 100 : null } : null;
}

const cash = () => store.state.cash || { amount: 0, show: false };
const initials = (a) => (a?.symbol || a?.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
const avatar = (id) => `<span class="avatar" style="--c:${assetColor(id)}" aria-hidden="true">${esc(initials(assetById(id)))}</span>`;
const pnl = (r) => (r ? `<span class="num ${tone(r.gain)}">${smoney(r.gain)}${r.pct != null ? ` <span class="pct">(${fmtPct(r.pct)})</span>` : ''}</span>` : '<span class="muted">-</span>');
const statRow = (label, value) => `<div class="stat"><span class="eyebrow">${label}</span><span class="num">${value}</span></div>`;

function renderPortfolio(el) {
  const { state } = store;
  if (!state.transactions.length) {
    el.innerHTML = emptyState('No investments yet', 'Import your Trading 212 history or log a buy.',
      `<div class="btn-row"><button class="btn primary" type="button" data-act="import-t212">${icon('upload')}Import from Trading 212</button><button class="btn" type="button" data-act="add-tx">${icon('plus')}Log a transaction</button></div>`);
    return;
  }
  const { open, rows, totals } = holdings(state.transactions, priceOf, athOf);
  const c = cash();
  const cashOn = c.show && c.amount > 0;
  const total = totals.value != null ? totals.value + (c.show ? +c.amount || 0 : 0) : null;
  const toAthTotal = totals.valueAtAth != null && totals.value ? (totals.valueAtAth / totals.value - 1) * 100 : null;

  // Holdings list (Trading 212 style)
  const sorters = {
    value: (x, y) => (y.value ?? -Infinity) - (x.value ?? -Infinity),
    return: (x, y) => (y.plPct ?? -Infinity) - (x.plPct ?? -Infinity),
    today: (x, y) => (market.quote(y.assetId)?.changePct ?? -Infinity) - (market.quote(x.assetId)?.changePct ?? -Infinity),
    name: (x, y) => assetName(x.assetId).localeCompare(assetName(y.assetId)),
    toAth: (x, y) => (toAthPct(x.assetId) ?? Infinity) - (toAthPct(y.assetId) ?? Infinity),
  };
  const segs = open.filter((r) => r.value > 0).map((r) => ({ label: assetName(r.assetId), value: r.value, color: assetColor(r.assetId) }));
  if (cashOn) segs.push({ label: 'Cash', value: +c.amount, color: 'var(--muted)' });
  const totalVal = segs.reduce((s, x) => s + x.value, 0);

  el.innerHTML = `
    <div class="port">
      <section class="panel perf" aria-label="Performance">
        <div class="perf-head">
          <div class="perf-title">
            <span class="eyebrow" id="perf-label">Portfolio</span>
            <strong class="hero num" id="perf-value">${bigMoney(total, base())}</strong>
            <span class="perf-sub small num" id="perf-sub"><span class="skeleton" style="display:inline-block;width:140px;height:14px"></span></span>
          </div>
          <div class="perf-actions">
            <button class="icon-btn" type="button" data-act="cash" aria-label="Cash on hand">${icon('banknote')}</button>
            <button class="icon-btn" type="button" data-act="import-t212" aria-label="Import from Trading 212">${icon('upload')}</button>
            <button class="btn primary small" type="button" data-act="add-tx">${icon('plus', 16)}Log</button>
          </div>
        </div>
        <div id="perf-body"></div>
        <div class="ranges" role="radiogroup" aria-label="Chart range">${RANGES.map(([v, l]) =>
          `<label><input type="radio" name="perf-range" value="${v}"${port.range === v ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>
      </section>

      <section class="panel returns" aria-label="Profit and loss">
        <h2 class="eyebrow">Profit and loss</h2>
        <div class="pnl-grid" id="pnl-grid"></div>
      </section>

      <section class="panel breakdown" aria-label="Breakdown">
        <div class="box">
          ${statRow('Investments', money(totals.value))}
          ${c.show ? statRow('Cash', `<button class="link-btn" type="button" data-act="cash">${money(+c.amount || 0)}</button>`) : ''}
          ${statRow('Invested', money(totals.totalCost))}
          ${statRow('Unrealized', `<span class="${tone(totals.pl)}">${smoney(totals.pl)} (${fmtPct(totals.plPct)})</span>`)}
          ${statRow('Realized', `<span class="${tone(totals.realized)}">${smoney(totals.realized)}</span>`)}
          ${statRow('Value at ATH', `${money(totals.valueAtAth)}${toAthTotal != null ? ` <span class="muted">${fmtPct(toAthTotal)}</span>` : ''}`)}
        </div>
      </section>

      <section class="panel holdings-panel" aria-label="Holdings">
        <div class="hold-head">
          <div><span class="eyebrow">Investments</span><strong class="num hold-total">${money(totals.value)}</strong></div>
          <label class="sr-only" for="hold-sort">Sort</label>
          <select id="hold-sort" class="select-sm">${[['value', 'Value'], ['return', 'Return'], ['today', 'Today'], ['toAth', 'To ATH'], ['name', 'Name']].map(([k, l]) => `<option value="${k}"${port.sort === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
        </div>
        <div class="search">${icon('search', 18)}<label class="sr-only" for="hold-q">Search portfolio</label><input id="hold-q" type="search" placeholder="Search portfolio" value="${esc(port.hq)}" autocomplete="off"></div>
        <ul class="hold-list" id="hold-list"></ul>
      </section>

      <section class="panel alloc-panel"><h2 class="eyebrow">Allocation</h2>
        ${segs.length ? `<div class="alloc">${donut(segs, { label: 'Portfolio allocation by market value', center: `${segs.length}` })}
          <ul class="legend-list cols">${segs.sort((x, y) => y.value - x.value).map((s) => `<li><i style="background:${s.color}"></i><span>${esc(s.label)}</span><span class="num">${fmtPct((s.value / totalVal) * 100, { signed: false, digits: 1 })}</span></li>`).join('')}</ul></div>`
          : '<div class="skeleton" style="height:120px"></div>'}
      </section>

      <section class="panel tx-panel" id="tx-section"></section>
    </div>`;

  const renderList = () => {
    const q = port.hq.trim().toLowerCase();
    const list = [...open].sort(sorters[port.sort]).filter((r) => !q || `${assetName(r.assetId)} ${assetById(r.assetId)?.symbol || ''}`.toLowerCase().includes(q));
    $('#hold-list', el).innerHTML = list.map((r) => {
      const a = assetById(r.assetId);
      return `<li><button type="button" class="hold" data-act="open-asset" data-id="${r.assetId}">
        ${avatar(r.assetId)}
        <span class="hold-main"><span class="hold-name">${esc(assetName(r.assetId))}</span><span class="hold-sub num">${fmtNum(r.qty, 8)} ${esc(a?.symbol || '')}</span></span>
        <span class="hold-right"><span class="num hold-val">${money(r.value)}</span><span class="num small ${tone(r.pl)}">${smoney(r.pl)} (${fmtPct(r.plPct)})</span></span>
      </button></li>`;
    }).join('') + (cashOn && !q ? `<li><button type="button" class="hold" data-act="cash"><span class="avatar cash" aria-hidden="true">${icon('banknote', 18)}</span><span class="hold-main"><span class="hold-name">Cash</span><span class="hold-sub">${base()}</span></span><span class="hold-right"><span class="num hold-val">${money(+c.amount)}</span></span></button></li>` : '')
      || '<li class="muted small hold-empty">No match</li>';
  };
  renderList();
  $('#hold-q', el).addEventListener('input', (e) => { port.hq = e.target.value; renderList(); });
  $('#hold-sort', el).onchange = (e) => { port.sort = e.target.value; renderList(); };
  $$('[name=perf-range]', el).forEach((r) => (r.onchange = () => { port.range = r.value; renderPerf(); }));

  // Hero number counts up when it changes (after React Bits' CountUp)
  const hero = $('#perf-value', el);
  countUp(hero, port.shown, total, (v) => bigMoney(v, base()));
  port.shown = total;
  port.live = { total, open, totals };

  loadPerf();
  renderPerf();
  renderTx();
}

function renderPnl() {
  const box = $('#pnl-grid');
  if (!box || !port.live) return;
  const { open, totals } = port.live;
  const pts = perf.points;
  const from = (r) => (pts?.length > 1 ? gainBetween(sliceFrom(pts, rangeFrom(r))[0], pts[pts.length - 1]) : undefined);
  const all = totals.pl != null ? { gain: totals.pl + totals.realized, pct: totals.deposited ? ((totals.pl + totals.realized) / totals.deposited) * 100 : null } : null;
  const cells = [['Today', dayPnl(open)], ['1W', from('1w')], ['1M', from('1m')], ['YTD', from('ytd')], ['1Y', from('1y')], ['All time', all]];
  box.innerHTML = cells.map(([l, r]) => `<div class="pnl"><span class="eyebrow">${l}</span>${r === undefined
    ? (perf.error ? '<span class="muted">-</span>' : '<span class="skeleton" style="height:18px;width:80%"></span>')
    : r ? `<strong class="num ${tone(r.gain)}">${smoney(r.gain)}</strong><span class="small num ${tone(r.gain)}">${fmtPct(r.pct)}</span>` : '<span class="muted">-</span>'}</div>`).join('');
}

function renderPerf() {
  renderPnl();
  const box = $('#perf-body');
  if (!box) return;
  const sub = $('#perf-sub'), label = $('#perf-label'), hero = $('#perf-value');
  if (perf.error) {
    sub.textContent = '';
    box.innerHTML = `<div class="card-error" role="alert"><p>History unavailable: ${esc(perf.error)}</p><button class="btn small" type="button" data-act="perf-retry">${icon('refresh', 16)}Retry</button></div>`;
    return;
  }
  if (!perf.points) {
    box.innerHTML = `<div class="skeleton" style="height:220px"></div>`;
    return;
  }
  const pts = sliceFrom(perf.points, rangeFrom(port.range));
  if (pts.length < 2) {
    sub.textContent = '';
    box.innerHTML = `<p class="muted small chart-empty">Not enough history yet.</p>`;
    return;
  }
  const first = pts[0], last = pts[pts.length - 1];
  const rest = gainBetween(first, last);
  const color = rest.gain >= 0 ? 'var(--success)' : 'var(--danger)';
  const chart = lineChart([
    { values: pts.map((p) => p.value), color, fill: true },
    { values: pts.map((p) => p.invested), color: 'var(--muted)', dash: true },
  ], { height: 220, label: `Portfolio value versus invested, ${RANGE_LABEL[port.range].toLowerCase()}` });
  const subLine = (g, when) => `<span class="${tone(g.gain)}">${g.gain >= 0 ? '▲' : '▼'} ${smoney(g.gain)}${g.pct != null ? ` (${fmtPct(g.pct)})` : ''}</span> <span class="muted">${when}</span>`;
  const rest$ = () => {
    label.textContent = 'Portfolio';
    hero.innerHTML = bigMoney(port.live?.total, base());
    sub.innerHTML = subLine(rest, RANGE_LABEL[port.range].toLowerCase());
  };
  rest$();
  box.innerHTML = `${chart.html}<div class="lc-legend small muted"><span><i class="sw" style="background:${color}"></i>Value</span><span><i class="sw dashed"></i>Invested</span></div>`;
  bindScrub(box, chart, {
    onMove: (i) => {
      const p = pts[i];
      label.textContent = `Investments · ${fmtDate(p.date)}`;
      hero.innerHTML = bigMoney(p.value, base());
      sub.innerHTML = `${subLine(gainBetween(first, p), `since ${fmtDate(first.date, { month: 'short', day: 'numeric' })}`)} <span class="muted">· ${money(p.invested)} invested</span>`;
    },
    onEnd: rest$,
  });
}

function openCash() {
  const c = cash();
  openSheet('Cash', `
    <form class="form" id="cash-form" novalidate>
      <div class="field"><label for="cash-amt">Cash on hand (${base()})</label><input id="cash-amt" name="amount" type="number" inputmode="decimal" step="any" min="0" value="${c.amount || ''}" placeholder="0.00"></div>
      <label class="check"><input type="checkbox" name="show"${c.show ? ' checked' : ''}><span>Show in portfolio value</span></label>
      <button class="btn primary block" type="submit">Save</button>
    </form>`, (body, close) => {
    const f = $('#cash-form', body);
    f.onsubmit = (e) => {
      e.preventDefault();
      const amount = Math.max(0, parseFloat(f.amount.value) || 0);
      store.update((s) => { s.cash = { amount: round(amount), show: f.show.checked }; });
      close();
    };
    f.amount.focus();
  });
}

// Asset detail: price chart with scrubbing, and your position (Revolut / Trading 212 style)
const SERIES_RANGES = [['1w', '1W', 7], ['1m', '1M', 30], ['3m', '3M', 91], ['6m', '6M', 182], ['1y', '1Y', 365]];
function openAsset(id) {
  const a = assetById(id);
  if (!a) return;
  const ccy = a.currency || 'USD';
  const q = market.quote(id);
  const price = q?.price ?? null;
  const h = holdings(store.state.transactions, priceOf, athOf).rows.find((r) => r.assetId === id && r.qty > 0);
  const ta = toAthPct(id);
  const day = h && q?.change != null ? toBase(id, q.change) * h.qty : null;
  let range = '1m';
  openSheet(a.name, `
    <div class="detail">
      <div class="detail-id">${avatar(id)}<span class="eyebrow">${esc(a.symbol)} · ${KINDS[a.kind] || esc(a.kind)}</span></div>
      <div class="perf-title">
        <span class="eyebrow" id="ad-label">Price</span>
        <strong class="hero num" id="ad-price">${price != null ? bigMoney(price, ccy) : bigMoney(priceOf(id), base())}</strong>
        <span class="perf-sub small num" id="ad-sub">${q?.changePct != null ? `<span class="${tone(q.changePct)}">${q.changePct >= 0 ? '▲' : '▼'} ${fmtSignedMoney(q.change, ccy)} (${fmtPct(q.changePct)})</span> <span class="muted">today</span>` : ''}</span>
      </div>
      <div id="ad-chart"><div class="skeleton" style="height:200px"></div></div>
      <div class="ranges" role="radiogroup" aria-label="Chart range">${SERIES_RANGES.map(([v, l]) => `<label><input type="radio" name="ad-range" value="${v}"${v === range ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>
      ${h ? `<h3 class="eyebrow">Your investment</h3><div class="box">
        ${statRow('Value', money(h.value))}
        ${statRow('Return', `<span class="${tone(h.pl)}">${smoney(h.pl)} (${fmtPct(h.plPct)})</span>`)}
        ${day != null ? statRow('Today', `<span class="${tone(day)}">${smoney(day)}</span>`) : ''}
        ${statRow('Shares', fmtNum(h.qty, 8))}
        ${statRow('Average price', money(h.avg))}
        ${h.realized ? statRow('Realized', `<span class="${tone(h.realized)}">${smoney(h.realized)}</span>`) : ''}
        ${statRow('To ATH', ta == null ? '-' : ta < 0.01 ? 'At ATH' : fmtPct(ta))}
        ${statRow('Value at ATH', money(h.valueAtAth))}
      </div>` : `<div class="box">${statRow('All-time high', market.ath(id)?.ath ? fmtMoney(market.ath(id).ath, ccy) : '-')}${statRow('To ATH', ta == null ? '-' : ta < 0.01 ? 'At ATH' : fmtPct(ta))}</div>`}
      <div class="detail-actions">
        ${h ? `<button class="btn block" type="button" id="ad-sell">Sell</button>` : ''}
        <button class="btn primary block" type="button" id="ad-buy">Buy</button>
        <button class="icon-btn" type="button" id="ad-ai" aria-label="Analyze with AI">${icon('sparkles')}</button>
      </div>
    </div>`, (body) => {
    $('#ad-buy', body).onclick = () => openTx({ assetId: id });
    $('#ad-sell', body)?.addEventListener('click', () => openTx({ assetId: id, type: 'sell' }));
    $('#ad-ai', body).onclick = () => { $('#sheet').close(); ui.aiAsset = id; location.hash = 'ai'; analyzeAsset(id); };
    const box = $('#ad-chart', body);
    let series = null;
    const draw = () => {
      if (!series) return;
      const days = SERIES_RANGES.find((r) => r[0] === range)[2];
      const from = isoDaysAgo(days);
      let pts = series.filter((p) => p.date >= from);
      if (price != null && pts.length && pts[pts.length - 1].date < todayISO()) pts = [...pts, { date: todayISO(), close: price }];
      if (pts.length < 2) { box.innerHTML = '<p class="muted small chart-empty">Not enough history.</p>'; return; }
      const f0 = pts[0].close, lastPx = pts[pts.length - 1].close;
      const color = lastPx >= f0 ? 'var(--success)' : 'var(--danger)';
      const avgLocal = h && market.fxRate(ccy, base()) ? h.avg / market.fxRate(ccy, base()) : null;
      const closes = pts.map((p) => p.close);
      // Draw the average-price line only when it doesn't flatten the price line
      const avgInView = avgLocal && avgLocal > Math.min(...closes) * 0.85 && avgLocal < Math.max(...closes) * 1.15;
      const chart = lineChart([
        { values: closes, color, fill: true },
        ...(avgInView ? [{ values: pts.map(() => avgLocal), color: 'var(--muted)', dash: true }] : []),
      ], { height: 200, label: `${a.name} price` });
      box.innerHTML = chart.html + (avgLocal ? `<div class="lc-legend small muted"><span><i class="sw dashed"></i>Your average ${fmtMoney(avgLocal, ccy)}</span></div>` : '');
      const lab = $('#ad-label', body), pr = $('#ad-price', body), sb = $('#ad-sub', body);
      const restHtml = { lab: lab.textContent, pr: pr.innerHTML, sb: sb.innerHTML };
      bindScrub(box, chart, {
        onMove: (i) => {
          const p = pts[i], ch = p.close - f0;
          lab.textContent = fmtDate(p.date);
          pr.innerHTML = bigMoney(p.close, ccy);
          sb.innerHTML = `<span class="${tone(ch)}">${ch >= 0 ? '▲' : '▼'} ${fmtSignedMoney(ch, ccy)} (${fmtPct((ch / f0) * 100)})</span> <span class="muted">since ${fmtDate(pts[0].date, { month: 'short', day: 'numeric' })}</span>`;
        },
        onEnd: () => { lab.textContent = restHtml.lab; pr.innerHTML = restHtml.pr; sb.innerHTML = restHtml.sb; },
      });
    };
    $$('[name=ad-range]', body).forEach((r) => (r.onchange = () => { range = r.value; draw(); }));
    if (a.source === 'none') { box.innerHTML = '<p class="muted small chart-empty">No price history for this listing.</p>'; return; }
    market.getSeries(a).then((s) => { series = s; draw(); })
      .catch((e) => { box.innerHTML = `<p class="muted small chart-empty">${esc(e.message)}</p>`; });
  });
}

function renderTx() {
  const box = $('#tx-section');
  if (!box) return;
  const all = store.state.transactions;
  if (!port.txOpen) {
    box.innerHTML = `<div class="tx-head"><h2 class="eyebrow">Transactions</h2><button class="btn small" type="button" data-act="tx-toggle">Show ${all.length}</button></div>`;
    return;
  }
  const q = port.q.trim().toLowerCase();
  const amount = (t) => t.qty * t.price + (t.type === 'buy' ? 1 : -1) * (+t.fee || 0);
  let list = all.filter((t) =>
    (!port.asset || t.assetId === port.asset) &&
    (!port.type || t.type === port.type) &&
    (!q || `${assetName(t.assetId)} ${assetById(t.assetId)?.symbol || ''} ${t.note || ''}`.toLowerCase().includes(q)));
  const sorters = {
    new: (a, b) => b.date.localeCompare(a.date), old: (a, b) => a.date.localeCompare(b.date),
    big: (a, b) => amount(b) - amount(a), small: (a, b) => amount(a) - amount(b),
  };
  list = list.sort(sorters[port.txSort]);
  const pages = Math.max(1, Math.ceil(list.length / TX_PAGE));
  port.page = Math.min(port.page, pages);
  const pageItems = list.slice((port.page - 1) * TX_PAGE, port.page * TX_PAGE);
  const withTx = [...new Set(all.map((t) => t.assetId))].map(assetById).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const opt = (v, l, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`;
  const typeLabel = { buy: 'Buy', sell: 'Sell', split: 'Split' };

  box.innerHTML = `
    <div class="tx-head"><h2 class="eyebrow">Transactions</h2><button class="btn ghost small" type="button" data-act="tx-toggle">Hide</button></div>
    <div class="tx-filters">
      <div class="field"><label for="tx-q">Search</label><input id="tx-q" type="search" value="${esc(port.q)}" placeholder="Asset, ticker or note" autocomplete="off"></div>
      <div class="field"><label for="tx-f-asset">Asset</label><select id="tx-f-asset">${opt('', 'All assets', port.asset)}${withTx.map((a) => opt(a.id, a.name, port.asset)).join('')}</select></div>
      <div class="field"><label for="tx-f-type">Type</label><select id="tx-f-type">${opt('', 'All types', port.type)}${opt('buy', 'Buys', port.type)}${opt('sell', 'Sells', port.type)}${opt('split', 'Splits and spin-offs', port.type)}</select></div>
      <div class="field"><label for="tx-f-sort">Sort</label><select id="tx-f-sort">${opt('new', 'Newest first', port.txSort)}${opt('old', 'Oldest first', port.txSort)}${opt('big', 'Largest amount', port.txSort)}${opt('small', 'Smallest amount', port.txSort)}</select></div>
    </div>
    <p class="small muted num">${list.length} of ${all.length}${list.length ? ` · ${money(list.reduce((s, t) => s + (t.type === "buy" ? amount(t) : t.type === "sell" ? -amount(t) : 0), 0))} net bought` : ''}</p>
    ${pageItems.length ? `<ul class="tx-list">${pageItems.map((t) => `
      <li data-id="${t.id}">
        <span class="chip ${t.type}">${typeLabel[t.type] || t.type}</span>
        <div class="tx-main"><strong>${esc(assetName(t.assetId))}</strong><span class="small muted num">${fmtDate(t.date)} · ${fmtNum(t.qty)}${t.type === 'split' ? ' shares' : ` @ ${money(t.price)}`}${t.note ? ` · ${esc(t.note)}` : ''}</span></div>
        <span class="num">${t.type === 'split' ? '' : money(amount(t))}</span>
        <button class="icon-btn" type="button" data-act="del-tx" aria-label="Delete transaction">${icon('trash', 18)}</button>
      </li>`).join('')}</ul>` : '<p class="muted">No transactions match these filters.</p>'}
    ${pages > 1 ? `<nav class="pager" aria-label="Transaction pages">
      <button class="btn small" type="button" data-act="tx-page" data-page="${port.page - 1}"${port.page === 1 ? ' disabled' : ''}>Previous</button>
      <span class="small muted num">Page ${port.page} of ${pages}</span>
      <button class="btn small" type="button" data-act="tx-page" data-page="${port.page + 1}"${port.page === pages ? ' disabled' : ''}>Next</button>
    </nav>` : ''}`;

  const refilter = (fn) => (e) => { fn(e.target.value); port.page = 1; renderTx(); };
  $('#tx-q', box).addEventListener('input', (e) => {
    port.q = e.target.value; port.page = 1;
    const pos = e.target.selectionStart;
    renderTx();
    const input = $('#tx-q');
    input.focus();
    input.setSelectionRange(pos, pos);
  });
  $('#tx-f-asset', box).onchange = refilter((v) => (port.asset = v));
  $('#tx-f-type', box).onchange = refilter((v) => (port.type = v));
  $('#tx-f-sort', box).onchange = refilter((v) => (port.txSort = v));
}

function openTx({ assetId, type = 'buy' } = {}) {
  const assets = store.state.assets;
  if (!assets.length) return toast('Add an asset in Markets first.');
  const first = assetId || assets[0].id;
  const p0 = priceOf(first);
  openSheet('Log transaction', `
    <form class="form" id="tx-form" novalidate>
      <div class="field"><span class="label" id="tx-type-label">Type</span>
        <div class="seg" role="radiogroup" aria-labelledby="tx-type-label"><label><input type="radio" name="type" value="buy"${type === 'buy' ? ' checked' : ''}><span>Buy</span></label><label><input type="radio" name="type" value="sell"${type === 'sell' ? ' checked' : ''}><span>Sell</span></label></div></div>
      <div class="field"><label for="tx-asset">Asset</label><select id="tx-asset" name="assetId">${assetOptions(first)}</select></div>
      <div class="field"><label for="tx-date">Date</label><input id="tx-date" name="date" type="date" value="${todayISO()}" max="${todayISO()}" required></div>
      <div class="row-2">
        <div class="field"><label for="tx-price">Price per unit (${base()})</label><input id="tx-price" name="price" type="number" inputmode="decimal" step="any" min="0" value="${p0 != null ? round(p0, 6) : ''}"></div>
        <div class="field"><label for="tx-amount">Amount (${base()})</label><input id="tx-amount" name="amount" type="number" inputmode="decimal" step="any" min="0"></div>
      </div>
      <div class="row-2">
        <div class="field"><label for="tx-qty">Quantity</label><input id="tx-qty" name="qty" type="number" inputmode="decimal" step="any" min="0"></div>
        <div class="field"><label for="tx-fee">Fee (${base()})</label><input id="tx-fee" name="fee" type="number" inputmode="decimal" step="any" min="0" value="0"></div>
      </div>
      <p class="form-error" id="tx-error" role="alert"></p>
      <button class="btn primary block" type="submit">Save transaction</button>
    </form>`, (body, close) => {
    const f = $('#tx-form', body);
    const num = (i) => parseFloat(i.value);
    f.assetId.onchange = () => { const p = priceOf(f.assetId.value); f.price.value = p != null ? round(p, 6) : ''; if (num(f.qty)) f.amount.value = round(num(f.qty) * (p || 0)); };
    f.amount.oninput = () => { if (num(f.price)) f.qty.value = round(num(f.amount) / num(f.price), 8) || ''; };
    f.qty.oninput = () => { if (num(f.price)) f.amount.value = round(num(f.qty) * num(f.price)) || ''; };
    f.price.oninput = () => { if (num(f.qty)) f.amount.value = round(num(f.qty) * num(f.price)) || ''; };
    f.onsubmit = (e) => {
      e.preventDefault();
      const err = $('#tx-error', body);
      const t = { id: uid(), type: f.type.value, assetId: f.assetId.value, date: f.date.value, price: num(f.price), qty: num(f.qty), fee: num(f.fee) || 0 };
      if (!t.date) return (err.textContent = 'Pick a date.');
      if (!(t.price > 0)) return (err.textContent = 'Enter a price above 0.'), f.price.focus();
      if (!(t.qty > 0)) return (err.textContent = 'Enter an amount or quantity above 0.'), f.amount.focus();
      if (t.type === 'sell') {
        const held = holdings(store.state.transactions, priceOf).rows.find((r) => r.assetId === t.assetId)?.qty || 0;
        if (t.qty > held + 1e-9) return (err.textContent = `You hold ${fmtNum(held)}; you can't sell more than that.`);
      }
      store.update((s) => s.transactions.push(t));
      close();
      toast(`${t.type === 'buy' ? 'Buy' : 'Sell'} of ${assetName(t.assetId)} saved`);
      recordSnapshot();
    };
  });
}

function deleteTx(id) {
  const t = store.state.transactions.find((x) => x.id === id);
  if (!t) return;
  store.update((s) => (s.transactions = s.transactions.filter((x) => x.id !== id)));
  toast('Transaction deleted', { action: 'Undo', onAction: () => store.update((s) => s.transactions.push(t)) });
}

// ---------- Trading 212 import

function openImport() {
  openSheet('Import from Trading 212', `
    <div class="form">
      <p class="small muted">In Trading 212 open History, tap Export, pick a date range (one year per file) and download the CSV. You can add several files; overlapping rows are merged and trades already imported are skipped.</p>
      <div class="field"><label for="imp-files">CSV files</label><input id="imp-files" type="file" accept=".csv,text/csv" multiple></div>
      <div id="imp-summary" class="imp-summary"></div>
      <p class="form-error" id="imp-error" role="alert"></p>
    </div>`, (body, close) => {
    let summary = null;
    const err = $('#imp-error', body);
    const box = $('#imp-summary', body);

    $('#imp-files', body).onchange = async (e) => {
      err.textContent = '';
      box.innerHTML = '';
      const files = [...e.target.files];
      if (!files.length) return;
      try {
        const rows = [];
        for (const f of files) {
          const parsed = parseCsv(await f.text());
          if (!isT212(parsed)) throw new Error(`${f.name} doesn't look like a Trading 212 history export.`);
          rows.push(...parsed);
        }
        summary = summarize(rows);
        if (!summary.trades.length) throw new Error('No trades found in these files.');
      } catch (ex) {
        summary = null;
        err.textContent = ex.message;
        return;
      }
      const open = summary.assets.filter((a) => a.open);
      const closed = summary.assets.length - open.length;
      const manual = store.state.transactions.filter((t) => !t.extId?.startsWith('t212:')).length;
      const baseChanges = base() !== summary.base && store.state.transactions.length > 0;
      const converted = [...new Set(summary.trades.map((r) => r['Currency (Total)']).filter((c) => c && c !== summary.base))];
      box.innerHTML = `
        <div class="card imp-card">
          <p><strong>${summary.trades.length} trades</strong> from ${fmtDate(summary.from)} to ${fmtDate(summary.to)}${summary.skipped ? ` <span class="muted">(${summary.skipped} other rows skipped)</span>` : ''}</p>
          <p class="small">Portfolio currency: <strong>${summary.base}</strong>.${converted.length ? ` Amounts in ${converted.join(', ')} are converted at each trade date's rate${converted.includes('BGN') ? ' (BGN at the fixed 1.95583)' : ''}.` : ''}</p>
          ${summary.partial.length ? `<p class="small warn">Some sells include shares bought before ${fmtDate(summary.from)} (${summary.partial.map(esc).join(', ')}). Add an older export too for complete realized P/L.</p>` : ''}
          <p class="small"><strong>${open.length} open positions:</strong> ${open.map((a) => esc(a.name)).join(', ') || 'none'}${closed ? `. ${closed} closed positions are kept for realized P/L.` : '.'}</p>
        </div>
        ${manual ? `<div class="field"><span class="label" id="imp-mode-label">Your ${manual} manually logged transactions</span>
          <div class="seg wrap" role="radiogroup" aria-labelledby="imp-mode-label">
            <label><input type="radio" name="imp-mode" value="replace"${baseChanges ? ' checked' : ''}><span>Replace them</span></label>
            <label><input type="radio" name="imp-mode" value="keep"${baseChanges ? '' : ' checked'}><span>Keep them</span></label>
          </div>
          ${baseChanges ? `<p class="hint">They were logged in ${base()}; keeping them would mix currencies.</p>` : ''}</div>` : ''}
        <button class="btn primary block" type="button" id="imp-go">Import</button>`;

      $('#imp-go', box).onclick = async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        err.textContent = '';
        const step = (t) => (btn.textContent = t);
        try {
          const replace = $('input[name=imp-mode]:checked', box)?.value === 'replace';
          step('Loading exchange rates...');
          const days = Math.ceil((Date.now() - new Date(summary.from).getTime()) / 864e5) + 15;
          const fx = {};
          for (const ccy of summary.needFx) fx[ccy] = await market.fxHistory(summary.base, ccy, days);

          // Reuse assets already linked to an ISIN, create the rest
          const existing = new Map(store.state.assets.filter((a) => a.isin).map((a) => [a.isin, a]));
          const ids = new Map(summary.assets.map((a) => [a.isin, existing.get(a.isin)?.id || uid()]));
          const { txs, lastPrice } = buildTransactions(summary, fx, (isin) => ids.get(isin), uid);

          const newAssets = [];
          const updates = new Map();
          let i = 0;
          for (const a of summary.assets) {
            const last = lastPrice[a.isin];
            const patch = { lastPrice: last?.price ?? null, lastPriceDate: last?.date ?? null, archived: !a.open };
            const old = existing.get(a.isin);
            if (old) {
              updates.set(old.id, { ...patch, archived: old.archived && !a.open });
              continue;
            }
            let src = null;
            if (a.open) {
              step(`Finding prices ${++i}/${summary.assets.filter((x) => x.open).length}...`);
              try { src = await market.resolveIsin({ isin: a.isin, tickers: [...a.tickers], refPriceEur: summary.base === 'EUR' ? last?.price : null }); } catch { /* falls back to last trade price */ }
            }
            newAssets.push({
              id: ids.get(a.isin),
              name: a.name,
              symbol: src?.symbol || [...a.tickers].pop() || a.isin,
              kind: /\b(ETF|ETP|UCITS)\b|\((Acc|Dist)\)|iShares|Vanguard|Xtrackers|VanEck|Invesco|Amundi|SPDR/i.test(a.name) ? 'etf' : 'stock',
              source: src?.source || 'none',
              ...(src?.yahoo && { yahoo: src.yahoo }),
              currency: src?.currency || summary.base,
              isin: a.isin,
              ...patch,
            });
          }

          store.update((s) => {
            if (s.baseCurrency !== summary.base) s.snapshots = []; // old snapshots are in another currency
            s.baseCurrency = summary.base;
            s.assets = s.assets.map((x) => (updates.has(x.id) ? { ...x, ...updates.get(x.id) } : x)).concat(newAssets);
            if (replace) s.transactions = s.transactions.filter((t) => t.extId?.startsWith('t212:'));
            const have = new Set(s.transactions.map((t) => t.extId).filter(Boolean));
            s.transactions.push(...txs.filter((t) => !have.has(t.extId)));
          });
          const unpriced = newAssets.filter((x) => x.source === 'none' && !x.archived).length;
          close();
          toast(`Imported ${txs.length} trades${unpriced ? `. ${unpriced} holding${unpriced === 1 ? '' : 's'} use the last trade price` : ''}`);
          await refresh();
        } catch (ex) {
          err.textContent = `Import failed: ${ex.message}`;
          btn.disabled = false;
          btn.textContent = 'Import';
        }
      };
    };
  });
}

// =====================================================================
// Plan (DCA planner with allocation pie)
// =====================================================================

function newPlan() {
  const assets = store.state.assets.slice(0, 3);
  const base = Math.floor(100 / Math.max(1, assets.length));
  const plan = {
    id: uid(),
    name: `Plan ${store.state.plans.length + 1}`,
    mode: 'total',
    capital: 3000,
    amount: 250,
    durationValue: 3,
    durationUnit: 'months',
    frequency: 'weekly',
    startDate: todayISO(),
    allocations: assets.map((a, i) => ({ assetId: a.id, pct: i === 0 ? 100 - base * (assets.length - 1) : base })),
    executed: [],
  };
  store.update((s) => s.plans.push(plan));
  ui.planId = plan.id;
  render();
}

const currentPlan = () => store.state.plans.find((p) => p.id === ui.planId) || store.state.plans[0];

function renderPlan(el) {
  const plan = currentPlan();
  if (!plan) {
    el.innerHTML = emptyState('No plans yet',
      'Split a recurring buy across assets.',
      `<button class="btn primary" type="button" data-act="new-plan">${icon('plus')}Create a plan</button>`);
    return;
  }
  ui.planId = plan.id;
  const used = new Set(plan.allocations.map((a) => a.assetId));
  const free = store.state.assets.filter((a) => !used.has(a.id));

  el.innerHTML = `
    <div class="toolbar">
      ${store.state.plans.length > 1 ? `<div class="field inline"><label for="plan-pick">Plan</label><select id="plan-pick">${store.state.plans.map((p) => `<option value="${p.id}"${p.id === plan.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>` : '<span></span>'}
      <div class="btn-row"><button class="btn" type="button" data-act="new-plan">${icon('plus')}New plan</button>
      <button class="icon-btn" type="button" data-act="del-plan" aria-label="Delete this plan">${icon('trash')}</button></div>
    </div>
    <form id="plan-form" class="plan-layout" novalidate>
      <section class="card form">
        <h2>Setup</h2>
        <div class="field"><label for="p-name">Plan name</label><input id="p-name" name="name" value="${esc(plan.name)}" autocomplete="off"></div>
        <div class="field"><span class="label" id="mode-label">Mode</span>
          <div class="seg" role="radiogroup" aria-labelledby="mode-label">
            <label><input type="radio" name="mode" value="total"${plan.mode === 'total' ? ' checked' : ''}><span>Spread a total</span></label>
            <label><input type="radio" name="mode" value="fixed"${plan.mode === 'fixed' ? ' checked' : ''}><span>Fixed per buy</span></label>
          </div></div>
        ${plan.mode === 'total'
          ? `<div class="field"><label for="p-capital">Total (${base()})</label><input id="p-capital" name="capital" type="number" inputmode="decimal" min="0" step="any" value="${plan.capital}"></div>`
          : `<div class="field"><label for="p-amount">Per buy (${base()})</label><input id="p-amount" name="amount" type="number" inputmode="decimal" min="0" step="any" value="${plan.amount}"></div>`}
        <div class="row-2">
          <div class="field"><label for="p-dur">Invest over</label><input id="p-dur" name="durationValue" type="number" inputmode="numeric" min="1" step="1" value="${plan.durationValue}"></div>
          <div class="field"><label for="p-unit">Unit</label><select id="p-unit" name="durationUnit"><option value="weeks"${plan.durationUnit === 'weeks' ? ' selected' : ''}>Weeks</option><option value="months"${plan.durationUnit === 'months' ? ' selected' : ''}>Months</option></select></div>
        </div>
        <div class="row-2">
          <div class="field"><label for="p-freq">Buy frequency</label><select id="p-freq" name="frequency">${Object.entries(FREQS).map(([k, v]) => `<option value="${k}"${k === plan.frequency ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="field"><label for="p-start">First buy</label><input id="p-start" name="startDate" type="date" value="${plan.startDate}"></div>
        </div>
      </section>
      <section class="card">
        <h2>Allocation</h2>
        <div class="alloc">
          <div id="plan-donut"></div>
          <div class="alloc-rows">
            ${plan.allocations.map((al, i) => `
              <div class="alloc-row" data-i="${i}">
                <span class="dot" style="background:${assetColor(al.assetId)}"></span>
                <label class="sr-only" for="al-a-${i}">Asset</label>
                <select id="al-a-${i}" name="al-asset">${assetOptions(al.assetId, store.state.assets.filter((a) => a.id === al.assetId || !used.has(a.id)))}</select>
                <label class="sr-only" for="al-p-${i}">Percent</label>
                <div class="pct-input"><input id="al-p-${i}" name="al-pct" type="number" inputmode="decimal" min="0" max="100" step="any" value="${al.pct}"><span>%</span></div>
                <button class="icon-btn" type="button" data-act="del-alloc" aria-label="Remove from pie">${icon('x', 18)}</button>
              </div>`).join('')}
            <p id="alloc-sum" class="small"></p>
            <div class="btn-row">
              ${free.length ? `<button class="btn small" type="button" data-act="add-alloc">${icon('plus', 16)}Add asset</button>` : ''}
              ${plan.allocations.length > 1 ? `<button class="btn small" type="button" data-act="even-split">Split evenly</button>` : ''}
            </div>
          </div>
        </div>
      </section>
    </form>
    <section class="card" id="plan-results" aria-live="polite"></section>
    <section class="card"><h2>Schedule</h2><ul class="schedule" id="plan-schedule"></ul></section>`;

  $('#plan-pick', el)?.addEventListener('change', (e) => { ui.planId = e.target.value; render(); });
  const form = $('#plan-form', el);
  form.addEventListener('input', () => savePlanForm(form));
  form.addEventListener('change', (e) => {
    savePlanForm(form);
    if (e.target.name === 'mode' || e.target.name === 'al-asset') render();
  });
  updatePlanResults();
}

function savePlanForm(form) {
  const plan = currentPlan();
  const assetsSel = $$('[name=al-asset]', form).map((s) => s.value);
  const pcts = $$('[name=al-pct]', form).map((i) => parseFloat(i.value) || 0);
  store.update((s) => {
    const p = s.plans.find((x) => x.id === plan.id);
    p.name = form.name.value.trim() || 'Untitled plan';
    p.mode = form.mode.value;
    if (form.capital) p.capital = parseFloat(form.capital.value) || 0;
    if (form.amount) p.amount = parseFloat(form.amount.value) || 0;
    p.durationValue = parseInt(form.durationValue.value, 10) || 0;
    p.durationUnit = form.durationUnit.value;
    p.frequency = form.frequency.value;
    p.startDate = form.startDate.value || todayISO();
    p.allocations = assetsSel.map((assetId, i) => ({ assetId, pct: pcts[i] }));
  }, { silent: true });
  updatePlanResults();
}

function updatePlanResults() {
  const plan = currentPlan();
  const res = $('#plan-results');
  if (!plan || !res) return;
  const s = planSummary(plan, priceOf);
  const off = Math.abs(s.allocated - 100) > 0.01;

  const sumEl = $('#alloc-sum');
  if (sumEl) {
    sumEl.className = `small ${off ? 'warn' : 'ok'}`;
    sumEl.innerHTML = off ? `${icon('alert', 16)} Total ${fmtNum(s.allocated, 2)}%. Adjust to 100%.` : `${icon('check', 16)} Total 100%`;
  }
  const segs = plan.allocations.map((al) => ({ label: assetName(al.assetId), value: +al.pct || 0, color: assetColor(al.assetId) }));
  if (off && s.allocated < 100) segs.push({ label: 'Unallocated', value: 100 - s.allocated, color: 'var(--border)' });
  const d = $('#plan-donut');
  if (d) d.innerHTML = donut(segs, { label: 'Plan allocation', center: s.perBuy ? money(s.perBuy) : '' });

  if (!s.n) {
    res.innerHTML = `<h2>Result</h2><p class="muted">Set a duration and start date.</p>`;
    $('#plan-schedule').innerHTML = '';
    return;
  }
  res.innerHTML = `
    <h2>Result</h2>
    <div class="kpis">
      <div class="kpi"><span class="label">Number of buys</span><strong class="num">${s.n}</strong><span class="small muted">${FREQS[plan.frequency].toLowerCase()}</span></div>
      <div class="kpi"><span class="label">Each buy</span><strong class="num">${money(s.perBuy)}</strong></div>
      <div class="kpi"><span class="label">Total invested</span><strong class="num">${money(s.total)}</strong></div>
      <div class="kpi"><span class="label">Last buy</span><strong class="num">${fmtDate(s.end)}</strong></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Asset</th><th class="r">Share</th><th class="r">Per buy</th><th class="r">Over plan</th><th class="r">Units now</th></tr></thead>
      <tbody>${s.allocations.map((a) => `<tr><td><span class="dot" style="background:${assetColor(a.assetId)}"></span>${esc(assetName(a.assetId))}</td>
        <td class="r num">${fmtPct(+a.pct || 0, { signed: false, digits: 1 })}</td><td class="r num">${money(a.amount)}</td><td class="r num">${money(a.total)}</td>
        <td class="r num">${a.units != null ? fmtNum(a.units, 6) : '-'}</td></tr>`).join('')}</tbody>
    </table></div>`;

  const done = new Set(plan.executed || []);
  const today = todayISO();
  $('#plan-schedule').innerHTML = s.dates.map((date, i) => `
    <li class="${done.has(date) ? 'done' : ''}">
      <span class="small muted num">#${i + 1}</span>
      <span class="num">${fmtDate(date)}</span>
      <span class="num">${money(s.perBuy)}</span>
      ${done.has(date) ? `<span class="chip buy">${icon('check', 14)}Logged</span>`
        : date <= today ? `<button class="btn small" type="button" data-act="log-buy" data-date="${date}">Log buys</button>`
        : `<span class="small muted">Upcoming</span>`}
    </li>`).join('');
}

function logPlanBuy(date) {
  const plan = currentPlan();
  const s = planSummary(plan, priceOf);
  const missing = s.allocations.filter((a) => a.amount > 0 && !a.price);
  if (missing.length) return toast(`No current price for ${missing.map((a) => assetName(a.assetId)).join(', ')}. Refresh prices first.`, { kind: 'error' });
  const txs = s.allocations.filter((a) => a.amount > 0).map((a) => ({
    id: uid(), type: 'buy', assetId: a.assetId, date, qty: a.amount / a.price, price: a.price, fee: 0, note: plan.name, planId: plan.id,
  }));
  if (!txs.length) return toast('This plan has no allocation yet.', { kind: 'error' });
  store.update((st) => {
    st.transactions.push(...txs);
    const p = st.plans.find((x) => x.id === plan.id);
    p.executed = [...new Set([...(p.executed || []), date])];
  });
  recordSnapshot();
  const ids = new Set(txs.map((t) => t.id));
  toast(`Logged ${txs.length} buy${txs.length === 1 ? "" : "s"} for ${fmtDate(date)}`, {
    action: 'Undo',
    onAction: () => store.update((st) => {
      st.transactions = st.transactions.filter((t) => !ids.has(t.id));
      const p = st.plans.find((x) => x.id === plan.id);
      p.executed = p.executed.filter((d) => d !== date);
    }),
  });
}

function editAlloc(fn) {
  const plan = currentPlan();
  store.update((s) => fn(s.plans.find((p) => p.id === plan.id)));
}

// =====================================================================
// AI
// =====================================================================

function loadChat() {
  try { return JSON.parse(localStorage.getItem(CHAT_KEY)) || []; } catch { return []; }
}
function saveChat() {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(chat.slice(-60))); } catch { /* ignore */ }
}

function appData() {
  const { state } = store;
  const h = holdings(state.transactions, priceOf, athOf);
  return {
    portfolioCurrency: base(),
    note: 'Asset prices and ATHs are in each asset\'s own currency; portfolio figures are in portfolioCurrency.',
    assets: state.assets.map((a) => {
      const v = assetView(a);
      return { name: a.name, symbol: a.symbol, type: a.kind, currency: a.currency || 'USD', price: v.price, dayChangePct: v.q?.changePct ?? null, allTimeHigh: v.ath, athDate: v.at?.athDate ?? null, gainNeededToAthPct: v.toAth != null ? round(v.toAth) : null };
    }),
    portfolio: {
      totals: Object.fromEntries(Object.entries(h.totals).map(([k, v]) => [k, v != null ? round(v) : null])),
      holdings: h.open.map((r) => ({ asset: assetName(r.assetId), qty: r.qty, avgCost: round(r.avg, 4), costBasis: round(r.cost), price: r.price, value: r.value != null ? round(r.value) : null, unrealizedPL: r.pl != null ? round(r.pl) : null, unrealizedPLPct: r.plPct != null ? round(r.plPct) : null, valueAtAth: r.valueAtAth != null ? round(r.valueAtAth) : null })),
      recentTransactions: [...state.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 25).map((t) => ({ date: t.date, type: t.type, asset: assetName(t.assetId), qty: t.qty, price: t.price, fee: t.fee })),
      dailySnapshots: state.snapshots.slice(-60),
    },
    plans: state.plans.map((p) => {
      const s = planSummary(p, priceOf);
      return { name: p.name, mode: p.mode === 'total' ? 'spread total capital' : 'fixed amount per buy', frequency: p.frequency, firstBuy: p.startDate, lastBuy: s.end, buys: s.n, perBuy: round(s.perBuy), total: round(s.total), buysLogged: (p.executed || []).length, allocation: p.allocations.map((a) => ({ asset: assetName(a.assetId), pct: a.pct })) };
    }),
  };
}

function systemPrompt() {
  return `You are the analyst inside TRING, a personal app for tracking assets, all-time highs, a portfolio and DCA investment plans. Today is ${todayISO()}.

The user's app data is below; use it for any question about their assets, portfolio or plans.

Style: minimal. Answer in as few words as the question allows, usually under 100. Short bullets, no headings, no intro, no closing summary, no disclaimers. Numbers over adjectives. For a calculation, give one line: formula = result.

Never invent prices, dates or news. If data is missing, say so in one line.

<app_data>
${JSON.stringify(appData())}
</app_data>`;
}

function activeLine() {
  const k = activeProvider();
  if (!k) return '';
  const p = PROVIDERS[k];
  const model = p.models.find((m) => m.id === modelFor(k))?.label || modelFor(k);
  const left = serverKeys() ? ` · ${Math.max(0, cloud.info.limit - cloud.info.used)} of ${cloud.info.limit} requests left today` : '';
  return `<p class="active-ai small"><span class="live-dot" aria-hidden="true"></span><strong>${p.label}</strong> · ${esc(model)}${left} · <a href="#settings">Change</a></p>`;
}

function renderAI(el) {
  const st = store.settings;
  const list = availableProviders();
  const active = activeProvider();
  const p = active ? PROVIDERS[active] : null;
  const off = ui.busy || !active ? ' disabled' : '';
  el.innerHTML = `
    <section class="card ai-controls">
      ${active ? `<div class="field">
          ${list.length > 1 ? `<span class="label" id="prov-label">Provider</span>
          <div class="seg full" role="radiogroup" aria-labelledby="prov-label">${list.map((k) =>
            `<label><input type="radio" name="provider" value="${k}"${k === active ? ' checked' : ''}><span>${PROVIDERS[k].label}</span></label>`).join('')}</div>` : ''}
          ${activeLine()}</div>
        <label class="check"><input type="checkbox" id="web-toggle"${st.web && p.web ? ' checked' : ''}${p.web ? '' : ' disabled'}>
          <span>Web search${p.web ? '' : ` (not on ${p.label})`}</span></label>`
      : `<div class="banner">${icon('alert')}<div><strong>No AI connected</strong><p>${serverKeys() ? 'No provider enabled on the server.' : 'Add an API key in Settings.'}</p></div>${serverKeys() ? '' : '<a class="btn" href="#settings">Open Settings</a>'}</div>`}
      <div class="quick">
        <div class="field inline grow"><label for="ai-asset">Asset</label><select id="ai-asset">${assetOptions(ui.aiAsset || store.state.assets[0]?.id)}</select></div>
        <button class="btn" type="button" data-act="ai-analyze"${off}>${icon('sparkles', 18)}Analyze</button>
        <button class="btn" type="button" data-act="ai-portfolio"${off}>Review portfolio</button>
        <button class="btn" type="button" data-act="ai-plan"${off}>Review plan</button>
      </div>
    </section>
    <section class="chat card" id="chat-log" aria-live="polite"></section>
    <form id="chat-form" class="composer">
      <label class="sr-only" for="chat-input">Message</label>
      <textarea id="chat-input" rows="2" placeholder="Ask about your portfolio"></textarea>
      <button class="btn primary" type="submit" aria-label="Send"${off}>${icon('send', 18)}</button>
    </form>`;

  $$('[name=provider]', el).forEach((r) => (r.onchange = () => { store.setSettings({ provider: r.value }); renderAI(el); }));
  $('#web-toggle', el)?.addEventListener('change', (e) => store.setSettings({ web: e.target.checked }));
  $('#ai-asset', el).onchange = (e) => (ui.aiAsset = e.target.value);
  const input = $('#chat-input', el);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form', el).requestSubmit(); }
  });
  $('#chat-form', el).onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || ui.busy) return;
    input.value = '';
    sendChat(text);
  };
  renderChat();
}

function renderChat() {
  const log = $('#chat-log');
  if (!log) return;
  if (!chat.length && !ui.busy) {
    log.innerHTML = `<div class="chat-empty"><h2>Ask TRING</h2><p class="muted">It sees your assets, holdings and plans.</p></div>`;
    return;
  }
  log.innerHTML = chat.map((m) => {
    if (m.role === 'user') return `<div class="msg user"><div class="bubble">${esc(m.label || m.content)}</div></div>`;
    if (m.role === 'error') return `<div class="msg error" role="alert">${icon('alert', 16)}<span>${esc(m.content)}</span></div>`;
    const src = m.sources?.length
      ? `<details class="sources"><summary>${m.sources.length} sources</summary><ol>${m.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></li>`).join('')}</ol></details>` : '';
    return `<div class="msg ai"><div class="msg-meta small muted">${esc(PROVIDERS[m.provider]?.label || 'AI')}</div><div class="prose">${md(m.content)}</div>${src}</div>`;
  }).join('') +
    (ui.busy ? `<div class="msg ai"><div class="skeleton" style="height:14px;width:60%"></div><div class="skeleton" style="height:14px;width:85%;margin-top:8px"></div><div class="skeleton" style="height:14px;width:40%;margin-top:8px"></div></div>` : '') +
    (chat.length && !ui.busy ? `<div class="chat-foot"><button class="btn ghost small" type="button" data-act="clear-chat">Clear conversation</button></div>` : '');
  log.lastElementChild?.scrollIntoView({ block: 'nearest' });
}

function setBusy(busy) {
  ui.busy = busy;
  $$('[data-act^="ai-"], #chat-form [type=submit]').forEach((b) => (b.disabled = busy));
}

async function sendChat(content, label) {
  if (ui.busy) return;
  const provider = activeProvider();
  if (!provider) return toast(serverKeys() ? 'No AI provider is enabled yet.' : 'Add an AI API key in Settings first.', { kind: 'error' });
  chat.push({ role: 'user', content, label, ts: Date.now() });
  setBusy(true);
  renderChat();
  try {
    let history = chat.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-12);
    while (history[0]?.role === 'assistant') history = history.slice(1);
    const { text, sources } = await ask({
      provider,
      system: systemPrompt(),
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      web: store.settings.web,
    });
    chat.push({ role: 'assistant', content: text || '(empty response)', sources, provider, ts: Date.now() });
  } catch (e) {
    chat.push({ role: 'error', content: e.message, ts: Date.now() });
  } finally {
    setBusy(false);
    saveChat();
    renderChat();
  }
}

async function analyzeAsset(id) {
  const a = assetById(id);
  if (!a || ui.busy) return;
  const v = assetView(a);
  const crypto = a.source === 'coingecko';
  let ind = null, closes = [];
  try {
    const series = await market.getSeries(a, 200);
    ind = indicators(series, { crypto });
    closes = series.slice(-30).map((p) => `${p.date}: ${round(p.close, 4)}`);
  } catch (e) {
    toast(`Price history unavailable (${e.message}). Analyzing with the latest quote only.`, { kind: 'error' });
  }
  const f = (n, d = 2) => (n == null || !isFinite(n) ? 'n/a' : round(n, d));
  const prov = activeProvider();
  const web = store.settings.web && !!prov && PROVIDERS[prov].web;
  const prompt = `Analyze ${a.name} (${a.symbol}, ${KINDS[a.kind] || a.kind}).

Market data in ${a.currency || 'USD'}, as of ${todayISO()}:
- Price: ${f(v.price, 4)}; day change ${f(v.q?.changePct)}%
- All-time high: ${f(v.ath, 4)} on ${v.at?.athDate || 'n/a'}; gain needed to reach it: ${f(v.toAth)}%
${ind ? `- Returns: 1 week ${f(ind.r1w)}%, 1 month ${f(ind.r1m)}%, 3 months ${f(ind.r3m)}%, 6 months ${f(ind.r6m)}%
- SMA20 ${f(ind.sma20, 4)}, SMA50 ${f(ind.sma50, 4)}, SMA100 ${f(ind.sma100, 4)}
- RSI(14): ${f(ind.rsi, 1)}; 1-month annualized volatility: ${f(ind.vol1m, 1)}%
- Range over the last ${ind.bars} daily bars: ${f(ind.low, 4)} to ${f(ind.high, 4)}
- Last 30 daily closes:
${closes.join('\n')}` : '- Daily history: unavailable'}

${web ? 'Search for news from the last two weeks that explains recent moves.' : 'You cannot browse; skip news.'}

Reply in exactly this format, one short line each, nothing else:
**Verdict:** one sentence
- **Trend:**
- **Momentum:**
- **Levels:** support / resistance
- **Sentiment:**
- **News:** ${web ? 'the one item that matters, or "nothing notable"' : '"not checked"'}
- **To ATH:** gain needed and what it would take
${store.state.transactions.some((t) => t.assetId === a.id) || store.state.plans.some((p) => p.allocations.some((al) => al.assetId === a.id)) ? '- **For you:** effect on my holdings or plan' : ''}`;
  sendChat(prompt, `Analyze ${a.name}`);
}

// =====================================================================
// Settings
// =====================================================================

function syncDetail() {
  const { status, message } = store.sync;
  if (hosted) {
    if (status === 'error') return `Sync error: ${message}`;
    return status === 'syncing' ? 'Saving...' : 'Your data is saved to your account.';
  }
  if (!syncEnabled()) return 'Off. Add the web app URL and token to sync between devices.';
  if (status === 'error') return `Error: ${message}`;
  if (status === 'syncing') return 'Syncing...';
  return store.settings.lastSync ? `Last synced ${new Date(store.settings.lastSync).toLocaleString()}` : 'Not synced yet.';
}

function renderSettings(el) {
  const st = store.settings;
  const available = availableProviders();
  const active = activeProvider();
  const keyField = (id, label, value, help) => `
    <div class="field"><label for="${id}">${label}</label>
      <input id="${id}" type="password" autocomplete="off" spellcheck="false" value="${esc(value)}" placeholder="Not set">
      ${help ? `<p class="hint">${help}</p>` : ''}</div>`;
  const providerBlock = (k) => {
    const p = PROVIDERS[k];
    const status = k === active ? `<span class="chip buy">${icon('check', 14)}Active</span>`
      : available.includes(k) ? `<button class="btn small" type="button" data-act="use-provider" data-provider="${k}">Use ${p.label}</button>` : '';
    return `<div class="prov">
      <div class="prov-head"><h3>${p.label}</h3>${status}</div>
      <div class="row-2">
        ${serverKeys() ? '' : keyField(`s-key-${k}`, 'API key', st.keys[k], `<a href="${p.keyUrl}" target="_blank" rel="noopener">Get a key</a>`)}
        <div class="field"><label for="s-model-${k}">Model</label><select id="s-model-${k}">${p.models.map((m) => `<option value="${m.id}"${m.id === modelFor(k) ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div>
        ${k === 'claude' ? `<div class="field"><label for="s-claude-effort">Effort</label><select id="s-claude-effort">${['low', 'medium', 'high', 'xhigh', 'max'].map((e) => `<option value="${e}"${e === st.claudeEffort ? ' selected' : ''}>${e[0].toUpperCase() + e.slice(1)}${e === 'medium' ? ' (recommended)' : ''}</option>`).join('')}</select>
          </div>` : ''}
        ${k === 'claude' && !serverKeys() ? `<div class="field"><label for="s-claude-ws">Workspace ID (optional)</label>
          <input id="s-claude-ws" autocomplete="off" spellcheck="false" value="${esc(st.claudeWorkspace)}" placeholder="wrkspc_...">
</div>` : ''}
      </div></div>`;
  };
  const dataCard = `
    <section class="card form">
      <h2>Data</h2>
      <div class="btn-row">
        <button class="btn" type="button" data-act="export">${icon('download', 18)}Export</button>
        <button class="btn" type="button" data-act="import">${icon('upload', 18)}Import</button>
        <input type="file" id="import-file" accept="application/json,.json" hidden>
      </div>
    </section>
`;

  const own = serverKeys();
  const info = cloud.info;
  const accountCard = hosted ? `
    <section class="card form">
      <h2>Account</h2>
      <p>Signed in as <strong>${esc(cloud.user?.email)}</strong></p>
      ${own && info ? `<p class="small muted num">AI requests today: ${info.used} of ${info.limit}</p>` : ''}
      <p class="small" id="sync-detail">${esc(syncDetail())}</p>
      <div class="btn-row"><button class="btn" type="button" data-act="sign-out">Sign out</button></div>
    </section>` : '';
  const marketCard = hosted ? '' : `
    <section class="card form">
      <h2>Market data</h2>
      ${keyField('s-twelve', 'Twelve Data API key', st.twelveKey, '<a href="https://twelvedata.com/pricing" target="_blank" rel="noopener">Get a free key</a>')}
    </section>`;
  const aiCard = `
    <section class="card form">
      <h2>${own ? 'AI' : 'AI providers'}</h2>
      ${own
        ? (available.length ? available.map(providerBlock).join('') : '<p class="muted">No AI provider is enabled on the server yet.</p>')
        : `<p class="small muted">Keys stay on this device.</p>
           ${Object.keys(PROVIDERS).map(providerBlock).join('')}`}
    </section>`;
  const syncCard = hosted ? '' : `
    <section class="card form">
      <h2>Cloud sync</h2>
      <div class="field"><label for="s-sync-url">Web app URL</label><input id="s-sync-url" type="url" inputmode="url" autocomplete="off" value="${esc(st.syncUrl)}" placeholder="https://script.google.com/macros/s/.../exec"></div>
      ${keyField('s-sync-token', 'Sync token', st.syncToken, '')}
      <p class="small" id="sync-detail">${esc(syncDetail())}</p>
      <div class="btn-row"><button class="btn" type="button" data-act="sync-now">${icon('cloud', 18)}Sync now</button></div>
    </section>`;
  el.innerHTML = accountCard + marketCard + aiCard + syncCard + dataCard;

  const bind = (id, fn) => $(`#${id}`, el)?.addEventListener('change', (e) => { fn(e.target.value.trim()); toast('Saved'); });
  bind('s-twelve', (v) => { store.setSettings({ twelveKey: v }); refresh(); });
  Object.keys(PROVIDERS).forEach((k) => {
    bind(`s-key-${k}`, (v) => store.setSettings({ keys: { [k]: v } }));
    bind(`s-model-${k}`, (v) => store.setSettings({ models: { [k]: v } }));
  });
  bind('s-claude-effort', (v) => store.setSettings({ claudeEffort: v }));
  bind('s-claude-ws', (v) => store.setSettings({ claudeWorkspace: v }));
  bind('s-sync-url', (v) => { store.setSettings({ syncUrl: v }); pull(); });
  bind('s-sync-token', (v) => { store.setSettings({ syncToken: v }); pull(); });
  $('#import-file', el).onchange = importData;
}

function exportData() {
  const blob = new Blob([JSON.stringify(store.state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tring-backup-${todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importData(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.assets) || !Array.isArray(data.transactions)) throw new Error('This file is not a TRING backup.');
    const before = structuredClone(store.state);
    store.replace(data);
    toast('Data imported', { action: 'Undo', onAction: () => store.replace(before), timeout: 8000 });
    refresh();
  } catch (ex) {
    toast(`Import failed: ${ex.message}`, { kind: 'error' });
  }
}

// =====================================================================
// Actions (delegated)
// =====================================================================

const ACTIONS = {
  'add-asset': () => openAddAsset(),
  'remove-asset': (id) => removeAsset(id),
  retry: () => refresh(true),
  analyze: (id) => { ui.aiAsset = id; location.hash = 'ai'; analyzeAsset(id); },
  buy: (id) => openTx({ assetId: id }),
  'add-tx': () => openTx(),
  'open-asset': (id) => openAsset(id),
  cash: () => openCash(),
  'tx-toggle': () => { port.txOpen = !port.txOpen; renderTx(); },
  'tx-page': (_, btn) => { port.page = +btn.dataset.page; renderTx(); $('#tx-section')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); },
  'perf-retry': () => { perf.promise = null; loadPerf(); renderPerf(); },
  'import-t212': () => openImport(),
  'del-tx': (id) => deleteTx(id),
  'new-plan': () => newPlan(),
  'del-plan': () => {
    const plan = currentPlan();
    const idx = store.state.plans.indexOf(plan);
    store.update((s) => (s.plans = s.plans.filter((p) => p.id !== plan.id)));
    ui.planId = null;
    toast(`${plan.name} deleted`, { action: 'Undo', onAction: () => { store.update((s) => s.plans.splice(idx, 0, plan)); ui.planId = plan.id; render(); } });
  },
  'add-alloc': () => editAlloc((p) => {
    const used = new Set(p.allocations.map((a) => a.assetId));
    const next = store.state.assets.find((a) => !used.has(a.id));
    if (next) p.allocations.push({ assetId: next.id, pct: Math.max(0, 100 - p.allocations.reduce((s, a) => s + (+a.pct || 0), 0)) });
  }),
  'del-alloc': (_, btn) => editAlloc((p) => p.allocations.splice(+btn.closest('[data-i]').dataset.i, 1)),
  'even-split': () => editAlloc((p) => {
    const n = p.allocations.length;
    const base = Math.floor((100 / n) * 100) / 100;
    p.allocations.forEach((a, i) => (a.pct = i === 0 ? round(100 - base * (n - 1)) : base));
  }),
  'log-buy': (_, btn) => logPlanBuy(btn.dataset.date),
  'ai-analyze': () => analyzeAsset($('#ai-asset')?.value),
  'ai-portfolio': () => sendChat('Review my portfolio in at most 5 bullets: performance vs invested, concentration, distance to ATH, biggest risk, one thing to watch.', 'Review my portfolio'),
  'ai-plan': () => {
    const plan = currentPlan();
    if (!plan) return toast('Create a plan in the Plan tab first.');
    sendChat(`Review my plan "${plan.name}" in at most 5 bullets: is the allocation, frequency and duration sensible given prices and distance to ATH, DCA vs lump sum here, and one improvement.`, `Review plan: ${plan.name}`);
  },
  'clear-chat': () => {
    const old = chat;
    chat = [];
    saveChat();
    renderChat();
    toast('Conversation cleared', { action: 'Undo', onAction: () => { chat = old; saveChat(); renderChat(); } });
  },
  'use-provider': (_, btn) => {
    store.setSettings({ provider: btn.dataset.provider });
    render();
    toast(`${PROVIDERS[btn.dataset.provider].label} is now the active AI`);
  },
  'sign-out': async () => {
    await signOut();
    clearLocal();
    location.reload();
  },
  'sync-now': () => (syncEnabled() ? pull() : toast('Add the web app URL and token first.')),
  export: () => exportData(),
  import: () => $('#import-file').click(),
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !$('#view').contains(btn)) return;
  ACTIONS[btn.dataset.act]?.(btn.closest('[data-id]')?.dataset.id, btn);
});

// =====================================================================
// Boot
// =====================================================================

const GOOGLE_G = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function showGate(html) {
  $('.app').hidden = true;
  const g = $('#gate');
  g.hidden = false;
  g.innerHTML = `<div class="gate-card card">
    <div class="gate-brand"><img src="icon.svg" width="56" height="56" alt=""><h1>TRING</h1></div>
    ${html}</div>`;
}

function showLogin(error = '') {
  showGate(`
    <button class="btn block google" type="button" id="google-btn">${GOOGLE_G}Continue with Google</button>
    ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
    <p class="small muted">Invite only.</p>`);
  $('#google-btn').onclick = async (e) => {
    e.currentTarget.disabled = true;
    try { await signInWithGoogle(); } catch (ex) { showLogin(ex.message); }
  };
}

function showNoAccess() {
  showGate(`
    <p>You're signed in as <strong>${esc(cloud.user.email)}</strong>, but this email isn't on the access list yet.</p>
    <p class="small muted">Send this email address to the owner. Once you're added, reload this page.</p>
    <div class="btn-row"><button class="btn primary" type="button" onclick="location.reload()">Reload</button><button class="btn" type="button" id="gate-out">Sign out</button></div>`);
  $('#gate-out').onclick = async () => { await signOut(); clearLocal(); location.reload(); };
}

async function boot() {
  if (hosted) {
    try {
      await initAuth();
    } catch (e) {
      return showLogin(`Could not reach the server: ${e.message}`);
    }
    if (!cloud.user) return showLogin();
    if (!cloud.allowed) return showNoAccess();
    // Decides whether this account uses the server keys (owner) or its own
    try { await loadInfo(); } catch { cloud.info = null; }
  }

  buildNav();
  $('#refresh-btn').innerHTML = icon('refresh');
  $('#refresh-btn').onclick = () => refresh(true);
  store.subscribe((reason) => {
    if (reason === 'sync') renderSyncStatus();
    else if (reason === 'state' && ui.tab !== 'ai' && ui.tab !== 'settings') render();
    else if (reason === 'settings' && ui.tab === 'markets') render();
  });
  window.addEventListener('hashchange', route);
  route();
  renderSyncStatus();
  refresh();
  pull();
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 5 * 60e3);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { pull(); refresh(); } });
}

boot();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
