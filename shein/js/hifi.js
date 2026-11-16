// "See it for real": turn any lo-fi design (spec) into a photoreal image on demand.
//   model  → a studio shot on a model (rotating body types, face cropped). Shared: cached per design, so the
//            next shopper who asks gets it instantly; held for human review before it enters the public gallery.
//   me     → the shopper's own onboarding photo, edited to wear the design. Private: the photo and the result
//            stay in this browser and never go to the database or the review queue.
// HKU quotas are tiny (gemini-2.5-flash-image: 2/min, 70/week, shared with the HKU GenAI app), so cache hits are
// free, each shopper gets DAILY_CAP generations a day, and the Worker passcode gates every call.
import { DB, pushId, rtKey } from './db.js';
import { jev, geminiImage, openaiImage } from './api.js';
import { checkSpec } from './guardrails.js';
import { describeSpec, designKey, optionLabel, specVector, vectorize, cosine } from './taste.js';

export const MODELS = {
  'gemini-2.5-flash-image': { label: 'Nano Banana', vendor: 'Google', weeklyLimit: 70, enabled: true },
  'gemini-3.1-flash-image': { label: 'Nano Banana 2', vendor: 'Google', weeklyLimit: 35, enabled: true },
  'gpt-image-1.5': { label: 'GPT Image 1.5', vendor: 'OpenAI', weeklyLimit: null, enabled: false, note: 'waiting on HKU portal docs' },
};
export const DEFAULT_MODEL = 'gemini-2.5-flash-image';
export const DAILY_CAP = 3;

// Body diversity for on-model shots (Stream 4, task D6). Faces are always cropped out.
const BODIES = ['petite', 'plus-size', 'tall', 'athletic', 'curvy', 'slim', 'mid-size', 'broad-shouldered'];
const SKIN = ['deep', 'medium-brown', 'olive', 'light', 'tan', 'dark'];

const garmentText = (catalog, spec) => {
  const L = (g) => optionLabel(catalog, g, spec[g]).toLowerCase();
  return `${L('fit')} ${L('colour')} ${spec.print === 'solid' ? '' : `${L('print')} print `}${L('fabric')} ${catalog.blocks[spec.block].desc.toLowerCase()}`;
};

export function modelPrompt(catalog, spec, gender) {
  const body = BODIES[Math.floor(Math.random() * BODIES.length)];
  const skin = SKIN[Math.floor(Math.random() * SKIN.length)];
  const who = gender === 'men' ? 'male model' : gender === 'women' ? 'female model' : 'model';
  return {
    bodyType: `${body}, ${skin} skin`,
    prompt: `E-commerce studio product photograph of a ${garmentText(catalog, spec)}, worn by a ${body} ${who} with ${skin} skin, `
      + 'cropped at the chin so no face is visible, standing naturally. Soft even studio lighting, seamless warm light-grey background, '
      + `true-to-life ${optionLabel(catalog, 'fabric', spec.fabric).toLowerCase()} texture, realistic seams and construction that could be sewn from a standard pattern block. `
      + 'The garment is unbranded: no logos, brand marks, monograms or lettering on it.',
  };
}

const mePrompt = (catalog, spec) => `Edit the attached photo: show the same person wearing a ${garmentText(catalog, spec)}. `
  + 'Keep their face, hair, skin tone, body shape, pose and the background exactly as they are; change only the clothing, '
  + 'fitted naturally to their body with realistic folds and lighting. The garment is unbranded: no logos, monograms or lettering.';

// Draw a base64 image onto canvases: WebP for storage, 512×512 JPEG (padded) for Jev.
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
  return { ipRisk: Math.max(a.ip?.noul ?? 0, a.text?.noul ?? 0), logoRisk: a.ip?.noul ?? null, textRisk: a.text?.noul ?? null, specMatch };
}

// ---------- on-device photo + private results ----------
export const getPhoto = (u) => { try { return localStorage.getItem(`sd_photo_${u}`); } catch { return null; } };
export function setPhoto(u, dataUrl) {
  try { dataUrl ? localStorage.setItem(`sd_photo_${u}`, dataUrl) : localStorage.removeItem(`sd_photo_${u}`); return true; }
  catch { return false; }
}
export function myLooks(u) { try { return JSON.parse(localStorage.getItem(`sd_mine_${u}`)) || []; } catch { return []; } }
function saveMyLook(u, look) {
  const list = [look, ...myLooks(u)].slice(0, 6); // localStorage is ~5 MB; keep the latest few
  for (let n = list.length; n > 0; n--) { try { localStorage.setItem(`sd_mine_${u}`, JSON.stringify(list.slice(0, n))); return; } catch {} }
}

// Downscale an uploaded file to a JPEG data URL.
export const downscaleFile = (file, max = 768, q = 0.85) => new Promise((res, rej) => {
  const img = new Image();
  img.onload = () => {
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    res(c.toDataURL('image/jpeg', q));
  };
  img.onerror = rej;
  img.src = URL.createObjectURL(file);
});

// ---------- quota ----------
const today = () => new Date().toISOString().slice(0, 10);
export async function quotaLeft(u) { return DAILY_CAP - ((await DB.rt.get(`quota/${u}/${today()}`)) || 0); }
async function takeQuota(u) {
  const r = await DB.rt.txn(`quota/${u}/${today()}`, (n) => ((n || 0) < DAILY_CAP ? (n || 0) + 1 : undefined));
  if (!r.committed) throw new Error(`You've used today's ${DAILY_CAP} hi-fi renders. Try again tomorrow.`);
}
const refundQuota = (u) => DB.rt.txn(`quota/${u}/${today()}`, (n) => Math.max(0, (n || 1) - 1));

// Existing shared on-model image for this design, if any (not rejected or blocked).
export async function cachedModelShot(spec) {
  const key = designKey(spec);
  const docs = await DB.fs.list('designs', { where: [['track', '==', 'hifi']] });
  return docs.filter((d) => d.specKey === key && d.onModel && d.status !== 'rejected' && d.status !== 'blocked')
    .sort((a, b) => (b.status === 'approved') - (a.status === 'approved') || b.createdAt - a.createdAt)[0] || null;
}

// The whole "see it for real" pipeline. Returns { src, cached, doc?, private }.
export async function renderForReal(catalog, { u, user, spec, mode, model = DEFAULT_MODEL, inventory, onStep = () => {} }) {
  if (mode === 'model') {
    onStep('Checking for an existing render…');
    const hit = await cachedModelShot(spec);
    if (hit) return { src: await imageFor(hit.imageId), cached: true, doc: hit };
  }
  const photo = mode === 'me' ? getPhoto(u) : null;
  if (mode === 'me' && !photo) throw new Error('Add a photo of yourself in your profile first.');
  await takeQuota(u);

  const { prompt, bodyType } = mode === 'me' ? { prompt: mePrompt(catalog, spec), bodyType: null } : modelPrompt(catalog, spec, user?.gender);
  onStep(`${MODELS[model].label} is rendering${mode === 'me' ? ' it on you' : ''}…`);
  const t0 = Date.now();
  const image = photo ? { mimeType: 'image/jpeg', data: photo.split(',')[1] } : undefined;
  let img;
  try { img = model === 'gpt-image-1.5' ? await openaiImage(prompt) : await geminiImage(prompt, { model, image }); }
  catch (e) { await refundQuota(u); throw e; } // a failed render doesn't count against the shopper's cap
  const latencyMs = Date.now() - t0;
  const { stored, jevJpeg } = await prepareImages(img.mimeType, img.data);
  DB.rt.incMany({ [`live/models/${model}/generated`]: 1, [`live/models/${model}/latencyMs`]: latencyMs, [`live/hifi/${mode}`]: 1 });

  if (mode === 'me') {
    // private: never stored in the database and never sent to a second service
    saveMyLook(u, { src: stored, spec, at: Date.now(), model });
    return { src: stored, cached: false, private: true, latencyMs };
  }

  onStep('Jev is screening the image for IP and accuracy…');
  const screen = await screenImage(catalog, spec, jevJpeg);
  const guard = checkSpec(catalog, spec, { inventory, ipRisk: screen.ipRisk });
  const imageId = pushId();
  const id = rtKey(`${designKey(spec)}@${model}@${imageId}`); // RTDB keys can't contain '.'
  await DB.fs.set('designImages', imageId, { data: stored, designId: id, createdAt: Date.now() }, false);
  const doc = {
    spec, specKey: designKey(spec), name: describeSpec(catalog, spec), track: 'hifi', model, prompt, bodyType, onModel: true, imageId,
    createdBy: u, createdAt: Date.now(), latencyMs,
    status: guard.pass ? 'pending' : 'blocked', failed: guard.failed, // pending = waiting for human review (HITL)
    jev: screen, cost: guard.cost,
  };
  await DB.fs.set('designs', id, doc, false);
  if (!guard.pass) DB.rt.incMany({ [`live/models/${model}/blocked`]: 1 });
  return { src: stored, cached: false, doc: { id, ...doc }, latencyMs, blocked: !guard.pass };
}

// Approved shared looks, best taste match first.
export async function approvedLooks(catalog, weights) {
  const docs = await DB.fs.list('designs', { where: [['track', '==', 'hifi']] });
  const me = vectorize(catalog, weights || {});
  return docs.filter((d) => d.status === 'approved' || d.status === 'escalated')
    .map((d) => ({ ...d, match: cosine(me, specVector(catalog, d.spec)) }))
    .sort((a, b) => b.match - a.match);
}

const imgCache = new Map();
export async function imageFor(imageId) {
  if (!imgCache.has(imageId)) imgCache.set(imageId, DB.fs.get('designImages', imageId).then((d) => d?.data || ''));
  return imgCache.get(imageId);
}

// Images generated this week per model (the weekly quota is shared across the whole team's key).
export async function weeklyUsage() {
  const since = Date.now() - 7 * 864e5;
  const docs = await DB.fs.list('designs', { where: [['track', '==', 'hifi']] });
  const out = {};
  docs.filter((d) => d.createdAt >= since).forEach((d) => (out[d.model] = (out[d.model] || 0) + 1));
  return out;
}
