// Light effects. With a mouse: Border Glow (after React Bits), the card edge nearest the pointer lights up.
// On phones: a faint rim light that follows device tilt and only shows while the phone is moving.
import { store } from './store.js';

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const mouse = matchMedia('(hover: hover) and (pointer: fine)');
const SURFACES = '.card:not(.no-fx), .panel:not(.no-fx)';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const fxEnabled = () => store.settings.motionFx !== false && !reduce.matches;

// ---------- Shared light

const light = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4, on: 0, ton: 0, energy: 0, tilt: false };
let raf = 0, last = 0, painted = false;

function frame(now) {
  raf = 0;
  const dt = clamp((now - last) / 1000, 0.001, 0.05);
  last = now;
  if (light.tilt) {
    // Tilt light fades out when the phone stops moving
    light.energy *= Math.exp(-dt / 0.6);
    if (light.energy < 0.05) light.energy = 0;
    light.ton = fxEnabled() ? clamp(light.energy / 10, 0, 1) : 0;
  }
  const follow = 1 - Math.exp(-dt / 0.07);
  if (light.on < 0.01 && light.ton > 0) { light.x = light.tx; light.y = light.ty; }
  light.x += (light.tx - light.x) * follow;
  light.y += (light.ty - light.y) * follow;
  light.on += (light.ton - light.on) * (1 - Math.exp(-dt / (light.ton > light.on ? 0.1 : 0.3)));
  if (Math.abs(light.ton - light.on) < 0.003) light.on = light.ton;
  paint();
  const moving = Math.abs(light.tx - light.x) > 0.3 || Math.abs(light.ty - light.y) > 0.3;
  if (moving || light.on !== light.ton || (light.tilt && light.energy > 0.05)) raf = requestAnimationFrame(frame);
}
const wake = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };

function paint() {
  if (light.on === 0 && !painted) return;
  painted = light.on > 0;
  const vh = innerHeight;
  const reach = light.tilt ? 260 : 90; // the tilt light is a broad sheen
  for (const el of document.querySelectorAll(SURFACES)) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.top > vh) continue;
    const x = light.x - r.left, y = light.y - r.top;
    const gap = Math.hypot(Math.max(0, -x, x - r.width), Math.max(0, -y, y - r.height));
    const o = light.on * (gap === 0 ? 1 : Math.max(0, 1 - gap / reach) ** 2);
    el.style.setProperty('--fx-x', `${x.toFixed(1)}px`);
    el.style.setProperty('--fx-y', `${y.toFixed(1)}px`);
    el.style.setProperty('--fx-o', o.toFixed(3));
  }
}

function initTilt() {
  let base = null, prev = null;
  const onTilt = (e) => {
    if (e.beta == null || e.gamma == null) return;
    // The rest pose adapts slowly to however the phone is being held
    base = base == null ? e.beta : base + (e.beta - base) * 0.02;
    if (prev) light.energy = Math.min(30, light.energy + Math.abs(e.beta - prev.b) + Math.abs(e.gamma - prev.g));
    prev = { b: e.beta, g: e.gamma };
    light.tilt = true;
    light.tx = innerWidth * (0.5 + clamp(e.gamma / 25, -1, 1) * 0.7);
    light.ty = innerHeight * (0.4 + clamp((e.beta - base) / 20, -1, 1) * 0.8);
    if (light.energy > 0.5) wake();
  };
  const P = window.DeviceOrientationEvent;
  if (!P) return;
  // Android sends events right away; iOS only after permission, asked on a tap
  addEventListener('deviceorientation', onTilt);
  if (typeof P.requestPermission === 'function') {
    const ask = () => P.requestPermission()
      .then((s) => { if (s === 'granted' || s === 'denied') removeEventListener('touchend', ask); })
      .catch(() => { /* not a user gesture yet; try on the next tap */ });
    addEventListener('touchend', ask);
  }
}

// ---------- Border Glow (mouse): the edge nearest the pointer lights up (CSS in app.css)

function initBorderGlow() {
  const sync = () => document.documentElement.classList.toggle('bglow', fxEnabled());
  sync();
  store.subscribe((r) => { if (r === 'settings') sync(); });
  reduce.addEventListener?.('change', sync);
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !fxEnabled()) return;
    const el = e.target.closest?.(SURFACES);
    if (!el) return;
    // Cards re-render often, so the glow layer is added on demand (last child: absolute, outside the layout)
    if (!el.querySelector(':scope > .edge-light')) el.insertAdjacentHTML('beforeend', '<span class="edge-light" aria-hidden="true"></span>');
    const r = el.getBoundingClientRect();
    const cx = r.width / 2, cy = r.height / 2;
    const dx = e.clientX - r.left - cx, dy = e.clientY - r.top - cy;
    // 0 at the centre, 1 on the edge, relative to the card's own shape
    const kx = dx ? cx / Math.abs(dx) : Infinity, ky = dy ? cy / Math.abs(dy) : Infinity;
    const edge = Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    if (deg < 0) deg += 360;
    el.style.setProperty('--edge-proximity', (edge * 100).toFixed(2));
    el.style.setProperty('--cursor-angle', `${deg.toFixed(2)}deg`);
  }, { passive: true });
}

export function initFx() {
  if (mouse.matches) initBorderGlow(); else initTilt();
  store.subscribe((r) => { if (r === 'settings' && !fxEnabled()) { light.ton = 0; light.energy = 0; wake(); } });
}
