// AI providers: Claude (Anthropic SDK), ChatGPT (OpenAI Responses API), DeepSeek (chat completions).
// Calls go straight from the browser to each provider with the user's own key.
import { store } from './store.js';
import { hosted, cloud, callFn } from './cloud.js';

// First model in each list is the default.
export const PROVIDERS = {
  claude: {
    label: 'Claude', web: true, keyUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (balanced)' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5 (smartest, higher cost)' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5 (fastest, cheapest)' },
    ],
  },
  openai: {
    label: 'ChatGPT', web: true, keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra (balanced)' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol (smartest, higher cost)' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna (fastest, cheapest)' },
    ],
  },
  gemini: {
    label: 'Gemini', web: true, keyUrl: 'https://aistudio.google.com/api-keys',
    // "-latest" aliases always point at Google's current version, so these IDs don't go stale
    models: [
      { id: 'gemini-flash-latest', label: 'Gemini Flash (free tier)' },
      { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite (fastest, free tier)' },
      { id: 'gemini-pro-latest', label: 'Gemini Pro (smartest, paid only)' },
    ],
  },
  deepseek: {
    label: 'DeepSeek', web: false, keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-v4-flash', label: 'V4 Flash (fast, cheap)' },
      { id: 'deepseek-v4-pro', label: 'V4 Pro (smarter)' },
    ],
  },
};

// Saved model if it's still offered, otherwise the provider default.
export function modelFor(provider) {
  const { models } = PROVIDERS[provider];
  const saved = store.settings.models[provider];
  return models.some((m) => m.id === saved) ? saved : models[0].id;
}

// Providers that can be used right now: server-enabled ones in shared mode, ones with a key otherwise.
export function availableProviders() {
  if (hosted) return Object.keys(PROVIDERS).filter((k) => cloud.info?.providers?.includes(k));
  return Object.keys(PROVIDERS).filter((k) => store.settings.keys[k]);
}

// The provider the user picked, falling back to the first available one.
export function activeProvider() {
  const list = availableProviders();
  return list.includes(store.settings.provider) ? store.settings.provider : list[0] || null;
}

export async function ask({ provider, system, messages, web }) {
  const { label } = PROVIDERS[provider];
  if (hosted) {
    const out = await callFn('ai', {
      provider, model: modelFor(provider), system, messages,
      web: web && PROVIDERS[provider].web, effort: store.settings.claudeEffort,
    });
    if (cloud.info) cloud.info.used = out.used;
    return out;
  }
  const key = store.settings.keys[provider];
  if (!key) throw new Error(`Add your ${label} API key in Settings.`);
  const model = modelFor(provider);
  const args = { key, model, system, messages, web: web && PROVIDERS[provider].web };
  try {
    if (provider === 'claude') return await askClaude(args);
    if (provider === 'openai') return await askOpenAI(args);
    if (provider === 'gemini') return await askGemini(args);
    return await askDeepSeek(args);
  } catch (e) {
    if (e instanceof TypeError) throw new Error(`Could not reach ${label}. Check your connection (or the provider blocks browser requests).`);
    throw e;
  }
}

// ---------- Claude

let anthropicSdk;
const ADAPTIVE = /^claude-(fable-5|opus-5|sonnet-5|opus-4-[678]|sonnet-4-6)/;
const FALLBACK = /^claude-(fable-5-1|opus-5-5|opus-5$|sonnet-5-5)/;

async function askClaude({ key, model, system, messages, web }) {
  anthropicSdk ||= await import('https://esm.sh/@anthropic-ai/sdk');
  const Anthropic = anthropicSdk.default;
  const workspace = store.settings.claudeWorkspace;
  const client = new Anthropic({
    apiKey: key,
    dangerouslyAllowBrowser: true,
    ...(workspace && { defaultHeaders: { 'anthropic-workspace-id': workspace } }),
  });

  const modern = ADAPTIVE.test(model);
  const params = { model, max_tokens: 16000, system };
  if (modern) {
    params.thinking = { type: 'adaptive' };
    params.output_config = { effort: store.settings.claudeEffort || 'medium' };
  }
  if (web) params.tools = [{ type: modern ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  // Server-side fallback reroutes a safety refusal to another model instead of failing the request
  const useFallback = FALLBACK.test(model);

  let convo = messages;
  let msg;
  const blocks = [];
  try {
    for (let i = 0; i < 4; i++) {
      msg = useFallback
        ? await client.beta.messages.stream({ ...params, messages: convo, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }).finalMessage()
        : await client.messages.stream({ ...params, messages: convo }).finalMessage();
      blocks.push(...msg.content);
      // Long server-tool turns (web search) can pause; resend to let Claude continue.
      if (msg.stop_reason !== 'pause_turn') break;
      convo = [...convo, { role: 'assistant', content: msg.content }];
    }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Claude rejected the API key. Check it in Settings.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude rate limit reached. Try again shortly.');
    if (e instanceof Anthropic.NotFoundError) throw new Error(`Claude model "${model}" was not found. Check the model name in Settings.`);
    if (/not scoped to a workspace/.test(e.message)) throw new Error('This Claude key is not tied to a workspace. Add your Workspace ID in Settings, or create a key inside a workspace.');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude error: ${e.message}`);
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request.');

  const sources = new Map();
  let text = '';
  for (const b of blocks) {
    if (b.type !== 'text') continue;
    text += b.text;
    (b.citations || []).forEach((c) => c.url && sources.set(c.url, c.title || c.url));
  }
  return { text: text.trim(), sources: [...sources].map(([url, title]) => ({ url, title })) };
}

// ---------- OpenAI (Responses API, built-in web search)

async function askOpenAI({ key, model, system, messages, web }) {
  const body = { model, instructions: system, input: messages.map((m) => ({ role: m.role, content: m.content })) };
  if (web) body.tools = [{ type: 'web_search' }];
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ChatGPT error: ${data.error?.message || `HTTP ${res.status}`}`);
  const sources = new Map();
  let text = '';
  for (const o of data.output || []) {
    if (o.type !== 'message') continue;
    for (const c of o.content || []) {
      if (c.type !== 'output_text') continue;
      text += c.text;
      (c.annotations || []).forEach((a) => a.type === 'url_citation' && sources.set(a.url, a.title || a.url));
    }
  }
  return { text: text.trim(), sources: [...sources].map(([url, title]) => ({ url, title })) };
}

// ---------- Gemini (generateContent, Google Search grounding)

async function askGemini({ key, model, system, messages, web }) {
  const body = {
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
  if (!res.ok) throw new Error(`Gemini error: ${data.error?.message || `HTTP ${res.status}`}`);
  const cand = data.candidates?.[0];
  if (!cand?.content) throw new Error(`Gemini returned no answer${cand?.finishReason ? ` (${cand.finishReason})` : ''}.`);
  const text = cand.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  const sources = (cand.groundingMetadata?.groundingChunks || [])
    .filter((c) => c.web?.uri)
    .map((c) => ({ url: c.web.uri, title: c.web.title || c.web.uri }));
  return { text: text.trim(), sources };
}

// ---------- DeepSeek (no web search)

async function askDeepSeek({ key, model, system, messages }) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`DeepSeek error: ${data.error?.message || `HTTP ${res.status}`}`);
  return { text: (data.choices?.[0]?.message?.content || '').trim(), sources: [] };
}
