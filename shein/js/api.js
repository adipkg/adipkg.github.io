// Calls to the Cloudflare Worker, which holds the API keys.
import { WORKER_URL } from './config.js';

const PASS_KEY = 'sd_passcode';

// Styled in-page dialog (no window.prompt). Resolves to the passcode, or null if cancelled.
function askPasscode(wasWrong) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog" class="sheet-body">
      <span class="eyebrow">Team demo</span><h2>Enter the demo passcode</h2>
      <p class="muted small">Image generation and Gemini features use a limited university quota, so they're locked to the presenting team.</p>
      ${wasWrong ? '<p class="err small">That passcode didn’t work.</p>' : ''}
      <input type="password" name="code" autocomplete="off" required aria-label="Passcode">
      <div class="row" style="margin-top:6px"><button class="btn primary" value="ok">Unlock</button><button class="btn ghost" value="cancel" formnovalidate>Cancel</button></div>
    </form>`;
    document.body.append(dlg);
    dlg.showModal();
    dlg.addEventListener('close', () => {
      const code = dlg.returnValue === 'ok' ? dlg.querySelector('input').value.trim() : '';
      dlg.remove();
      resolve(code || null);
    });
  });
}

async function post(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  try { const p = localStorage.getItem(PASS_KEY); if (p) headers['x-demo-passcode'] = p; } catch {}
  let r;
  try { r = await fetch(WORKER_URL + path, { method: 'POST', headers, body: JSON.stringify(body) }); }
  catch { throw new Error(`Can't reach the AI worker at ${WORKER_URL}`); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && data.error === 'passcode required') {
    try { localStorage.removeItem(PASS_KEY); } catch {}
    const p = await askPasscode(!!headers['x-demo-passcode']);
    if (p) { try { localStorage.setItem(PASS_KEY, p); } catch {} return post(path, body); }
    throw new Error('Passcode needed for image generation and Gemini features');
  }
  if (!r.ok) throw new Error(data.error || data.message || data.detail?.message || `${path} failed (${r.status})`);
  return data;
}

// TypeSafe Jev: typed decisions with probabilities.
export const jev = (state, questions, assets) => post('/jev', { state, questions, ...(assets ? { assets } : {}) });

// HKU Gemini text / vision. Returns the first text part.
export async function geminiText(parts, { model = 'gemini-3-flash-preview', system, json = false, temperature = 0.4 } = {}) {
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
  };
  if (system) body.system_instruction = { parts: [{ text: system }] };
  const data = await post('/gemini', { model, body });
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ?? '';
  return { text, latencyMs: data.latencyMs, usage: data.usageMetadata };
}

// HKU Gemini image models. Returns { mimeType, data(base64), latencyMs }.
// `image` ({ mimeType, data }) turns it into an edit of that photo (used for "see it on me").
export async function geminiImage(prompt, { model = 'gemini-2.5-flash-image', aspectRatio = '4:5', image } = {}) {
  const data = await post('/image', { model, prompt, aspectRatio, ...(image ? { image } : {}) });
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) {
    console.warn('[image] no inlineData in response', data);
    const why = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || data.message || data.error
      || JSON.stringify(data).slice(0, 160);
    throw new Error(`No image returned (${why})`);
  }
  return { ...part.inlineData, latencyMs: data.latencyMs };
}

export const openaiImage = (prompt, opts = {}) => post('/openai-image', { prompt, ...opts });
