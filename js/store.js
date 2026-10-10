import { hosted, cloud, loadState, saveState } from './cloud.js';

// App state (synced) and settings (device-only: API keys never leave this device except to their own provider).

const STATE_KEY = 'tring.state.v1';
const SETTINGS_KEY = 'tring.settings.v1';

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const DEFAULT_ASSETS = [
  { id: 'btc', name: 'Bitcoin', symbol: 'BTC', kind: 'crypto', source: 'coingecko', cgId: 'bitcoin' },
  { id: 'gold', name: 'Gold', symbol: 'XAU/USD', kind: 'commodity', source: 'twelve' },
  { id: 'ndx', name: 'Nasdaq 100 (QQQ)', symbol: 'QQQ', kind: 'index', source: 'twelve' },
  { id: 'spx', name: 'S&P 500 (SPY)', symbol: 'SPY', kind: 'index', source: 'twelve' },
];

export function defaultState() {
  return { schema: 1, updatedAt: 0, assets: structuredClone(DEFAULT_ASSETS), transactions: [], plans: [], snapshots: [], cash: { amount: 0, show: false } };
}

const DEFAULT_SETTINGS = {
  twelveKey: '',
  provider: 'claude',
  web: true,
  keys: { claude: '', openai: '', gemini: '', deepseek: '' },
  claudeWorkspace: '', // only for keys not scoped to a workspace
  models: { claude: 'claude-sonnet-5-5', openai: 'gpt-5.6-terra', gemini: 'gemini-flash-latest', deepseek: 'deepseek-v4-flash' },
  claudeEffort: 'medium',
  settingsVersion: 2,
  syncUrl: '',
  syncToken: '',
  lastSync: 0,
};

function read(key) {
  try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked or full */ }
}

function loadSettings() {
  const s = read(SETTINGS_KEY) || {};
  // v2: Claude default moved from Opus 5.5 to Sonnet 5.5 at medium effort
  if ((s.settingsVersion || 1) < 2 && s.models?.claude === 'claude-opus-5-5') s.models.claude = 'claude-sonnet-5-5';
  s.settingsVersion = 2;
  return { ...DEFAULT_SETTINGS, ...s, keys: { ...DEFAULT_SETTINGS.keys, ...s.keys }, models: { ...DEFAULT_SETTINGS.models, ...s.models } };
}
// The listing an asset is priced from; two assets with the same key (or ISIN) are the same instrument
export function priceKey(a) {
  if (a.source === 'coingecko') return a.cgId ? `cg:${a.cgId}` : null;
  if (a.source === 'twelve') return a.symbol ? `td:${a.symbol.toUpperCase()}` : null;
  if (a.source === 'yahoo') return a.yahoo ? `y:${a.yahoo.toUpperCase()}` : null;
  return null;
}
export const sameInstrument = (a, b) => (a.isin && a.isin === b.isin) || (priceKey(a) && priceKey(a) === priceKey(b));

// Merges duplicate assets (e.g. one added by hand and the same one from a Trading 212 import).
// The one with the most transactions is kept; transactions and plans move over to it.
export function dedupeAssets(state) {
  const count = new Map();
  for (const t of state.transactions || []) count.set(t.assetId, (count.get(t.assetId) || 0) + 1);
  const rank = (a) => (count.get(a.id) || 0) * 2 + (a.isin ? 1 : 0);
  const keep = [], moved = new Map();
  for (const a of state.assets || []) {
    const k = keep.findIndex((x) => sameInstrument(x, a));
    if (k < 0) { keep.push(a); continue; }
    const [win, lose] = rank(a) > rank(keep[k]) ? [a, keep[k]] : [keep[k], a];
    keep[k] = { ...lose, ...win, archived: !!(win.archived && lose.archived) };
    moved.set(lose.id, win.id);
  }
  if (!moved.size) return false;
  // Follow chains (a -> b -> c) so every reference lands on the final asset
  const to = (id) => { while (moved.has(id)) id = moved.get(id); return id; };
  state.assets = keep;
  for (const t of state.transactions || []) t.assetId = to(t.assetId);
  for (const f of state.cashflows || []) if (f.assetId) f.assetId = to(f.assetId);
  for (const p of state.plans || []) {
    const merged = [];
    for (const al of p.allocations || []) {
      const id = to(al.assetId);
      const prev = merged.find((x) => x.assetId === id);
      if (prev) prev.pct = (+prev.pct || 0) + (+al.pct || 0);
      else merged.push({ ...al, assetId: id });
    }
    p.allocations = merged;
  }
  return true;
}

const normalize = (s) => {
  const st = { ...defaultState(), ...(s || {}) };
  dedupeAssets(st);
  return st;
};

const listeners = new Set();

export const store = {
  state: normalize(read(STATE_KEY)),
  settings: loadSettings(),
  sync: { status: 'off', message: '' },

  subscribe(fn) { listeners.add(fn); },
  emit(reason) { listeners.forEach((fn) => fn(reason)); },

  // silent: persist + sync without re-rendering (used while the user is typing in a form)
  update(mutator, { silent = false } = {}) {
    mutator(this.state);
    dedupeAssets(this.state);
    this.state.updatedAt = Date.now();
    write(STATE_KEY, this.state);
    schedulePush();
    if (!silent) this.emit('state');
  },

  replace(next) {
    this.state = normalize(next);
    this.state.updatedAt = Date.now();
    write(STATE_KEY, this.state);
    schedulePush();
    this.emit('state');
  },

  setSettings(patch) {
    const s = this.settings;
    this.settings = { ...s, ...patch, keys: { ...s.keys, ...patch.keys }, models: { ...s.models, ...patch.models } };
    write(SETTINGS_KEY, this.settings);
    this.emit('settings');
  },
};

// ---------- Cloud sync (Google Apps Script web app, see apps-script/Code.gs)
// Shared mode syncs through Supabase instead. Last write wins, compared by state.updatedAt.

export const syncEnabled = () => (hosted ? cloud.allowed : !!(store.settings.syncUrl && store.settings.syncToken));

const remoteGet = async () => (hosted ? loadState() : (await call('get')).data);
const remoteSet = (data) => (hosted ? saveState(data) : call('set', { data }));

export function clearLocal() {
  [STATE_KEY, 'tring.chat.v1'].forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
}

function setSync(status, message = '') {
  store.sync = { status, message };
  store.emit('sync');
}

async function call(action, payload = {}) {
  // text/plain body keeps this a "simple" request, so Apps Script needs no CORS preflight
  const res = await fetch(store.settings.syncUrl, {
    method: 'POST',
    body: JSON.stringify({ action, token: store.settings.syncToken, ...payload }),
  });
  if (!res.ok) throw new Error(`Sync failed (HTTP ${res.status})`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Sync failed');
  return data;
}

export async function pull() {
  if (!syncEnabled()) return setSync('off');
  setSync('syncing');
  try {
    if (hosted) {
      // Data left on this device by another account must not leak into this one
      if (store.state.owner && store.state.owner !== cloud.user.id) store.state = defaultState();
      store.state.owner = cloud.user.id;
    }
    const data = await remoteGet();
    const remoteAt = data?.updatedAt || 0;
    const localAt = store.state.updatedAt || 0;
    if (data && remoteAt > localAt) {
      store.state = normalize(data);
      write(STATE_KEY, store.state);
      store.emit('state');
    } else if (localAt > remoteAt) {
      return push();
    }
    store.setSettings({ lastSync: Date.now() });
    setSync('ok');
  } catch (e) {
    setSync('error', e.message);
  }
}

let pushTimer;
function schedulePush() {
  if (!syncEnabled()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, 1500);
}

export async function push() {
  if (!syncEnabled()) return setSync('off');
  setSync('syncing');
  try {
    await remoteSet(store.state);
    store.setSettings({ lastSync: Date.now() });
    setSync('ok');
  } catch (e) {
    setSync('error', e.message);
  }
}
