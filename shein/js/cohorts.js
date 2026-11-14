// Style cohorts: k-means over taste vectors + a 2D PCA projection for the scatter plot.
import { GROUPS, options, attrKey, optionLabel, vectorize } from './taste.js';

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

export function clusterProfiles(catalog, profiles, k) {
  const pts = profiles.map((p) => vectorize(catalog, p.weights));
  const { assign, centroids } = kmeans(pts, k);
  const xy = pca2(pts);
  return { assign, centroids, xy };
}

export { attrKey };
