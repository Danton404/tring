// Trading 212 CSV import: trades, splits and spin-offs, converted to the account currency.

const BGN_PER_EUR = 1.95583; // fixed peg; Bulgarian accounts were converted to EUR in 2026

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  const [head = [], ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

export const isT212 = (rows) => rows.length > 0 && ['Action', 'Time (UTC)', 'ISIN', 'No. of shares', 'Total'].every((k) => k in rows[0]);

const num = (v) => (v === '' || v == null ? null : Number(v));

// Every fee/tax column T212 may include, with its currency column
function fees(r) {
  return Object.keys(r)
    .filter((k) => /fee|tax/i.test(k) && !k.startsWith('Currency ('))
    .map((k) => ({ amount: num(r[k]) || 0, ccy: r[`Currency (${k})`] || r['Currency (Total)'] }))
    .filter((f) => f.amount);
}

// Cash rows: what each one does to the account's cash
export function cashKind(action) {
  const a = action.toLowerCase();
  if (a.startsWith('deposit')) return 'deposit';
  if (a.startsWith('withdrawal')) return 'withdrawal';
  if (a.startsWith('dividend')) return 'dividend';
  if (a.includes('interest')) return 'interest';
  if (/card debit|new card cost|spending(?! cashback)/.test(a)) return 'spend';
  if (a.includes('currency conversion')) return null; // moves cash between currencies, not in or out
  return 'other';
}
const rowKey = (r) => r.ID || `${r.Action}|${r['Time (UTC)']}|${r.ISIN || ''}|${r.Total}`;

// First pass: what the files contain, before any network calls
export function summarize(rows) {
  const seen = new Set();
  const trades = [];
  const cash = [];
  let skipped = 0;
  for (const r of rows) {
    const key = rowKey(r);
    if (seen.has(key)) continue; // overlapping exports
    seen.add(key);
    const action = (r.Action || '').toLowerCase();
    if (r.ISIN && /(buy|sell)$|stock split (open|close)|spin off/.test(action)) { trades.push(r); continue; }
    if (r.Total !== '' && r.Total != null && cashKind(action)) { cash.push(r); continue; }
    skipped++;
  }
  cash.sort((a, b) => a['Time (UTC)'].localeCompare(b['Time (UTC)']));
  trades.sort((a, b) => a['Time (UTC)'].localeCompare(b['Time (UTC)']));

  const totalCcys = new Set(trades.map((r) => r['Currency (Total)']).filter(Boolean));
  const base = totalCcys.has('EUR') || totalCcys.has('BGN') ? 'EUR' : [...totalCcys][0] || 'USD';
  const needFx = new Set();
  for (const r of [...trades, ...cash]) {
    for (const c of [r['Currency (Total)'], ...fees(r).map((f) => f.ccy)]) {
      if (c && c !== base && !(base === 'EUR' && c === 'BGN')) needFx.add(c);
    }
  }

  const byIsin = new Map();
  for (const r of trades) {
    const a = byIsin.get(r.ISIN) || { isin: r.ISIN, name: r.Name, tickers: new Set(), qty: 0, partial: false };
    a.name = r.Name || a.name;
    if (r.Ticker) a.tickers.add(r.Ticker);
    const q = num(r['No. of shares']) || 0;
    const action = r.Action.toLowerCase();
    if (/buy$|spin off|split open/.test(action)) a.qty += q;
    else {
      // Selling more than the files show being bought means shares from before the first export
      if (q > a.qty + 1e-6 && action.endsWith('sell')) a.partial = true;
      a.qty = Math.max(0, a.qty - q);
    }
    byIsin.set(r.ISIN, a);
  }
  for (const a of byIsin.values()) a.open = a.qty > 1e-6;

  const kinds = {};
  for (const r of cash) { const k = cashKind(r.Action); kinds[k] = (kinds[k] || 0) + 1; }
  return {
    trades,
    cash,
    cashKinds: kinds,
    skipped,
    base,
    needFx: [...needFx],
    assets: [...byIsin.values()],
    partial: [...byIsin.values()].filter((a) => a.partial).map((a) => a.name),
    from: trades[0]?.['Time (UTC)'].slice(0, 10),
    to: trades[trades.length - 1]?.['Time (UTC)'].slice(0, 10),
  };
}

// fx: { [ccy]: { 'YYYY-MM-DD': units of ccy per 1 base } }
function converter(base, fx) {
  return (amount, ccy, date) => {
    if (!amount) return 0;
    if (!ccy || ccy === base) return amount;
    if (base === 'EUR' && ccy === 'BGN') return amount / BGN_PER_EUR;
    const series = fx[ccy];
    if (!series) throw new Error(`Missing ${base}/${ccy} rates`);
    // Nearest earlier trading day (weekends and holidays have no rate)
    for (let d = new Date(`${date}T00:00:00Z`), i = 0; i < 10; i++, d.setUTCDate(d.getUTCDate() - 1)) {
      const rate = series[d.toISOString().slice(0, 10)];
      if (rate) return amount / rate;
    }
    throw new Error(`No ${base}/${ccy} rate near ${date}`);
  };
}

// Second pass: transactions in the base currency. assetIdFor(isin) maps ISINs to TRING assets.
export function buildTransactions(summary, fx, assetIdFor, uid) {
  const toBase = converter(summary.base, fx);
  const txs = [];
  const lastPrice = {};
  const splits = new Map();

  for (const r of summary.trades) {
    const action = r.Action.toLowerCase();
    const date = r['Time (UTC)'].slice(0, 10);
    const qty = num(r['No. of shares']) || 0;
    const assetId = assetIdFor(r.ISIN);

    if (action.startsWith('stock split')) {
      // T212 closes the old lot and opens a new one; only the share count changes
      const key = `${r.ISIN}|${r['Time (UTC)']}`;
      const s = splits.get(key) || { id: r.ID, delta: 0, date, assetId };
      s.delta += action.endsWith('open') ? qty : -qty;
      splits.set(key, s);
      continue;
    }
    if (action === 'spin off') {
      txs.push({ id: uid(), extId: `t212:${r.ID}`, type: 'split', assetId, date, qty, price: 0, fee: 0, note: 'Spin-off' });
      continue;
    }

    const total = toBase(num(r.Total), r['Currency (Total)'], date);
    const fee = fees(r).reduce((s, f) => s + toBase(f.amount, f.ccy, date), 0);
    const buy = action.endsWith('buy');
    // T212's Total already includes fees on buys and is net of fees on sells
    const price = qty ? (buy ? total - fee : total + fee) / qty : 0;
    lastPrice[r.ISIN] = { price, date };
    txs.push({ id: uid(), extId: `t212:${r.ID}`, type: buy ? 'buy' : 'sell', assetId, date, qty, price, fee, note: 'Trading 212' });
  }
  for (const s of splits.values()) {
    if (Math.abs(s.delta) > 1e-9) txs.push({ id: uid(), extId: `t212:${s.id}`, type: 'split', assetId: s.assetId, date: s.date, qty: s.delta, price: 0, fee: 0, note: 'Stock split' });
  }
  return { txs, lastPrice };
}

// Cash flows in the base currency: deposits, withdrawals, dividends, interest, card spending.
// Signed from the account's point of view (money in is positive).
export function buildCashflows(summary, fx, assetIdFor) {
  const toBase = converter(summary.base, fx);
  return summary.cash.map((r) => {
    const kind = cashKind(r.Action);
    const date = r['Time (UTC)'].slice(0, 10);
    const raw = toBase(num(r.Total), r['Currency (Total)'], date);
    const amount = kind === 'other' ? raw : ['withdrawal', 'spend'].includes(kind) ? -Math.abs(raw) : Math.abs(raw);
    return { extId: `t212:${rowKey(r)}`, kind, date, amount, ...(r.ISIN && { assetId: assetIdFor(r.ISIN), isin: r.ISIN }), ...(kind === 'other' && { note: r.Action }) };
  }).filter((f) => f.amount);
}
