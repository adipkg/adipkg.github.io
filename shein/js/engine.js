// The design engine: proposes designs for one shopper, balancing exploitation and exploration.
// Used by the swipe deck and the "For you" gallery.
//
// Per batch:
//   1. Jev call #1: a `choice` question per attribute → Jev's probability for every catalogue option,
//      given the 60/30/10 blend, recent reactions, purchases, socials and occasions.
//   2. Each option is scored  jevP^0.6 × Thompson(option) × novelty(option):
//      Thompson draws a plausible like-rate from the shopper's evidence for that option, so rarely-seen
//      options get a fair chance and consistently-rejected ones fade; novelty damps options shown a lot lately.
//   3. The batch is a SLATE, not N copies of the favourite:
//        exploit    best-scoring design
//        neighbour  the favourite with 1–2 attributes changed
//        discovery  built mostly from options the shopper has rarely seen
//      plus at most one "bought by your cohort" design and one trending design.
//      The explore level (shein/settings/explore, set on the dashboard) sets the mix.
//   4. Guardrails 1–3 by construction (allowed garment types, compatible in-stock fabric) and by check (cost/speed).
//   5. Jev call #2: IP risk (guardrail 4) and predicted appeal for each new design.
import { DB } from './db.js';
import { jev } from './api.js';
import { checkSpec } from './guardrails.js';
import {
  loadKol, blend, GROUPS, options, optionLabel, describeSpec, designKey, specAttrs, attrKey, specVector, vectorize, cosine,
  topOf, thompson, reasonFor, attrPhrase, allowedBlocks, normalise,
} from './taste.js';
import { poolFor } from './cohorts.js';

export const APPEAL = ['Unlikely to like it', 'Might like it', 'Likely to like it', 'Will love it'];
export const DEFAULT_EXPLORE = 0.35;
const pct = (x) => `${Math.round(x * 100)}%`;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// How many of each slot in a batch of 4 at a given explore level (0 = pure exploitation, 1 = mostly discovery).
export function slateMix(level, size = 4) {
  const discovery = level >= 0.75 ? 2 : level >= 0.2 ? 1 : 0;
  const neighbour = level >= 0.1 ? 1 : 0;
  return { exploit: Math.max(1, size - discovery - neighbour), neighbour, discovery };
}

export function designQuestions(catalog, blocks) {
  const choice = (group, instructions, opts, describe) => ({ type: 'choice', instructions, criteria: Object.fromEntries(opts.map((o) => [o, describe(o)])) });
  return {
    block: choice('block', 'Which garment type should we design next for this shopper?', blocks, (o) => catalog.blocks[o].desc),
    fabric: choice('fabric', 'Which fabric would this shopper most want to wear?', options(catalog, 'fabric'), (o) => catalog.fabrics[o].label),
    colour: choice('colour', 'Which colour should the next design be?', options(catalog, 'colour'), (o) => catalog.colours[o].label),
    print: choice('print', 'Which print or pattern should the next design use?', options(catalog, 'print'), (o) => catalog.prints[o].label),
    fit: choice('fit', 'Which fit should the next design have?', options(catalog, 'fit'), (o) => catalog.fits[o].label),
  };
}

export function shopperState(catalog, bl, { recent, user, profile }) {
  const past = (profile?.pastOrders || []).slice(0, 5).map((o) => describeSpec(catalog, o.spec));
  return {
    task: 'Co-design the next garment to show this shopper.',
    shopping_for: (user?.occasions || []).map((o) => catalog.occasions[o]?.label || o),
    wears: user?.gender === 'men' ? 'menswear' : user?.gender === 'women' ? 'womenswear' : 'any',
    blended_preferences: Object.fromEntries(GROUPS.map((g) => [g, topOf(bl[g], 4).map(([o, v]) => `${optionLabel(catalog, g, o)} ${pct(v.p)}`).join(', ')])),
    previously_bought: past,
    social_interests: user?.socials?.interests || [],
    recently_liked: recent.likes.slice(-6),
    recently_disliked: recent.nopes.slice(-4),
  };
}

export async function createEngine({ catalog, u, user, getProfile }) {
  const kol = await loadKol();
  const state = { live: {}, inventory: null, escalations: {}, explore: DEFAULT_EXPLORE };
  DB.rt.on('live/attr', (v) => (state.live = v || {}));
  DB.rt.on('escalations', (v) => (state.escalations = v || {}));
  DB.rt.on('settings/explore', (v) => (state.explore = typeof v === 'number' ? v : DEFAULT_EXPLORE));
  if (!(await DB.rt.get('inventory'))) await DB.rt.set('inventory', catalog.inventoryMeters);
  DB.rt.on('inventory', (v) => (state.inventory = { ...catalog.inventoryMeters, ...(v || {}) }));

  const history = Object.values((await DB.rt.get(`swipes/${u}`)) || {}).sort((a, b) => a.ts - b.ts);
  const seen = new Set(history.map((s) => s.designKey));
  const recent = {
    likes: history.filter((s) => s.dir !== 'nope').map((s) => describeSpec(catalog, s.spec)),
    nopes: history.filter((s) => s.dir === 'nope').map((s) => describeSpec(catalog, s.spec)),
  };
  const blocks = allowedBlocks(catalog, user);

  // ---------- scoring ----------
  // `used` counts attributes already picked (or rejected as duplicates) in this batch, so each pick
  // is pushed away from the last: diversity within a slate, and no getting stuck on one favourite.
  function optionScores(profile, probs, group, allowed, mode, used = {}) {
    return allowed.map((o) => {
      const k = attrKey(group, o);
      const spread = 0.55 ** (used[k] || 0);
      const jp = Math.max(probs[group]?.[o] ?? 0, 0.002);
      const novelty = 1 / (1 + 0.08 * (profile.shown?.[k] || 0));
      const s = mode === 'discovery'
        ? jp ** 0.15 * novelty ** 3 * (0.5 + Math.random())          // mostly "what haven't they seen"
        : jp ** 0.6 * thompson(profile, k) * novelty;                 // taste, with principled uncertainty
      return [o, s * spread];
    }).sort((a, b) => b[1] - a[1]);
  }

  function fabricsFor(block) {
    const B = catalog.blocks[block];
    return B.fabrics.filter((f) => (state.inventory?.[f] ?? 0) >= B.meters); // guardrails 1 & 2 by construction
  }

  function build(profile, probs, mode, base, used) {
    const spec = {};
    if (mode === 'neighbour' && base) {
      Object.assign(spec, base.spec);
      const groups = [...GROUPS].sort(() => Math.random() - 0.5).slice(0, 1 + (Math.random() < 0.4 ? 1 : 0));
      for (const g of groups) {
        const allowed = g === 'block' ? blocks : g === 'fabric' ? fabricsFor(spec.block) : options(catalog, g);
        const ranked = optionScores(profile, probs, g, allowed.filter((o) => o !== spec[g]), 'exploit', used);
        if (ranked.length) spec[g] = ranked[0][0];
      }
      if (!fabricsFor(spec.block).includes(spec.fabric)) spec.fabric = optionScores(profile, probs, 'fabric', fabricsFor(spec.block), 'exploit', used)[0]?.[0];
      return { spec, changed: groups };
    }
    spec.block = optionScores(profile, probs, 'block', blocks, mode, used)[0][0];
    const fab = fabricsFor(spec.block);
    if (!fab.length) return null;
    spec.fabric = optionScores(profile, probs, 'fabric', fab, mode, used)[0][0];
    for (const g of ['colour', 'print', 'fit']) spec[g] = optionScores(profile, probs, g, options(catalog, g), mode, used)[0][0];
    return { spec };
  }

  function reasonText(profile, cand) {
    if (cand.slot === 'neighbour') {
      const g = cand.changed[0];
      return `A twist on your favourites: new ${g} (${optionLabel(catalog, g, cand.spec[g]).toLowerCase()})`;
    }
    if (cand.slot === 'discovery') {
      const least = specAttrs(cand.spec).sort((a, b) => (profile.shown?.[a] || 0) - (profile.shown?.[b] || 0))[0];
      return `Exploring: ${attrPhrase(catalog, least)}, new for you`;
    }
    return reasonFor(catalog, profile, cand.spec);
  }

  // ---------- cohort pool & trends ----------
  async function cohortItems(profile, n = 1) {
    const items = (await poolFor(profile.cohortId)).filter((p) => p.spec && !seen.has(p.key) && !p.buyers?.[u]);
    return items.slice(0, n).map((p) => ({
      key: p.key, spec: p.spec, slot: 'cohort', ipRisk: p.ipRisk ?? 0, buyers: p.count,
      reason: `Bought by ${p.count} ${p.count === 1 ? 'person' : 'people'} with your taste`,
      guard: checkSpec(catalog, p.spec, { inventory: state.inventory, ipRisk: p.ipRisk ?? 0 }),
    }));
  }

  function trendItems(profile, n = 1) {
    const me = vectorize(catalog, profile.weights || {});
    return Object.values(state.escalations)
      .filter((e) => e.spec && !seen.has(designKey(e.spec)) && blocks.includes(e.spec.block))
      .map((e) => ({ e, sim: cosine(me, specVector(catalog, e.spec)) }))
      .filter((x) => x.sim > 0.15).sort((a, b) => b.sim - a.sim).slice(0, n)
      .map(({ e, sim }) => ({
        key: designKey(e.spec), spec: e.spec, slot: 'trend', similarity: sim, ipRisk: e.ipRisk ?? 0,
        reason: `Trending with shoppers like you · ${pct(sim)} taste match`,
        guard: checkSpec(catalog, e.spec, { inventory: state.inventory, ipRisk: e.ipRisk ?? 0 }),
      }));
  }

  // ---------- one batch ----------
  // opts.mix overrides the slot mix; opts.extras=false skips cohort/trend items; opts.size defaults to 4.
  async function batch({ size = 4, mix, extras = true, record = true } = {}) {
    const profile = normalise(getProfile());
    const bl = blend(catalog, profile.weights || {}, kol.looks, state.live);
    const res = await jev(shopperState(catalog, bl, { recent, user, profile }), designQuestions(catalog, blocks));
    const probs = Object.fromEntries(GROUPS.map((g) => [g, res.answers?.[g]?.probabilities || {}]));
    if (GROUPS.some((g) => !Object.keys(probs[g]).length)) throw new Error('Jev returned no probabilities');

    const want = mix || slateMix(state.explore, size);
    const chosen = [], blocked = [];
    const taken = (spec) => seen.has(designKey(spec)) || [...chosen, ...blocked].some((c) => c.key === designKey(spec)
      || (c.spec.block === spec.block && c.spec.colour === spec.colour));
    const used = {};
    const bump = (spec) => specAttrs(spec).forEach((k) => (used[k] = (used[k] || 0) + 1));
    const add = (slot, built) => {
      if (!built?.spec?.fabric) return false;
      bump(built.spec);
      if (taken(built.spec)) return false;
      const cand = { key: designKey(built.spec), spec: built.spec, slot, changed: built.changed,
        conf: Object.fromEntries(GROUPS.map((g) => [g, probs[g][built.spec[g]] ?? 0])), guard: checkSpec(catalog, built.spec, { inventory: state.inventory }) };
      (cand.guard.pass ? chosen : blocked).push(cand);
      return cand.guard.pass;
    };
    for (const slot of ['exploit', 'neighbour', 'discovery']) {
      for (let n = 0, tries = 0; n < (want[slot] || 0) && tries < 25; tries++) {
        const base = slot === 'neighbour' ? chosen.find((c) => c.slot === 'exploit') || chosen[0] : null;
        if (slot === 'neighbour' && !base) { if (add('neighbour', build(profile, probs, 'exploit', null, used))) n++; continue; }
        if (add(slot, build(profile, probs, slot, base, used))) n++;
      }
    }
    chosen.forEach((c) => (c.reason = reasonText(profile, c)));

    // guardrail 4 + predicted appeal, in one Jev pass
    if (chosen.length) {
      const q = {};
      chosen.forEach((c, i) => {
        q[`ip_${i}`] = { type: 'noul',
          instructions: `Does design d${i} closely imitate a protected brand signature: a trademarked monogram or check, a logo, or a famous designer's iconic piece?`,
          criteria: { true: 'It reproduces a recognisable protected brand pattern, logo or iconic design.', false: 'It is a generic garment built from common shapes, colours and prints.' } };
        q[`appeal_${i}`] = { type: 'score', instructions: `How likely is this shopper to like design d${i}?`, criteria: APPEAL };
      });
      const v = await jev({ shopper: shopperState(catalog, bl, { recent, user, profile }).blended_preferences,
        designs: chosen.map((c, i) => ({ id: `d${i}`, description: describeSpec(catalog, c.spec) })) }, q);
      chosen.forEach((c, i) => {
        c.ipRisk = v.answers?.[`ip_${i}`]?.noul ?? null;
        c.appeal = v.answers?.[`appeal_${i}`]?.score ?? null;
        c.guard = checkSpec(catalog, c.spec, { inventory: state.inventory, ipRisk: c.ipRisk });
        if (!c.guard.pass) blocked.push(c);
      });
    }
    let items = chosen.filter((c) => c.guard.pass);
    if (extras) {
      // at most one shared pick per batch, and not every batch, so it informs rather than floods the feed
      const cohort = Math.random() < 0.5 ? await cohortItems(profile, 1) : [];
      const trend = cohort.length || Math.random() > 0.3 ? [] : trendItems(profile, 1);
      items = [...cohort, ...trend, ...items];
    }
    items.forEach((it) => seen.add(it.key));

    if (record) {
      const counters = { 'live/guardrails/evaluated': chosen.length + blocked.length };
      blocked.forEach((c) => c.guard.failed.forEach((f) => (counters[`live/guardrails/${f}`] = (counters[`live/guardrails/${f}`] || 0) + 1)));
      items.forEach((it) => (counters[`live/slots/${it.slot}/shown`] = (counters[`live/slots/${it.slot}/shown`] || 0) + 1));
      DB.rt.incMany(counters);
      Promise.all([...chosen, ...blocked.filter((b) => !chosen.includes(b))].map((c) => DB.fs.set('designs', c.key, {
        spec: c.spec, name: describeSpec(catalog, c.spec), track: 'lofi', source: 'jev', slot: c.slot,
        createdBy: u, createdAt: Date.now(), status: c.guard.pass ? 'live' : 'blocked', failed: c.guard.failed,
        jev: { conf: c.conf, ipRisk: c.ipRisk ?? null, appeal: c.appeal ?? null }, cost: c.guard.cost,
      }))).catch((e) => console.warn('[engine] design log failed', e));
    }
    return items;
  }

  return {
    batch, seen, recent, state, blocks,
    cohortItems: (n = 8) => cohortItems(normalise(getProfile()), n),
    trendItems: (n = 6) => trendItems(normalise(getProfile()), n),
    noteReaction(spec, signal) { (signal === 'nope' ? recent.nopes : recent.likes).push(describeSpec(catalog, spec)); },
  };
}
