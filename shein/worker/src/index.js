// Holds all API keys and forwards a narrow set of calls from the static site.
//   GET  /health         → which keys are configured
//   POST /jev            → TypeSafe Jev System One   { state, questions, assets? }
//   POST /gemini         → HKU Gemini text / vision  { model, body }
//   POST /image          → HKU Gemini image models   { model, prompt, aspectRatio }
//   POST /openai-image   → gpt-image-1.5 (waiting on HKU portal docs)
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const HKU_BASE = 'https://api.hku.hk/gemini/student/';
const TEXT_MODELS = ['gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.1-pro-preview'];
const IMAGE_MODELS = ['gemini-2.5-flash-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image'];
const PASSCODE_ROUTES = ['/gemini', '/image', '/openai-image'];
const MAX_BODY = { '/jev': 1_500_000, '/gemini': 6_000_000, '/image': 8_000 };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (!cors) return json({ error: 'origin not allowed' }, 403);
    const reply = (data, status = 200) => json(data, status, cors);

    if (url.pathname === '/health') {
      return reply({ ok: true, jev: !!env.JEV_API_KEY, hku: !!env.HKU_API_KEY, passcode: !!env.DEMO_PASSCODE });
    }
    if (req.method !== 'POST') return reply({ error: 'not found' }, 404);
    // Only the quota-limited HKU routes need the passcode; Jev powers the open swipe feed.
    if (env.DEMO_PASSCODE && PASSCODE_ROUTES.includes(url.pathname) && req.headers.get('x-demo-passcode') !== env.DEMO_PASSCODE) {
      return reply({ error: 'passcode required' }, 401);
    }

    const raw = await req.text();
    if (raw.length > (MAX_BODY[url.pathname] ?? 16_000)) return reply({ error: 'request too large' }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return reply({ error: 'invalid JSON' }, 400); }

    try {
      switch (url.pathname) {
        case '/jev': return reply(...(await jev(body, env)));
        case '/gemini': return reply(...(await gemini(body, env)));
        case '/image': return reply(...(await geminiImage(body, env)));
        case '/openai-image': return reply({ error: 'gpt-image-1.5 not wired yet: waiting on HKU portal documentation' }, 501);
        default: return reply({ error: 'not found' }, 404);
      }
    } catch (e) {
      return reply({ error: 'upstream failure', detail: String(e?.message || e) }, 502);
    }
  },
};

async function jev({ state, questions, assets }, env) {
  if (!env.JEV_API_KEY) return [{ error: 'JEV_API_KEY not configured' }, 500];
  if (!state || !questions || typeof questions !== 'object') return [{ error: 'state and questions required' }, 400];
  const t0 = Date.now();
  const r = await fetch(JEV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.JEV_API_KEY}`, 'Content-Type': 'application/json',
      // image inputs are experimental on Jev: 512×512 JPEG/PNG, referenced by asset key inside `state`
      ...(assets ? { 'TypeSafe-Danger-Zone-Images': 'true' } : {}),
    },
    body: JSON.stringify({ model: JEV_MODEL, state, questions, ...(assets ? { assets } : {}) }),
  });
  const data = await r.json().catch(() => ({ error: 'non-JSON response from Jev' }));
  return [{ ...data, latencyMs: Date.now() - t0 }, r.status];
}

async function hku(model, payload, env) {
  if (!env.HKU_API_KEY) return [{ error: 'HKU_API_KEY not configured' }, 500];
  const t0 = Date.now();
  const r = await fetch(`${HKU_BASE}${model}:generateContent`, {
    method: 'POST',
    headers: { [env.HKU_KEY_HEADER || 'api-key']: env.HKU_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({ error: `non-JSON response from HKU (${r.status})` }));
  return [{ ...data, latencyMs: Date.now() - t0 }, r.status];
}

function gemini({ model, body }, env) {
  if (!TEXT_MODELS.includes(model)) return [{ error: `model must be one of ${TEXT_MODELS.join(', ')}` }, 400];
  if (!body?.contents) return [{ error: 'body.contents required' }, 400];
  return hku(model, body, env);
}

function geminiImage({ model, prompt, aspectRatio = '4:5' }, env) {
  if (!IMAGE_MODELS.includes(model)) return [{ error: `model must be one of ${IMAGE_MODELS.join(', ')}` }, 400];
  if (!prompt || prompt.length > 4000) return [{ error: 'prompt required (max 4000 chars)' }, 400];
  return hku(model, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio } },
  }, env);
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) return { 'Content-Type': 'application/json' }; // curl / server-to-server
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!local && !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-demo-passcode',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
