// Supabase: Google sign-in, per-user state, and the server-side AI and market proxies.
import { CONFIG } from './config.js';

export const hosted = !!(CONFIG.supabaseUrl && CONFIG.supabaseKey);
export const cloud = { user: null, allowed: false, info: null };

let client;
async function sb() {
  if (!client) {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
  }
  return client;
}

export async function initAuth() {
  const c = await sb();
  const { data: { session } } = await c.auth.getSession();
  cloud.user = session?.user || null;
  if (cloud.user) {
    const { data } = await c.rpc('is_allowed');
    cloud.allowed = !!data;
  }
  return cloud;
}

export async function signInWithGoogle() {
  const c = await sb();
  const { error } = await c.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
  if (error) throw error;
}

export async function signOut() {
  const c = await sb();
  await c.auth.signOut();
}

export async function loadState() {
  const c = await sb();
  const { data, error } = await c.from('user_state').select('data').eq('user_id', cloud.user.id).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.data || null;
}

export async function saveState(state) {
  const c = await sb();
  const { error } = await c.from('user_state').upsert({ user_id: cloud.user.id, data: state, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

export async function callFn(name, body) {
  const c = await sb();
  const { data, error } = await c.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return data;
}

export async function loadInfo() {
  cloud.info = await callFn('ai', { action: 'info' });
  return cloud.info;
}
