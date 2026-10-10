// Exchange trading calendars: weekends plus each market's full-day closures.
// Crypto trades every day, so it adds no holidays (weekends are still skipped for plan buys).

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day = (y, m, d) => new Date(y, m - 1, d);
const shift = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const weekend = (d) => d.getDay() === 0 || d.getDay() === 6;

// Easter Sunday (anonymous Gregorian algorithm)
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return day(y, month, ((h + l - 7 * m + 114) % 31) + 1);
}
// nth weekday (0 = Sunday) of a month; n = -1 for the last one
function nth(y, m, wd, n) {
  if (n > 0) { const first = day(y, m, 1); return day(y, m, 1 + ((wd - first.getDay() + 7) % 7) + (n - 1) * 7); }
  const last = day(y, m + 1, 0);
  return day(y, m, last.getDate() - ((last.getDay() - wd + 7) % 7));
}
// US rule: Saturday holidays close the Friday before, Sunday ones the Monday after
const usObserved = (d) => (d.getDay() === 6 ? shift(d, -1) : d.getDay() === 0 ? shift(d, 1) : d);
// UK / Canada rule: weekend holidays move to the next free weekday
function substitutes(dates) {
  const out = [];
  for (let d of dates) {
    while (weekend(d) || out.some((x) => +x === +d)) d = shift(d, 1);
    out.push(d);
  }
  return out;
}

const RULES = {
  // NYSE / Nasdaq
  US: (y) => {
    const e = easter(y);
    const jan1 = day(y, 1, 1);
    return [
      ...(jan1.getDay() === 6 ? [] : [usObserved(jan1)]), // NYSE doesn't close on Dec 31 for a Saturday New Year
      nth(y, 1, 1, 3), nth(y, 2, 1, 3), shift(e, -2), nth(y, 5, 1, -1),
      ...(y >= 2022 ? [usObserved(day(y, 6, 19))] : []),
      usObserved(day(y, 7, 4)), nth(y, 9, 1, 1), nth(y, 11, 4, 4), usObserved(day(y, 12, 25)),
    ];
  },
  // Xetra / Frankfurt
  DE: (y) => { const e = easter(y); return [day(y, 1, 1), shift(e, -2), shift(e, 1), day(y, 5, 1), day(y, 12, 24), day(y, 12, 25), day(y, 12, 26), day(y, 12, 31)]; },
  // Euronext (Amsterdam, Paris, Brussels, Lisbon) and most other EU venues
  EU: (y) => { const e = easter(y); return [day(y, 1, 1), shift(e, -2), shift(e, 1), day(y, 5, 1), day(y, 12, 25), day(y, 12, 26)]; },
  // London
  UK: (y) => { const e = easter(y); return [...substitutes([day(y, 1, 1)]), shift(e, -2), shift(e, 1), nth(y, 5, 1, 1), nth(y, 5, 1, -1), nth(y, 8, 1, -1), ...substitutes([day(y, 12, 25), day(y, 12, 26)])]; },
  // Toronto
  CA: (y) => {
    const e = easter(y);
    const may24 = day(y, 5, 24); // Victoria Day: the Monday on or before May 24
    return [...substitutes([day(y, 1, 1)]), nth(y, 2, 1, 3), shift(e, -2), shift(may24, -((may24.getDay() + 6) % 7)),
      ...substitutes([day(y, 7, 1)]), nth(y, 8, 1, 1), nth(y, 9, 1, 1), nth(y, 10, 1, 2), ...substitutes([day(y, 12, 25), day(y, 12, 26)])];
  },
  // FX and spot metals: closed on New Year's Day and Christmas
  FX: (y) => [day(y, 1, 1), day(y, 12, 25)],
};
export const MARKET_NAMES = { US: 'US', DE: 'Xetra', EU: 'Euronext', UK: 'London', CA: 'Toronto', FX: 'FX' };

const memo = new Map();
function holidays(market, y) {
  const k = `${market}${y}`;
  if (!memo.has(k)) memo.set(k, new Set((RULES[market]?.(y) || []).map(iso)));
  return memo.get(k);
}

const SUFFIX = { DE: ['.DE', '.F', '.SG', '.MU', '.BE', '.DU', '.HM'], EU: ['.AS', '.PA', '.BR', '.LS', '.MI', '.MC', '.VI', '.SW', '.IR', '.HE', '.CO', '.ST', '.OL'], UK: ['.L'], CA: ['.TO', '.V', '.NE'] };

// Which calendar an asset trades on, or null for crypto (always open)
export function marketOf(a) {
  if (!a || a.kind === 'crypto' || a.source === 'coingecko') return null;
  if (a.kind === 'fx' || a.kind === 'commodity') return 'FX';
  const sym = (a.yahoo || a.symbol || '').toUpperCase();
  for (const [m, list] of Object.entries(SUFFIX)) if (list.some((s) => sym.endsWith(s))) return m;
  if (a.source === 'twelve' || a.currency === 'USD') return 'US';
  // Trading 212 fills EUR instruments without a live listing on Xetra
  return a.currency === 'EUR' || a.isin ? 'DE' : 'US';
}

// date: 'YYYY-MM-DD' or Date; markets: iterable of market codes
export function isTradingDay(date, markets = []) {
  const d = typeof date === 'string' ? day(...date.split('-').map(Number)) : date;
  if (weekend(d)) return false;
  const s = iso(d);
  for (const m of markets) if (holidays(m, d.getFullYear()).has(s)) return false;
  return true;
}

export function nextTradingDay(date, markets = []) {
  let d = typeof date === 'string' ? day(...date.split('-').map(Number)) : date;
  for (let i = 0; i < 14 && !isTradingDay(d, markets); i++) d = shift(d, 1);
  return d;
}
