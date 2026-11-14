// Catalog loading, the attribute-based taste profile, and the 60/30/10 blend.
// A taste profile is a map of attribute weights: { "block:tee": 1.4, "colour:black": -0.7, ... }
import { BLEND } from './config.js';

export const GROUPS = ['block', 'fabric', 'colour', 'print', 'fit'];
const GROUP_TABLE = { block: 'blocks', fabric: 'fabrics', colour: 'colours', print: 'prints', fit: 'fits' };
const SIGNAL = { like: 1, nope: -0.7, super: 2 };
const LR = 1;

let catalogP, cardsP, kolP;
const json = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });
export const loadCatalog = () => (catalogP ??= json('data/catalog.json'));
export const loadCards = () => (cardsP ??= json('data/cards.json'));
export const loadKol = () => (kolP ??= json('data/kol.json'));

export const options = (catalog, group) => Object.keys(catalog[GROUP_TABLE[group]]);
export const optionLabel = (catalog, group, key) => catalog[GROUP_TABLE[group]][key]?.label ?? key;
export const attrKey = (group, value) => `${group}:${value}`;
export const specAttrs = (spec) => GROUPS.map((g) => attrKey(g, spec[g]));
// Same design from any user → same key, so likes/orders aggregate across users.
export const designKey = (spec) => GROUPS.map((g) => spec[g]).join('~');

export function describeSpec(catalog, spec) {
  const L = (g) => optionLabel(catalog, g, spec[g]);
  const print = spec.print === 'solid' ? '' : `${L('print').toLowerCase()} `;
  const fit = spec.fit === 'regular' ? '' : `${L('fit')} `;
  const s = `${fit}${L('colour').toLowerCase()} ${print}${L('fabric').toLowerCase()} ${L('block').toLowerCase()}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function updateWeights(weights, spec, dir) {
  const w = { ...weights };
  const d = (SIGNAL[dir] ?? 0) * LR;
  for (const k of specAttrs(spec)) w[k] = +((w[k] || 0) + d).toFixed(3);
  return w;
}

const softmax = (xs, temp = 1) => {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp((x - m) / temp));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
};

// Probability over a group's options from weights (temp > 1 = softer).
export function groupDist(catalog, weights, group, temp = 1.2) {
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

// Trend distribution from live counters: live/attr/{group:opt} = { likes, nopes, orders }
export function trendDist(catalog, liveAttr, group) {
  const opts = options(catalog, group);
  const score = opts.map((o) => {
    const c = liveAttr?.[attrKey(group, o)] || {};
    return Math.log1p(Math.max(0, (c.likes || 0) + 2 * (c.orders || 0) - 0.5 * (c.nopes || 0)));
  });
  const p = softmax(score, 1);
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

// Fixed-order numeric vector for clustering / similarity.
export function vectorize(catalog, weights) {
  return GROUPS.flatMap((g) => options(catalog, g).map((o) => weights?.[attrKey(g, o)] || 0));
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
