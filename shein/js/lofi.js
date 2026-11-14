// Lo-fi prototype: an endless swipe deck of designs co-created by Jev and rendered in three.js.
//
// For each batch:
//   1. Blend the shopper's taste 60/30/10 (own swipes / creator looks / live trends)
//   2. Jev call #1: one `choice` question per attribute → a probability for every catalog option
//   3. Sample several candidate specs from those probabilities (with some exploration).
//      Fabric is limited to what the pattern block supports and what is in stock (guardrails 1–2)
//   4. Cost & speed guardrail (SUCP ≤ 18%, ≤ 7 days) blocks the rest (guardrail 3)
//   5. Jev call #2: per design, `noul` IP-risk check (guardrail 4) and a `score` for predicted appeal
// Swipes update the profile; ↑ places a single-unit order; popular designs escalate to LATR micro-batches
// and get replicated into the decks of shoppers with similar taste.
import { Deck } from './swipe.js';
import { DB } from './db.js';
import { jev } from './api.js';
import { checkSpec, guardrailSummary } from './guardrails.js';
import { loadKol, blend, GROUPS, options, optionLabel, describeSpec, designKey, specAttrs, vectorize, cosine, topOf } from './taste.js';
import { recordSwipe } from './store.js';
import { placeOrder, maybeEscalate } from './orders.js';
import { garmentCard, inspect, toast, escapeHtml } from './ui.js';

const BATCH = 4, CANDIDATES = 8, EXPLORE = 0.2, TEMP = 1.8, TREND_SHARE = 0.3;
export { TEMP };
export const APPEAL = ['Unlikely to like it', 'Might like it', 'Likely to like it', 'Will love it'];

export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pct = (x) => `${Math.round(x * 100)}%`;

export function sample(probs, temp = TEMP) {
  const e = Object.entries(probs).filter(([, p]) => p > 0);
  if (!e.length) return null;
  const w = e.map(([, p]) => p ** (1 / temp));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < e.length; i++) { r -= w[i]; if (r <= 0) return e[i][0]; }
  return e.at(-1)[0];
}

export function designQuestions(catalog) {
  const choice = (group, instructions, describe) => ({
    type: 'choice', instructions,
    criteria: Object.fromEntries(options(catalog, group).map((o) => [o, describe(o)])),
  });
  return {
    block: choice('block', 'Which garment type should we design next for this shopper?', (o) => catalog.blocks[o].desc),
    fabric: choice('fabric', 'Which fabric would this shopper most want to wear?', (o) => catalog.fabrics[o].label),
    colour: choice('colour', 'Which colour should the next design be?', (o) => catalog.colours[o].label),
    print: choice('print', 'Which print or pattern should the next design use?', (o) => catalog.prints[o].label),
    fit: choice('fit', 'Which fit should the next design have?', (o) => catalog.fits[o].label),
  };
}

export function shopperState(catalog, bl, recent) {
  return {
    task: 'Co-design the next garment to show this shopper in a swipe feed.',
    blended_preferences: Object.fromEntries(GROUPS.map((g) => [g,
      topOf(bl[g], 4).map(([o, v]) => `${optionLabel(catalog, g, o)} ${pct(v.p)}`).join(', ')])),
    recently_liked: recent.likes.slice(-6),
    recently_disliked: recent.nopes.slice(-4),
    note: "Preferences blend 60% the shopper's own swipes, 30% creator looks and 10% live trends.",
  };
}

export async function startDesignDeck({ el, catalog, user: u, getProfile, setProfile, setPhase }) {
  let c_latency = 0;
  const kol = await loadKol();
  let live = {}, inventory = null, escalations = {};
  DB.rt.on('live/attr', (v) => (live = v || {}));
  DB.rt.on('escalations', (v) => (escalations = v || {}));
  if (!(await DB.rt.get('inventory'))) await DB.rt.set('inventory', catalog.inventoryMeters);
  DB.rt.on('inventory', (v) => (inventory = v || catalog.inventoryMeters));

  const history = Object.values((await DB.rt.get(`swipes/${u}`)) || {}).sort((a, b) => a.ts - b.ts);
  const seen = new Set(history.map((s) => s.designKey));
  const recent = {
    likes: history.filter((s) => s.dir !== 'nope').map((s) => describeSpec(catalog, s.spec)),
    nopes: history.filter((s) => s.dir === 'nope').map((s) => describeSpec(catalog, s.spec)),
  };
  let reviewed = history.filter((s) => s.track === 'lofi').length;
  const label = () => setPhase(`Your co-created feed · ${reviewed} designs reviewed`, 100);
  label();

  // ---------- generation ----------
  async function generate() {
    const bl = blend(catalog, getProfile().weights || {}, kol.looks, live);
    const res = await jev(shopperState(catalog, bl, recent), designQuestions(catalog));
    const probs = Object.fromEntries(GROUPS.map((g) => [g, res.answers?.[g]?.probabilities || {}]));
    if (GROUPS.some((g) => !Object.keys(probs[g]).length)) throw new Error('Jev returned no probabilities');

    const candidates = [];
    const blocked = [];
    for (let i = 0, tries = 0; candidates.length < CANDIDATES && tries < CANDIDATES * 4; tries++) {
      const explored = Math.random() < EXPLORE ? GROUPS[Math.floor(Math.random() * GROUPS.length)] : null;
      const pick = (g, p) => (g === explored ? sample(Object.fromEntries(Object.keys(p).map((k) => [k, 1]))) : sample(p));
      const spec = { block: pick('block', probs.block) };
      // guardrails 1 & 2 by construction: only fabrics this block supports and that are in stock
      const B = catalog.blocks[spec.block];
      const allowed = Object.fromEntries(B.fabrics
        .filter((f) => (inventory?.[f] ?? 0) >= B.meters)
        .map((f) => [f, probs.fabric[f] || 0.001]));
      if (!Object.keys(allowed).length) continue;
      spec.fabric = pick('fabric', allowed);
      for (const g of ['colour', 'print', 'fit']) spec[g] = pick(g, probs[g]);
      const key = designKey(spec);
      if (seen.has(key) || candidates.some((c) => c.key === key) || blocked.some((c) => c.key === key)) continue;
      const jevTop = Object.entries(probs.fabric).sort((a, b) => b[1] - a[1])[0][0];
      const cand = {
        key, spec, explored,
        conf: Object.fromEntries(GROUPS.map((g) => [g, probs[g][spec[g]] ?? 0])),
        fabricRemapped: jevTop !== spec.fabric && !B.fabrics.includes(jevTop),
        guard: checkSpec(catalog, spec, { inventory }),
      };
      (cand.guard.pass ? candidates : blocked).push(cand);
      i++;
    }

    // guardrail 4 + predicted appeal, in one Jev pass over all surviving candidates
    const pool = candidates.slice(0, BATCH + 1);
    if (pool.length) {
      const q = {};
      pool.forEach((c, i) => {
        q[`ip_${i}`] = { type: 'noul',
          instructions: `Does design d${i} closely imitate a protected brand signature: a trademarked monogram or check, a logo, or a famous designer's iconic piece?`,
          criteria: { true: 'It reproduces a recognisable protected brand pattern, logo or iconic design.', false: 'It is a generic garment built from common shapes, colours and prints.' } };
        q[`appeal_${i}`] = { type: 'score', instructions: `How likely is this shopper to like design d${i}?`, criteria: APPEAL };
      });
      const v = await jev({
        shopper: shopperState(catalog, bl, recent).blended_preferences,
        designs: pool.map((c, i) => ({ id: `d${i}`, description: describeSpec(catalog, c.spec) })),
      }, q);
      pool.forEach((c, i) => {
        c.ipRisk = v.answers?.[`ip_${i}`]?.noul ?? null;
        c.appeal = v.answers?.[`appeal_${i}`]?.score ?? null; // 0..3
        c.guard = checkSpec(catalog, c.spec, { inventory, ipRisk: c.ipRisk });
        if (!c.guard.pass) blocked.push(c);
      });
      c_latency = (res.latencyMs || 0) + (v.latencyMs || 0);
    }
    const passed = pool.filter((c) => c.guard.pass).slice(0, BATCH);

    // log blocked designs + guardrail counters for the dashboard
    const counters = { 'live/guardrails/evaluated': passed.length + blocked.length };
    blocked.forEach((c) => c.guard.failed.forEach((f) => (counters[`live/guardrails/${f}`] = (counters[`live/guardrails/${f}`] || 0) + 1)));
    const remapped = [...passed, ...blocked].filter((c) => c.fabricRemapped).length;
    if (remapped) counters['live/guardrails/fabricRemapped'] = remapped;
    DB.rt.incMany(counters);
    await Promise.all([...passed, ...blocked].map((c) => DB.fs.set('designs', c.key, {
      spec: c.spec, name: cap(describeSpec(catalog, c.spec)), track: 'lofi', source: 'jev',
      createdBy: u, createdAt: Date.now(), status: c.guard.pass ? 'live' : 'blocked', failed: c.guard.failed,
      jev: { conf: c.conf, ipRisk: c.ipRisk ?? null, appeal: c.appeal ?? null, explored: c.explored, fabricRemapped: c.fabricRemapped },
      cost: c.guard.cost,
    })));
    return passed.map((c) => ({ ...c, source: 'jev', latencyMs: c_latency }));
  }


  // cohort trend replication: escalated designs reach shoppers whose taste vector matches
  function trendingFor() {
    const me = vectorize(catalog, getProfile().weights || {});
    const picks = Object.values(escalations)
      .filter((e) => e.spec && !seen.has(designKey(e.spec)))
      .map((e) => ({ e, sim: cosine(me, vectorize(catalog, Object.fromEntries(specAttrs(e.spec).map((a) => [a, 1])))) }))
      .filter((x) => x.sim > 0.15)
      .sort((a, b) => b.sim - a.sim);
    if (!picks.length || Math.random() > TREND_SHARE) return [];
    const { e, sim } = picks[0];
    return [{ key: designKey(e.spec), spec: e.spec, source: 'trend', similarity: sim, guard: checkSpec(catalog, e.spec, { inventory, ipRisk: e.ipRisk ?? 0 }) }];
  }

  async function need() {
    const items = [...trendingFor(), ...(await generate())].filter((it) => !seen.has(it.key));
    items.forEach((it) => seen.add(it.key));
    return items;
  }

  // ---------- rendering ----------
  const render = (it) => {
    const g = it.guard;
    const sub = it.source === 'trend'
      ? `Trending with shoppers like you · ${pct(it.similarity)} taste match`
      : `Co-designed by Jev${it.appeal != null ? ` · ${APPEAL[Math.round(it.appeal)]?.toLowerCase()}` : ''}${it.explored ? ` · exploring new ${it.explored}` : ''}`;
    return garmentCard(catalog, it.spec, {
      title: describeSpec(catalog, it.spec),
      subtitle: sub,
      badge: it.source === 'trend' ? '<span class="pill accent">Trending</span>' : '',
      extra: `<div class="chips">${guardrailSummary(g)}${it.conf ? `<span class="pill" title="Mean Jev probability across the five design choices">Jev ${pct(Object.values(it.conf).reduce((a, b) => a + b, 0) / 5)} confident</span>` : ''}</div>
        <p class="foot"><span>Made for you in ${g.cost.turnaroundDays} days</span><span>$${g.cost.singleUnitCost.toFixed(2)} · SUCP ${g.cost.sucpPct}%</span></p>`,
      onInspect: () => inspect(catalog, it.spec, inspectBody(it)),
    });
  };

  function inspectBody(it) {
    const rows = GROUPS.map((gr) => `<span class="k">${gr}</span><span>${escapeHtml(optionLabel(catalog, gr, it.spec[gr]))}</span>
      ${it.conf ? `<span class="conf" title="Jev probability ${pct(it.conf[gr])}"><i style="width:${pct(it.conf[gr])}"></i></span>` : '<span></span>'}`).join('');
    const checks = Object.values(it.guard.checks).map((c) => `<span class="k">${c.label}</span><span>${escapeHtml(c.detail)}</span><span>${c.pass === false ? '✕' : '✓'}</span>`).join('');
    const hub = catalog.fabrics[it.spec.fabric].hub;
    return `<h3 style="margin-top:14px">Design decisions${it.conf ? ' · Jev probability' : ''}</h3><div class="kv">${rows}</div>
      <h3 style="margin-top:16px">Guardrails</h3><div class="kv">${checks}</div>
      <p class="small muted" style="margin-top:10px">Batch unit cost $${it.guard.cost.batchUnitCost} · single unit $${it.guard.cost.singleUnitCost} · supplier hub ${escapeHtml(hub)}</p>`;
  }

  const deck = new Deck(el, {
    render,
    need,
    minQueue: 3,
    emptyHtml: '<p class="muted">No more designs right now.</p>',
    onSwipe: async (it, dir) => {
      if (dir === 'super' && !(await placeOrder(catalog, u, it))) dir = 'like';
      setProfile(await recordSwipe(u, getProfile(), {
        spec: it.spec, itemId: it.key, kind: 'design', dir, track: 'lofi',
        meta: { source: it.source, appeal: it.appeal ?? null, ipRisk: it.ipRisk ?? null, explored: it.explored ?? null },
      }));
      (dir === 'nope' ? recent.nopes : recent.likes).push(describeSpec(catalog, it.spec));
      reviewed++; label();
      if (dir !== 'nope') await maybeEscalate(it);
    },
  });
  deck.refill();
  return deck;
}
