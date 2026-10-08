// DOM helpers, formatting, icons, toasts, sheets, SVG charts, tiny markdown renderer.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Formatting

const MINUS = '−';
const moneyFmt = {};
function moneyFormatter(digits, currency) {
  return (moneyFmt[`${currency}:${digits}`] ||= new Intl.NumberFormat('en-US', {
    style: 'currency', currency, minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits,
  }));
}

export function fmtMoney(n, currency = 'USD') {
  if (n == null || !isFinite(n)) return '-';
  const a = Math.abs(n);
  const s = moneyFormatter(a >= 1 || a === 0 ? 2 : 6, currency).format(a);
  return n < 0 ? MINUS + s : s;
}
// Gains and losses always show cents, never the extra precision used for sub-1 prices
export function fmtSignedMoney(n, currency = 'USD') {
  if (n == null || !isFinite(n)) return '-';
  return (n > 0 ? '+' : n < 0 ? MINUS : '') + moneyFormatter(2, currency).format(Math.abs(n));
}
export function fmtPct(n, { signed = true, digits = 2 } = {}) {
  if (n == null || !isFinite(n)) return '-';
  const sign = n > 0 && signed ? '+' : n < 0 ? MINUS : '';
  return `${sign}${Math.abs(n).toFixed(digits)}%`;
}
export function fmtNum(n, max = 6) {
  if (n == null || !isFinite(n)) return '-';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: max }).format(n);
}
export function fmtDate(iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!iso) return '-';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
}
export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

// ---------- Icons (lucide)

const ICONS = {
  trending: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  pie: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  banknote: '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  arrowUpRight: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
};

export const icon = (name, size = 20) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---------- Category colours (consistent per asset across charts)

const PALETTE = [
  'oklch(0.66 0.14 245)', 'oklch(0.75 0.14 75)', 'oklch(0.66 0.11 175)', 'oklch(0.63 0.17 15)',
  'oklch(0.6 0.15 300)', 'oklch(0.7 0.15 135)', 'oklch(0.68 0.15 45)', 'oklch(0.6 0.03 260)',
];
export const colorAt = (i) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];

// ---------- Toasts

export function toast(msg, { action, onAction, kind = '', timeout = 5000 } = {}) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="toast-btn" type="button">${esc(action)}</button>` : ''}`;
  host.append(el);
  const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  const t = setTimeout(kill, timeout);
  el.querySelector('button')?.addEventListener('click', () => { clearTimeout(t); onAction?.(); kill(); });
}

// ---------- Bottom sheet (dialog)

export function openSheet(title, bodyHtml, onMount) {
  const d = $('#sheet');
  d.innerHTML = `<div class="sheet-inner">
    <header class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" type="button" data-close aria-label="Close">${icon('x')}</button></header>
    <div class="sheet-body">${bodyHtml}</div></div>`;
  const close = () => d.close();
  d.querySelector('[data-close]').onclick = close;
  d.onclick = (e) => { if (e.target === d) close(); };
  d.showModal();
  onMount?.(d.querySelector('.sheet-body'), close);
}

// ---------- Charts

export function donut(segments, { size = 168, thickness = 22, label = 'Allocation', center = '' } = {}) {
  const segs = segments.filter((s) => s.value > 0);
  const total = segs.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  let off = 0;
  const arcs = segs.map((s) => {
    const len = (s.value / total) * c;
    const gap = segs.length > 1 ? Math.min(2, len / 3) : 0;
    const el = `<circle r="${r}" cx="${mid}" cy="${mid}" fill="none" stroke="${s.color}" stroke-width="${thickness}"
      stroke-dasharray="${Math.max(0, len - gap)} ${c - len + gap}" stroke-dashoffset="${-off}"><title>${esc(s.label)}</title></circle>`;
    off += len;
    return el;
  }).join('');
  return `<svg class="donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(label)}">
    <circle r="${r}" cx="${mid}" cy="${mid}" fill="none" stroke="var(--surface-2)" stroke-width="${thickness}"/>
    <g transform="rotate(-90 ${mid} ${mid})">${arcs}</g>
    ${center ? `<text x="${mid}" y="${mid}" text-anchor="middle" dominant-baseline="central" class="donut-center">${esc(center)}</text>` : ''}
  </svg>`;
}

// Line chart: tone-coloured line over a faint grid, soft gradient fill, end dot.
// Returns { html, values } for bindScrub; the first series is the one the cursor follows.
let chartSeq = 0;
export function lineChart(series, { height = 220, label = 'Chart', grid = true } = {}) {
  const W = 600, H = height;
  const all = series.flatMap((s) => s.values).filter((v) => v != null && isFinite(v));
  const n = Math.max(...series.map((s) => s.values.length));
  if (n < 2 || !all.length) return { html: '', values: [] };
  let min = Math.min(...all), max = Math.max(...all);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  min -= span * 0.06; max += span * 0.14;
  const x = (i) => (i * W) / (n - 1);
  const y = (v) => H - ((v - min) / (max - min)) * H;
  const id = `lc${++chartSeq}`;
  const lines = grid
    ? [1, 2, 3, 4, 5].map((k) => `<line x1="${(k * W) / 6}" x2="${(k * W) / 6}" y1="0" y2="${H}"/>`).join('') +
      [1, 2, 3].map((k) => `<line x1="0" x2="${W}" y1="${(k * H) / 4}" y2="${(k * H) / 4}"/>`).join('')
    : '';
  const paths = series.map((s, si) => {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const area = s.fill
      ? `<path d="${d} L${x(s.values.length - 1)} ${H} L0 ${H} Z" fill="url(#${id}-g${si})" stroke="none"/>
         <defs><linearGradient id="${id}-g${si}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity="0.28"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>`
      : '';
    return `${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.dash ? 1.25 : 2}" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ' stroke-dasharray="3 4" opacity="0.7"' : ''}/>`;
  }).join('');
  const main = series[0];
  const pos = main.values.map((v, i) => ({ l: (x(i) / W) * 100, t: (y(v) / H) * 100 }));
  const last = pos[pos.length - 1];
  return {
    values: main.values,
    pos,
    html: `<div class="lc" style="--lc-h:${height}px;--lc-c:${main.color}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><g class="lc-grid">${lines}</g>${paths}</svg>
      <span class="lc-end" style="left:${last.l}%;top:${last.t}%"></span>
      <span class="lc-cursor" hidden></span><span class="lc-dot" hidden></span>
    </div>`,
  };
}

// Drag / hover scrubbing. Mouse follows hover; touch follows the finger while it's down.
export function bindScrub(root, chart, { onMove, onEnd }) {
  const wrap = root.querySelector('.lc');
  if (!wrap || !chart.pos?.length) return;
  const cursor = wrap.querySelector('.lc-cursor'), dot = wrap.querySelector('.lc-dot'), end = wrap.querySelector('.lc-end');
  const n = chart.pos.length;
  let down = false, lastI = -1;
  const indexAt = (e) => {
    const r = wrap.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
  };
  const move = (e) => {
    const i = indexAt(e);
    if (i === lastI) return;
    lastI = i;
    const p = chart.pos[i];
    cursor.hidden = dot.hidden = false;
    end.hidden = true;
    cursor.style.left = dot.style.left = `${p.l}%`;
    dot.style.top = `${p.t}%`;
    onMove(i);
  };
  const stop = () => {
    down = false; lastI = -1;
    cursor.hidden = dot.hidden = true;
    end.hidden = false;
    onEnd();
  };
  wrap.addEventListener('pointerdown', (e) => {
    down = true;
    try { wrap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    move(e);
  });
  wrap.addEventListener('pointermove', (e) => { if (down || e.pointerType === 'mouse') move(e); });
  wrap.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') down = false; else stop(); });
  wrap.addEventListener('pointercancel', stop);
  wrap.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') stop(); });
  // Long-press must not open the copy / image callout
  wrap.addEventListener('contextmenu', (e) => e.preventDefault());
  wrap.addEventListener('selectstart', (e) => e.preventDefault());
}

// Money with smaller decimals, e.g. €28,657<small>.89</small>
export function bigMoney(n, currency) {
  const s = fmtMoney(n, currency);
  const k = s.lastIndexOf('.');
  return k < 0 ? esc(s) : `${esc(s.slice(0, k))}<small>${esc(s.slice(k))}</small>`;
}

// Count-up tween for headline numbers (after React Bits' CountUp)
export function countUp(el, from, to, render, ms = 600) {
  if (from == null || to == null || from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.innerHTML = render(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - (1 - k) ** 3;
    el.innerHTML = render(from + (to - from) * e);
    if (k < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- Markdown (subset: headings, bold, italics, code, links, lists, tables, paragraphs)

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function md(src) {
  const lines = esc(src).split('\n');
  const out = [];
  let list = null, para = [], table = [];
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter((r) => !/^\|?\s*:?-{2,}/.test(r)).map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim())));
    const [head, ...body] = rows;
    out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    table = [];
  };
  const flush = () => { flushPara(); flushList(); flushTable(); };

  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (/^\s*\|/.test(line)) { flushPara(); flushList(); table.push(line.trim()); continue; }
    flushTable();
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flush(); out.push(`<h${Math.min(4, m[1].length + 2)}>${inline(m[2])}</h${Math.min(4, m[1].length + 2)}>`); }
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { flushPara(); if (list?.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flushPara(); if (list?.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); }
    else if (!line.trim()) flush();
    else { flushList(); para.push(line.trim()); }
  }
  flush();
  return out.join('');
}
