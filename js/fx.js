// Visual effects, ported from React Bits to vanilla JS:
// - Spotlight Card (panels), Specular Button (primary buttons), Magic Bento (P&L tiles): one shared light.
//   With a mouse the light follows the pointer; on phones it follows device tilt and only shows while
//   the phone is moving, so nothing depends on hover.
// - Glass Surface: the tab bar's edge catches the same light (the glass itself is CSS).
// - Magic Rings: canvas rings for the AI and sign-in screens.
import { store } from './store.js';

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const mouse = matchMedia('(hover: hover) and (pointer: fine)');
const SURFACES = '.card:not(.no-fx), .panel:not(.no-fx), .btn.primary, .pnl, .nav';
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

function initMouse() {
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    light.tilt = false;
    light.tx = e.clientX; light.ty = e.clientY;
    light.ton = fxEnabled() ? 1 : 0;
    wake();
  }, { passive: true });
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) { light.ton = 0; wake(); } });
  addEventListener('scroll', () => { if (light.on) wake(); }, { capture: true, passive: true });
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

// ---------- Magic Bento tap: ripple plus a few sparks

function initBento() {
  document.addEventListener('pointerdown', (e) => {
    const tile = e.target.closest?.('.pnl');
    if (!tile || !fxEnabled()) return;
    const r = tile.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const size = 2 * Math.hypot(Math.max(x, r.width - x), Math.max(y, r.height - y));
    const ripple = document.createElement('span');
    ripple.className = 'fx-ripple';
    ripple.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px`;
    tile.append(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.random() * 0.6, d = 18 + Math.random() * 16;
      const s = document.createElement('span');
      s.className = 'fx-spark';
      s.style.cssText = `left:${x}px;top:${y}px;--dx:${(Math.cos(a) * d).toFixed(1)}px;--dy:${(Math.sin(a) * d).toFixed(1)}px`;
      tile.append(s);
      s.addEventListener('animationend', () => s.remove());
    }
  });
}

// ---------- Magic Rings (canvas): expanding rings that fade in and out, with a slight wobble

const RING_COLORS = [[45, 212, 191], [125, 211, 252]]; // teal to sky
export function magicRings(canvas, { count = 5, speed = 1, thickness = 1.5, base = 0.2, noise = 0.1, glow = 8, opacity = 0.9 } = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  let visible = true, t0 = performance.now(), id = 0;
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) loop(); });
  io.observe(canvas);
  const draw = (t) => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const R = Math.min(w, h) / 2;
    // Parallax toward the shared light (mouse or tilt)
    const cx = w / 2 + (light.on ? clamp((light.x - canvas.getBoundingClientRect().left - w / 2) * 0.05, -12, 12) : 0);
    const cy = h / 2 + (light.on ? clamp((light.y - canvas.getBoundingClientRect().top - h / 2) * 0.05, -12, 12) : 0);
    ctx.lineWidth = thickness;
    ctx.shadowBlur = glow;
    for (let i = 0; i < count; i++) {
      const p = (t * speed * 0.12 + i / count) % 1;
      const alpha = opacity * Math.min(1, p / 0.25, (1 - p) / 0.5);
      const c = RING_COLORS[0].map((v, k) => Math.round(v + (RING_COLORS[1][k] - v) * p));
      ctx.strokeStyle = ctx.shadowColor = `rgba(${c.join(',')},${alpha.toFixed(3)})`;
      const r = R * (base + p * (1 - base)) * 0.95;
      ctx.beginPath();
      for (let a = 0; a <= 64; a++) {
        const th = (a / 64) * Math.PI * 2;
        const rr = r * (1 + noise * 0.12 * Math.sin(th * 3 + t * 1.3 + i * 1.7));
        a ? ctx.lineTo(cx + rr * Math.cos(th), cy + rr * Math.sin(th)) : ctx.moveTo(cx + rr * Math.cos(th), cy + rr * Math.sin(th));
      }
      ctx.stroke();
    }
  };
  function loop() {
    cancelAnimationFrame(id);
    const tick = (now) => {
      if (!canvas.isConnected) { io.disconnect(); return; }
      draw((now - t0) / 1000);
      if (visible && !reduce.matches && document.visibilityState === 'visible') id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && canvas.isConnected) loop(); });
  loop();
}

export function initFx() {
  if (mouse.matches) initMouse(); else initTilt();
  initBento();
  store.subscribe((r) => { if (r === 'settings' && !fxEnabled()) { light.ton = 0; light.energy = 0; wake(); } });
}
