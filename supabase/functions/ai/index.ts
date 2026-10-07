// TRING AI proxy: holds the provider keys and enforces a daily limit per user.
// Secrets (set only the ones you use): ANTHROPIC_API_KEY, ANTHROPIC_WORKSPACE_ID (optional),
// OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, DAILY_AI_LIMIT (default 25)
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const LIMIT = Number(Deno.env.get('DAILY_AI_LIMIT') || 25);

// Keep in sync with PROVIDERS in js/ai.js
const MODELS: Record<string, string[]> = {
  claude: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5'],
  openai: ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna'],
  gemini: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest'],
  deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro'],
};
const KEY_NAMES: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
};
const keyFor = (p: string) => Deno.env.get(KEY_NAMES[p]) || '';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

type Msg = { role: 'user' | 'assistant'; content: string };
type Args = { key: string; model: string; system: string; messages: Msg[]; web: boolean; effort: string };
type Out = { text: string; sources: { url: string; title: string }[] };

async function requireUser(req: Request) {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) throw new HttpError(401, 'Not signed in.');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user?.email) throw new HttpError(401, 'Session expired. Sign in again.');
  const { data: ok } = await admin.from('allowed_emails').select('role').eq('email', data.user.email.toLowerCase()).maybeSingle();
  if (!ok) throw new HttpError(403, 'Your account does not have access yet.');
  return { ...data.user, owner: ok.role === 'owner' };
}

// ---------- Providers

const ADAPTIVE = /^claude-(fable-5|opus-5|sonnet-5|opus-4-[678]|sonnet-4-6)/;
const FALLBACK = /^claude-(fable-5-1|opus-5-5|opus-5$|sonnet-5-5)/;

async function claude({ key, model, system, messages, web, effort }: Args): Promise<Out> {
  const workspace = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  const client = new Anthropic({ apiKey: key, ...(workspace && { defaultHeaders: { 'anthropic-workspace-id': workspace } }) });
  const modern = ADAPTIVE.test(model);
  // deno-lint-ignore no-explicit-any
  const params: any = { model, max_tokens: 16000, system };
  if (modern) {
    params.thinking = { type: 'adaptive' };
    params.output_config = { effort };
  }
  if (web) params.tools = [{ type: modern ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  const useFallback = FALLBACK.test(model);

  // deno-lint-ignore no-explicit-any
  let convo: any[] = messages;
  // deno-lint-ignore no-explicit-any
  let msg: any;
  // deno-lint-ignore no-explicit-any
  const blocks: any[] = [];
  try {
    for (let i = 0; i < 4; i++) {
      msg = useFallback
        ? await client.beta.messages.stream({ ...params, messages: convo, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }).finalMessage()
        : await client.messages.stream({ ...params, messages: convo }).finalMessage();
      blocks.push(...msg.content);
      if (msg.stop_reason !== 'pause_turn') break;
      convo = [...convo, { role: 'assistant', content: msg.content }];
    }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'The server Claude key was rejected.');
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'Claude rate limit reached. Try again shortly.');
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `Claude error: ${e.message}`);
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw new HttpError(422, 'Claude declined this request.');

  const sources = new Map<string, string>();
  let text = '';
  for (const b of blocks) {
    if (b.type !== 'text') continue;
    text += b.text;
    // deno-lint-ignore no-explicit-any
    (b.citations || []).forEach((c: any) => c.url && sources.set(c.url, c.title || c.url));
  }
  return { text: text.trim(), sources: [...sources].map(([url, title]) => ({ url, title })) };
}

async function openai({ key, model, system, messages, web }: Args): Promise<Out> {
  // deno-lint-ignore no-explicit-any
  const body: any = { model, instructions: system, input: messages };
  if (web) body.tools = [{ type: 'web_search' }];
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `ChatGPT error: ${data.error?.message || `HTTP ${res.status}`}`);
  const sources = new Map<string, string>();
  let text = '';
  for (const o of data.output || []) {
    if (o.type !== 'message') continue;
    for (const c of o.content || []) {
      if (c.type !== 'output_text') continue;
      text += c.text;
      // deno-lint-ignore no-explicit-any
      (c.annotations || []).forEach((a: any) => a.type === 'url_citation' && sources.set(a.url, a.title || a.url));
    }
  }
  return { text: text.trim(), sources: [...sources].map(([url, title]) => ({ url, title })) };
}

async function gemini({ key, model, system, messages, web }: Args): Promise<Out> {
  // deno-lint-ignore no-explicit-any
  const body: any = {
    system_instruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
  };
  if (web) body.tools = [{ google_search: {} }];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Gemini error: ${data.error?.message || `HTTP ${res.status}`}`);
  const cand = data.candidates?.[0];
  if (!cand?.content) throw new HttpError(502, `Gemini returned no answer${cand?.finishReason ? ` (${cand.finishReason})` : ''}.`);
  // deno-lint-ignore no-explicit-any
  const text = cand.content.parts.filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join('');
  const sources = (cand.groundingMetadata?.groundingChunks || [])
    // deno-lint-ignore no-explicit-any
    .filter((c: any) => c.web?.uri)
    // deno-lint-ignore no-explicit-any
    .map((c: any) => ({ url: c.web.uri, title: c.web.title || c.web.uri }));
  return { text: text.trim(), sources };
}

async function deepseek({ key, model, system, messages }: Args): Promise<Out> {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `DeepSeek error: ${data.error?.message || `HTTP ${res.status}`}`);
  return { text: (data.choices?.[0]?.message?.content || '').trim(), sources: [] };
}

const CALL: Record<string, (a: Args) => Promise<Out>> = { claude, openai, gemini, deepseek };

// ---------- Handler

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));

    if (body.action === 'info') {
      const { data } = await admin.from('ai_usage').select('count')
        .eq('user_id', user.id).eq('day', new Date().toISOString().slice(0, 10)).maybeSingle();
      return json({ owner: user.owner, providers: user.owner ? Object.keys(KEY_NAMES).filter(keyFor) : [], limit: LIMIT, used: data?.count || 0 });
    }
    // Only the owner's account may spend the server's AI keys; others call providers with their own keys
    if (!user.owner) throw new HttpError(403, 'Add your own AI API key in Settings.');

    const { provider, model, system, messages } = body;
    if (!KEY_NAMES[provider] || !keyFor(provider)) throw new HttpError(400, 'This AI provider is not enabled.');
    if (!MODELS[provider].includes(model)) throw new HttpError(400, 'Unknown model.');
    if (typeof system !== 'string' || system.length > 80000) throw new HttpError(400, 'Invalid request.');
    if (!Array.isArray(messages) || !messages.length || messages.length > 20) throw new HttpError(400, 'Invalid request.');
    const clean: Msg[] = messages.map((m: Msg) => {
      if (!['user', 'assistant'].includes(m?.role) || typeof m.content !== 'string' || m.content.length > 30000) {
        throw new HttpError(400, 'Invalid request.');
      }
      return { role: m.role, content: m.content };
    });
    const effort = EFFORTS.includes(body.effort) ? body.effort : 'medium';

    const { data: n, error } = await admin.rpc('bump_ai_usage', { p_user: user.id, p_limit: LIMIT });
    if (error) throw new Error(error.message);
    if (n === -1) throw new HttpError(429, `You've used all ${LIMIT} AI requests for today. The limit resets at midnight UTC.`);

    try {
      const out = await CALL[provider]({ key: keyFor(provider), model, system, messages: clean, web: !!body.web, effort });
      return json({ ...out, used: n, limit: LIMIT });
    } catch (e) {
      await admin.rpc('refund_ai_usage', { p_user: user.id });
      throw e;
    }
  } catch (e) {
    return json({ error: (e as Error).message }, (e as HttpError).status || 500);
  }
});
