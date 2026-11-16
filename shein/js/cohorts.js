// Style cohorts: k-means over taste vectors (unit-normalised, so a heavy buyer and a light swiper
// with the same taste land together), a 2D PCA projection for the scatter plot, and the
// persistent cohort snapshot that every shopper is assigned to.
import { DB, rtKey } from './db.js';
import { GROUPS, options, attrKey, optionLabel, vectorize, cosine } from './taste.js';

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }
const dist2 = (a, b) => a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0);
const norm = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };

export function kmeans(points, k, { iters = 60, seed = 7 } = {}) {
  const r = rng(seed);
  k = Math.min(k, points.length);
  // k-means++ initialisation
  const cent = [points[Math.floor(r() * points.length)]];
  while (cent.length < k) {
    const d = points.map((p) => Math.min(...cent.map((c) => dist2(p, c))));
    let t = r() * d.reduce((a, b) => a + b, 0);
    cent.push(points[d.findIndex((x) => (t -= x) <= 0)] ?? points[0]);
  }
  let assign = new Array(points.length).fill(0);
  for (let it = 0; it < iters; it++) {
    const next = points.map((p) => cent.reduce((best, c, i) => (dist2(p, c) < dist2(p, cent[best]) ? i : best), 0));
    const changed = next.some((a, i) => a !== assign[i]);
    assign = next;
    for (let c = 0; c < k; c++) {
      const mem = points.filter((_, i) => assign[i] === c);
      if (mem.length) cent[c] = mem[0].map((_, j) => mem.reduce((s, p) => s + p[j], 0) / mem.length);
    }
    if (!changed && it) break;
  }
  return { assign, centroids: cent };
}

// Top-2 principal components by power iteration.
export function pca2(points) {
  const d = points[0].length, n = points.length;
  const mean = Array.from({ length: d }, (_, j) => points.reduce((s, p) => s + p[j], 0) / n);
  const X = points.map((p) => p.map((x, j) => x - mean[j]));
  const cov = Array.from({ length: d }, (_, a) => Array.from({ length: d }, (_, b) => X.reduce((s, p) => s + p[a] * p[b], 0) / n));
  const mul = (v) => cov.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
  const comps = [];
  for (let c = 0; c < 2; c++) {
    let v = norm(Array.from({ length: d }, (_, j) => Math.sin(j + 1 + c)));
    for (let it = 0; it < 80; it++) {
      let w = mul(v);
      comps.forEach((u) => { const dot = w.reduce((s, x, j) => s + x * u[j], 0); w = w.map((x, j) => x - dot * u[j]); });
      v = norm(w);
    }
    comps.push(v);
  }
  return X.map((p) => comps.map((u) => p.reduce((s, x, j) => s + x * u[j], 0)));
}

// Attribute keys in vectorize() order.
export const vectorKeys = (catalog) => GROUPS.flatMap((g) => options(catalog, g).map((o) => [g, o]));

export function describeCentroid(catalog, centroid, n = 4) {
  const keys = vectorKeys(catalog);
  const top = centroid.map((v, i) => [v, keys[i]]).sort((a, b) => b[0] - a[0]);
  const perGroup = {};
  for (const [v, [g, o]] of top) if (!perGroup[g] && v > 0) perGroup[g] = optionLabel(catalog, g, o);
  return { top: top.slice(0, n).map(([v, [g, o]]) => optionLabel(catalog, g, o)), perGroup };
}

export const unitVec = (v) => { const n = Math.hypot(...v); return n ? v.map((x) => x / n) : v; };

export function clusterProfiles(catalog, profiles, k) {
  const pts = profiles.map((p) => unitVec(vectorize(catalog, p.weights)));
  const { assign, centroids } = kmeans(pts, k);
  const xy = pca2(pts);
  return { assign, centroids, xy };
}

// ---------- persistent cohorts (shein/cohorts/current) ----------
const K_DEFAULT = 4, STALE_MS = 5 * 60e3, MIN_PROFILES = 6;
const autoLabel = (d) => [d.perGroup.block, d.perGroup.colour].filter(Boolean).join(' · ') || 'Mixed';

export const getCohorts = () => DB.rt.get('cohorts/current');

// Recompute when missing, stale or the population has grown. Cohort ids (and their shared pools and
// names) survive a recompute by matching each new centroid to the closest previous one.
export async function ensureCohorts(catalog, { force = false, k } = {}) {
  const cur = await DB.rt.get('cohorts/current');
  const users = (await DB.rt.get('users')) || {};
  const profiles = (await DB.fs.list('profiles'))
    .filter((p) => (p.events || p.swipeCount || 0) >= 5 && p.weights && Object.keys(p.weights).length && users[p.id]?.consent?.cohort !== false);
  const fresh = cur && Date.now() - cur.updatedAt < STALE_MS && profiles.length < (cur.n || 0) * 1.2 + 2;
  if (!force && fresh) return cur;
  if (profiles.length < MIN_PROFILES) return cur || null;
  k = k || cur?.k || K_DEFAULT;
  const { assign, centroids } = clusterProfiles(catalog, profiles, k);
  const used = new Set();
  const cohorts = centroids.map((c, i) => {
    let best = null;
    (cur?.cohorts || []).forEach((pc) => {
      if (used.has(pc.id)) return;
      const sim = cosine(c, pc.centroid);
      if (!best || sim > best.sim) best = { pc, sim };
    });
    const keep = best && best.sim > 0.6 ? best.pc : null;
    if (keep) used.add(keep.id);
    const d = describeCentroid(catalog, c);
    return { id: keep?.id || `co${Date.now().toString(36)}${i}`, label: keep?.named ? keep.label : autoLabel(d), named: !!keep?.named,
      centroid: c.map((x) => +x.toFixed(4)), size: assign.filter((a) => a === i).length, signature: d.perGroup };
  });
  const next = { k, n: profiles.length, updatedAt: Date.now(), cohorts };
  await DB.rt.set('cohorts/current', next);
  await Promise.all(profiles.map((p, j) => DB.fs.set('profiles', p.id, { cohortId: cohorts[assign[j]].id, cohortLabel: cohorts[assign[j]].label })));
  return next;
}

export function nearestCohort(catalog, snapshot, weights) {
  const v = unitVec(vectorize(catalog, weights || {}));
  let best = null;
  for (const c of snapshot?.cohorts || []) { const sim = cosine(v, c.centroid); if (!best || sim > best.sim) best = { ...c, sim }; }
  return best;
}

// Put a shopper in their nearest cohort (recomputing cohorts first if they're stale).
export async function assignCohort(catalog, u, profile) {
  const snap = await ensureCohorts(catalog);
  const c = snap && nearestCohort(catalog, snap, profile.weights);
  if (!c) return profile;
  profile.cohortId = c.id; profile.cohortLabel = c.label;
  DB.fs.set('profiles', u, { cohortId: c.id, cohortLabel: c.label });
  return profile;
}

// Cold start for net-new customers: borrow a softened copy of the nearest cohort's taste.
export function cohortPrior(catalog, cohort, scale = 1.2) {
  const keys = vectorKeys(catalog);
  return Object.fromEntries(cohort.centroid.map((v, i) => [attrKey(...keys[i]), +(v * scale).toFixed(3)]).filter(([, v]) => v > 0.05));
}

// ---------- cohort pool: a purchase is shared with everyone of similar taste straight away ----------
export async function publishToPool(cohortId, u, it) {
  if (!cohortId) return;
  await DB.rt.txn(`cohortPool/${cohortId}/${rtKey(it.key)}`, (cur) => ({
    spec: it.spec, key: it.key, ipRisk: it.ipRisk ?? cur?.ipRisk ?? null,
    buyers: { ...(cur?.buyers || {}), [u]: true }, count: (cur?.count || 0) + 1,
    firstAt: cur?.firstAt || Date.now(), lastAt: Date.now(),
  }));
  DB.rt.incMany({ 'live/pool/published': 1 });
}

export async function poolFor(cohortId) {
  if (!cohortId) return [];
  return Object.values((await DB.rt.get(`cohortPool/${cohortId}`)) || {}).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

export { attrKey };
