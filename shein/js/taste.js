// Catalog loading and the taste model.
//
// A taste profile keeps one attribute-weight map per signal SOURCE, so we can always say what
// shaped a shopper's designs, plus a Beta posterior per attribute for exploration:
//   bySource: { purchases: { "block:tee": 4.2, ... }, socials: {...}, swipes: {...}, browsing: {...}, answers: {...}, cohort: {...} }
//   weights:  sum of all sources (what the 60/30/10 blend and clustering read)
//   post:     { "fabric:linen": [successes, failures] }  → Thompson sampling
//   shown:    { "colour:black": n }                       → novelty penalty (decayed impression count)
// Every new signal first decays everything a little, so old preferences fade instead of locking in.
import { BLEND } from './config.js';

export const GROUPS = ['block', 'fabric', 'colour', 'print', 'fit'];
const GROUP_TABLE = { block: 'blocks', fabric: 'fabrics', colour: 'colours', print: 'prints', fit: 'fits' };

// How much each kind of evidence moves the profile. Buying beats liking by a wide margin.
export const SIGNALS = { purchase: 5, order: 4, social: 1.5, like: 1, quiz: 0.6, cohort: 0.4, dwell: 0.3, nope: -0.7 };
export const SOURCE_OF = { purchase: 'purchases', order: 'purchases', social: 'socials', like: 'swipes', nope: 'swipes', dwell: 'browsing', quiz: 'answers', cohort: 'cohort' };
export const SOURCES = ['purchases', 'socials', 'swipes', 'browsing', 'answers', 'cohort'];
export const SOURCE_LABEL = { purchases: 'Purchases', socials: 'Socials', swipes: 'Swipes', browsing: 'Browsing', answers: 'Your answers', cohort: 'Style cohort' };
const DECAY = 0.985; // per new signal

let catalogP, cardsP, kolP, personasP;
const json = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });
export const loadCatalog = () => (catalogP ??= json('data/catalog.json'));
export const loadCards = () => (cardsP ??= json('data/cards.json'));
export const loadKol = () => (kolP ??= json('data/kol.json'));
export const loadPersonas = () => (personasP ??= json('data/personas.json'));

export const options = (catalog, group) => Object.keys(catalog[GROUP_TABLE[group]]);
export const optionLabel = (catalog, group, key) => catalog[GROUP_TABLE[group]][key]?.label ?? key;
export const attrKey = (group, value) => `${group}:${value}`;
export const specAttrs = (spec) => GROUPS.map((g) => attrKey(g, spec[g]));
// Same design from any user → same key, so likes/orders aggregate across users.
export const designKey = (spec) => GROUPS.map((g) => spec[g]).join('~');
export const specFromKey = (key) => Object.fromEntries(String(key).split('~').map((v, i) => [GROUPS[i], v]));

export function describeSpec(catalog, spec) {
  const L = (g) => optionLabel(catalog, g, spec[g]);
  const print = spec.print === 'solid' ? '' : `${L('print').toLowerCase()} `;
  const fit = spec.fit === 'regular' ? '' : `${L('fit')} `;
  const s = `${fit}${L('colour').toLowerCase()} ${print}${L('fabric').toLowerCase()} ${L('block').toLowerCase()}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- which garment types a shopper can be shown ----------
// Gender only filters the catalogue; occasions narrow it but never below 6 garment types.
export function allowedBlocks(catalog, user) {
  const all = Object.entries(catalog.blocks);
  const g = user?.gender;
  let ok = all.filter(([, b]) => !g || g === 'any' || b.gender.includes(g));
  const occ = user?.occasions || [];
  if (occ.length) {
    const narrowed = ok.filter(([, b]) => b.occasions.some((o) => occ.includes(o)));
    if (narrowed.length >= 6) ok = narrowed;
  }
  return ok.map(([k]) => k);
}

// ---------- profile updates ----------
export function emptyProfile() {
  return { weights: {}, bySource: {}, post: {}, shown: {}, events: 0 };
}

// Older profiles only had `weights`; treat those as swipe evidence.
export function normalise(profile) {
  const p = { ...emptyProfile(), ...(profile || {}) };
  if (!profile?.bySource && profile?.weights && Object.keys(profile.weights).length) p.bySource = { swipes: { ...profile.weights } };
  p.bySource = Object.fromEntries(SOURCES.map((s) => [s, { ...(p.bySource?.[s] || {}) }]));
  p.post = { ...(p.post || {}) };
  p.shown = { ...(p.shown || {}) };
  return p;
}

const r3 = (x) => Math.round(x * 1000) / 1000;
function decayAll(p) {
  for (const s of SOURCES) for (const k in p.bySource[s]) p.bySource[s][k] = r3(p.bySource[s][k] * DECAY);
  for (const k in p.post) p.post[k] = [r3(p.post[k][0] * DECAY), r3(p.post[k][1] * DECAY)];
  for (const k in p.shown) p.shown[k] = r3(p.shown[k] * 0.97);
}
function recombine(p) {
  const w = {};
  for (const s of SOURCES) for (const [k, v] of Object.entries(p.bySource[s])) w[k] = r3((w[k] || 0) + v);
  p.weights = w;
}

// One piece of evidence about one design. `strength` scales it (e.g. older purchases count less).
export function applySignal(profile, spec, signal, { strength = 1, decay = true, attrs } = {}) {
  const p = normalise(profile);
  if (decay) decayAll(p);
  const w = (SIGNALS[signal] ?? 0) * strength;
  const src = SOURCE_OF[signal] || 'swipes';
  for (const k of attrs || specAttrs(spec)) {
    p.bySource[src][k] = r3((p.bySource[src][k] || 0) + w);
    const [a, b] = p.post[k] || [0, 0];
    p.post[k] = w >= 0 ? [r3(a + w), b] : [a, r3(b - w)];
    if (!attrs && signal !== 'social' && signal !== 'quiz') p.shown[k] = r3((p.shown[k] || 0) + 1);
  }
  p.events = (p.events || 0) + 1;
  recombine(p);
  return p;
}

// Add a whole attribute map from one source at once (cold-start priors from answers or the cohort).
export function applyPrior(profile, attrWeights, source) {
  const p = normalise(profile);
  for (const [k, v] of Object.entries(attrWeights)) p.bySource[source][k] = r3((p.bySource[source][k] || 0) + v);
  recombine(p);
  return p;
}

// Share of the profile that comes from each source (by absolute weight).
export function sourceMix(profile) {
  const p = normalise(profile);
  const tot = Object.fromEntries(SOURCES.map((s) => [s, Object.values(p.bySource[s]).reduce((a, v) => a + Math.abs(v), 0)]));
  const sum = Object.values(tot).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(SOURCES.map((s) => [s, tot[s] / sum]));
}

const plural = (s) => (s.endsWith('ss') ? `${s}es` : s.endsWith('s') ? s : `${s}s`);
export function attrPhrase(catalog, attr) {
  const [g, o] = attr.split(':');
  const l = optionLabel(catalog, g, o).toLowerCase();
  return g === 'block' ? plural(l) : g === 'fit' ? `${l} cuts` : `${l} pieces`;
}

// Why a design is being shown, from the strongest matching attribute and the source behind it.
export function reasonFor(catalog, profile, spec) {
  const p = normalise(profile);
  // prefer distinctive attributes: "you bought bomber jackets" says more than "you liked solid pieces"
  const SALIENCE = { block: 1.3, colour: 1.15, fabric: 1.1, print: 0.8, fit: 0.5 };
  const BLAND = new Set(['print:solid', 'fit:regular']);
  let best = null;
  for (const k of specAttrs(spec)) {
    const sal = (SALIENCE[k.split(':')[0]] || 1) * (BLAND.has(k) ? 0.3 : 1);
    for (const s of SOURCES) {
      const v = (p.bySource[s][k] || 0) * sal;
      if (v > 0 && (!best || v > best.v)) best = { k, s, v };
    }
  }
  if (!best) return 'Picked to learn your taste';
  const what = attrPhrase(catalog, best.k);
  return {
    purchases: `Because you bought ${what}`, socials: `Matches your socials: ${what}`, swipes: `Because you liked ${what}`,
    browsing: `You lingered on ${what}`, answers: `Fits what you're shopping for`, cohort: `Popular in your style cohort`,
  }[best.s];
}

// ---------- distributions ----------
const softmax = (xs, temp = 1) => {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp((x - m) / temp));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
};

// Probability over a group's options from weights (temp > 1 = softer).
export function groupDist(catalog, weights, group, temp = 1.6) {
  const opts = options(catalog, group);
  const p = softmax(opts.map((o) => weights[attrKey(group, o)] || 0), temp);
  return Object.fromEntries(opts.map((o, i) => [o, p[i]]));
}

// Frequency distribution with add-one smoothing (for influencer looks).
export function countDist(catalog, specs, group) {
  const opts = options(catalog, group);
  const counts = Object.fromEntries(opts.map((o) => [o, 1]));
  specs.forEach((s) => { if (s[group] in counts) counts[s[group]] += 3; });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.fromEntries(opts.map((o) => [o, counts[o] / total]));
}

// Trend score from live counters; purchases count four times a like.
export const trendScore = (c = {}) => (c.likes || 0) + 4 * (c.orders || 0) + 0.2 * (c.dwells || 0) - 0.5 * (c.nopes || 0);
export function trendDist(catalog, liveAttr, group) {
  const opts = options(catalog, group);
  const p = softmax(opts.map((o) => Math.log1p(Math.max(0, trendScore(liveAttr?.[attrKey(group, o)])))), 1);
  return Object.fromEntries(opts.map((o, i) => [o, p[i]]));
}

// The 60/30/10 blend, per group. Returns { group: { option: { p, user, kol, trend } } }
export function blend(catalog, weights, kolLooks, liveAttr) {
  const out = {};
  for (const g of GROUPS) {
    const u = groupDist(catalog, weights, g);
    const k = countDist(catalog, kolLooks, g);
    const t = trendDist(catalog, liveAttr, g);
    out[g] = Object.fromEntries(options(catalog, g).map((o) => [o, {
      p: BLEND.user * u[o] + BLEND.kol * k[o] + BLEND.trend * t[o], user: u[o], kol: k[o], trend: t[o],
    }]));
  }
  return out;
}

export const topOf = (dist, n = 3) =>
  Object.entries(dist).sort((a, b) => (b[1].p ?? b[1]) - (a[1].p ?? a[1])).slice(0, n);

// ---------- Thompson sampling ----------
function gamma(k) { // Marsaglia–Tsang
  if (k < 1) return gamma(k + 1) * Math.random() ** (1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { const u1 = Math.random(), u2 = Math.random(); x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v ** 3;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
// Draw a plausible "like rate" for an attribute given its evidence; few observations → wide spread → exploration.
export function thompson(profile, attr) {
  const [a, b] = profile.post?.[attr] || [0, 0];
  const x = gamma(1 + a), y = gamma(1 + b);
  return x / (x + y);
}

// ---------- vectors ----------
export function vectorize(catalog, weights) {
  return GROUPS.flatMap((g) => options(catalog, g).map((o) => weights?.[attrKey(g, o)] || 0));
}
export const specVector = (catalog, spec) => vectorize(catalog, Object.fromEntries(specAttrs(spec).map((a) => [a, 1])));

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
