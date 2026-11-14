// Hi-fi prototype: the same Jev + guardrail spec, rendered as a photoreal product image by an
// image model on the HKU portal, screened by Jev on the actual pixels, and held for human review.
//
// Image quotas on the HKU portal are tiny (gemini-2.5-flash-image: 2/min, 70/week, shared with the
// HKU GenAI app), so generated images go into a shared library in the database and every shopper swipes
// the library ranked by taste. Generating a new one is an explicit, rate-limited action.
import { DB, pushId, rtKey } from './db.js';
import { jev, geminiImage, openaiImage } from './api.js';
import { checkSpec } from './guardrails.js';
import { designQuestions, shopperState, sample, cap } from './lofi.js';
import { loadKol, blend, GROUPS, describeSpec, designKey, optionLabel, specAttrs, vectorize, cosine } from './taste.js';

export const MODELS = {
  'gemini-2.5-flash-image': { label: 'Nano Banana', vendor: 'Google', weeklyLimit: 70, enabled: true },
  'gemini-3.1-flash-image': { label: 'Nano Banana 2', vendor: 'Google', weeklyLimit: 35, enabled: true },
  'gpt-image-1.5': { label: 'GPT Image 1.5', vendor: 'OpenAI', weeklyLimit: null, enabled: false, note: 'waiting on HKU portal docs' },
};
export const COOLDOWN_MS = 31_000; // 2 requests / minute per model

// Body diversity for on-model shots (Stream 4, task D6). Faces are always cropped out.
const BODIES = ['petite', 'plus-size', 'tall', 'athletic', 'curvy', 'slim', 'mid-size', 'broad-shouldered'];
const SKIN = ['deep', 'medium-brown', 'olive', 'light', 'tan', 'dark'];

export function buildPrompt(catalog, spec, { onModel }) {
  const L = (g) => optionLabel(catalog, g, spec[g]).toLowerCase();
  const garment = `${L('fit')} ${L('colour')} ${spec.print === 'solid' ? '' : `${L('print')} print `}${L('fabric')} ${catalog.blocks[spec.block].desc.toLowerCase()}`;
  const body = BODIES[Math.floor(Math.random() * BODIES.length)];
  const skin = SKIN[Math.floor(Math.random() * SKIN.length)];
  const scene = onModel
    ? `worn by a ${body} model with ${skin} skin, cropped at the chin so no face is visible, standing naturally`
    : 'shown on an invisible ghost mannequin, centred, full garment visible';
  return {
    bodyType: onModel ? `${body}, ${skin} skin` : null,
    prompt: `E-commerce studio product photograph of a ${garment}, ${scene}. `
      + `Soft even studio lighting, seamless warm light-grey background, true-to-life fabric texture showing the ${L('fabric')}, `
      + 'realistic seams and construction that could be sewn from a standard pattern block. '
      + 'The garment is unbranded: no logos, brand marks, monograms or lettering on it.',
  };
}

// One Jev call → sample one spec that passes guardrails 1–3.
export async function proposeSpec(catalog, { weights, recent, live, inventory, avoid = new Set() }) {
  const kol = await loadKol();
  const bl = blend(catalog, weights, kol.looks, live);
  const res = await jev(shopperState(catalog, bl, recent), designQuestions(catalog));
  const probs = Object.fromEntries(GROUPS.map((g) => [g, res.answers?.[g]?.probabilities || {}]));
  for (let tries = 0; tries < 30; tries++) {
    const spec = { block: sample(probs.block) };
    const B = catalog.blocks[spec.block];
    const allowed = Object.fromEntries(B.fabrics.filter((f) => (inventory?.[f] ?? catalog.inventoryMeters[f]) >= B.meters).map((f) => [f, probs.fabric[f] || 0.001]));
    if (!Object.keys(allowed).length) continue;
    spec.fabric = sample(allowed);
    for (const g of ['colour', 'print', 'fit']) spec[g] = sample(probs[g]);
    const guard = checkSpec(catalog, spec, { inventory });
    if (guard.pass && !avoid.has(designKey(spec))) {
      return { spec, guard, conf: Object.fromEntries(GROUPS.map((g) => [g, probs[g][spec[g]] ?? 0])), jevLatencyMs: res.latencyMs };
    }
  }
  throw new Error('No design passed the guardrails. Try again.');
}

// Draw a base64 image onto a canvas: WebP for storage, 512×512 JPEG (padded) for Jev.
async function prepareImages(mimeType, b64) {
  const img = new Image();
  img.src = `data:${mimeType};base64,${b64}`;
  await img.decode();
  const store = document.createElement('canvas');
  const s = Math.min(1, 768 / Math.max(img.width, img.height));
  store.width = Math.round(img.width * s); store.height = Math.round(img.height * s);
  store.getContext('2d').drawImage(img, 0, 0, store.width, store.height);
  const sq = document.createElement('canvas');
  sq.width = sq.height = 512;
  const c = sq.getContext('2d');
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, 512, 512);
  const k = 512 / Math.max(img.width, img.height);
  c.drawImage(img, (512 - img.width * k) / 2, (512 - img.height * k) / 2, img.width * k, img.height * k);
  return { stored: store.toDataURL('image/webp', 0.82), jevJpeg: sq.toDataURL('image/jpeg', 0.85).split(',')[1] };
}

// Guardrail 4 on the real pixels, plus a fidelity check: did the model draw the spec?
async function screenImage(catalog, spec, jpegB64) {
  const L = (g) => optionLabel(catalog, g, spec[g]).toLowerCase();
  const r = await jev({ photo: 'design' }, {
    ip: { type: 'noul', instructions: 'Does the photo show a recognisable brand logo, trademarked monogram or check, or a copy of a famous designer piece?',
      criteria: { true: 'A protected brand mark or iconic design is visible.', false: 'A generic unbranded garment.' } },
    text: { type: 'noul', instructions: 'Does the garment carry visible text, lettering or a watermark?', criteria: { true: 'Text or lettering is visible.', false: 'No text.' } },
    block: { type: 'noul', instructions: `Is the main garment a ${catalog.blocks[spec.block].label.toLowerCase()}?`, criteria: { true: 'Yes', false: 'No, a different garment type' } },
    colour: { type: 'noul', instructions: `Is the main garment mostly ${L('colour')}?`, criteria: { true: 'Yes', false: 'No' } },
    print: { type: 'noul', instructions: spec.print === 'solid' ? 'Is the garment a solid colour without a print?' : `Does the garment have a ${L('print')} print?`, criteria: { true: 'Yes', false: 'No' } },
  }, { design: { type: 'image', format: 'jpeg', data_base64: jpegB64 } });
  const a = r.answers || {};
  const specMatch = ['block', 'colour', 'print'].reduce((s, k) => s + (a[k]?.noul ?? 0), 0) / 3;
  return { ipRisk: Math.max(a.ip?.noul ?? 0, a.text?.noul ?? 0), logoRisk: a.ip?.noul ?? null, textRisk: a.text?.noul ?? null, specMatch, latencyMs: r.latencyMs };
}

// Full pipeline. Returns the saved design document (with id).
export async function generateHifi(catalog, { u, model, onModel, weights, recent, live, inventory, avoid, onStep = () => {} }) {
  onStep('Jev is choosing the design…');
  const { spec, conf } = await proposeSpec(catalog, { weights, recent, live, inventory, avoid });
  const { prompt, bodyType } = buildPrompt(catalog, spec, { onModel });
  onStep(`${MODELS[model].label} is rendering…`);
  const t0 = Date.now();
  const img = model === 'gpt-image-1.5' ? await openaiImage(prompt) : await geminiImage(prompt, { model });
  const latencyMs = Date.now() - t0;
  onStep('Jev is screening the image for IP and accuracy…');
  const { stored, jevJpeg } = await prepareImages(img.mimeType, img.data);
  const screen = await screenImage(catalog, spec, jevJpeg);
  const guard = checkSpec(catalog, spec, { inventory, ipRisk: screen.ipRisk });

  const imageId = pushId();
  const id = rtKey(`${designKey(spec)}@${model}@${imageId}`); // RTDB keys can't contain '.'
  await DB.fs.set('designImages', imageId, { data: stored, designId: id, createdAt: Date.now() }, false);
  const doc = {
    spec, name: cap(describeSpec(catalog, spec)), track: 'hifi', model, prompt, bodyType, onModel, imageId,
    createdBy: u, createdAt: Date.now(), latencyMs,
    status: guard.pass ? 'pending' : 'blocked', failed: guard.failed, // pending = waiting for human review (HITL)
    jev: { conf, ...screen }, cost: guard.cost,
  };
  await DB.fs.set('designs', id, doc, false);
  DB.rt.incMany({ [`live/models/${model}/generated`]: 1, [`live/models/${model}/latencyMs`]: latencyMs, ...(guard.pass ? {} : { [`live/models/${model}/blocked`]: 1 }) });
  return { id, ...doc, guard };
}

// The shared library, best taste match first. Own pending designs are visible to their creator.
export async function libraryFor(catalog, u, weights, seen) {
  const docs = await DB.fs.list('designs', { where: [['track', '==', 'hifi']] });
  const me = vectorize(catalog, weights || {});
  return docs
    .filter((d) => !seen.has(d.id) && (d.status === 'approved' || d.status === 'escalated' || (d.status === 'pending' && d.createdBy === u)))
    .map((d) => ({ ...d, match: cosine(me, vectorize(catalog, Object.fromEntries(specAttrs(d.spec).map((a) => [a, 1])))) }))
    .sort((a, b) => b.match - a.match);
}

const imgCache = new Map();
export async function imageFor(imageId) {
  if (!imgCache.has(imageId)) imgCache.set(imageId, DB.fs.get('designImages', imageId).then((d) => d?.data || ''));
  return imgCache.get(imageId);
}

// Images generated this week per model (weekly quota is shared across the whole team's key).
export async function weeklyUsage() {
  const since = Date.now() - 7 * 864e5;
  const docs = await DB.fs.list('designs', { where: [['track', '==', 'hifi']] });
  const out = {};
  docs.filter((d) => d.createdAt >= since).forEach((d) => (out[d.model] = (out[d.model] || 0) + 1));
  return out;
}
