// Synthetic shoppers so the dashboard has something to show before a live session.
// Every record is flagged `synthetic: true`, and the dashboard can remove them in one click
// (including their share of the live counters and cohort pools).
import { DB, pushId, rtKey } from './db.js';
import { specAttrs, designKey, loadCards, applySignal, emptyProfile, allowedBlocks } from './taste.js';
import { costOf } from './guardrails.js';
import { ensureCohorts, publishToPool } from './cohorts.js';

const PERSONAS = [
  { name: 'y2k', gender: 'women', occasions: ['party', 'evening', 'everyday'], likes: { block: ['crop_top', 'tank_top', 'slip_dress'], fabric: ['mesh', 'rib_knit', 'satin'], colour: ['lilac', 'hot_pink', 'cobalt'], print: ['y2k_graphic', 'leopard'], fit: ['fitted'] } },
  { name: 'minimal', gender: 'women', occasions: ['work', 'formal', 'everyday'], likes: { block: ['shirt', 'wide_leg_trousers', 'blazer', 'tailored_trousers'], fabric: ['linen', 'poplin', 'crepe', 'suiting_wool'], colour: ['cream', 'white', 'charcoal', 'black'], print: ['solid'], fit: ['oversized', 'regular'] } },
  { name: 'street', gender: 'men', occasions: ['everyday', 'sport'], likes: { block: ['hoodie', 'tee', 'joggers', 'bomber_jacket'], fabric: ['french_terry', 'denim', 'cotton_jersey', 'nylon'], colour: ['black', 'charcoal', 'denim_blue'], print: ['abstract_swirl', 'y2k_graphic', 'solid'], fit: ['oversized'] } },
  { name: 'romantic', gender: 'women', occasions: ['party', 'holiday', 'formal'], likes: { block: ['wrap_dress', 'slip_dress', 'maxi_gown', 'a_line_skirt'], fabric: ['chiffon', 'satin', 'crepe'], colour: ['butter', 'sage', 'hot_pink', 'lilac'], print: ['floral', 'polka_dot', 'gingham'], fit: ['regular', 'fitted'] } },
  { name: 'gym', gender: 'men', occasions: ['sport', 'everyday'], likes: { block: ['tank_top', 'shorts', 'joggers', 'polo'], fabric: ['performance_knit', 'cotton_jersey', 'mesh'], colour: ['black', 'cobalt', 'white', 'charcoal'], print: ['solid', 'stripe'], fit: ['fitted', 'regular'] } },
  { name: 'tailored', gender: 'any', occasions: ['work', 'formal'], likes: { block: ['blazer', 'tailored_trousers', 'shirt', 'polo'], fabric: ['suiting_wool', 'twill', 'poplin'], colour: ['charcoal', 'black', 'cream', 'denim_blue'], print: ['solid', 'stripe'], fit: ['regular', 'fitted'] } },
];
const TABLE = { block: 'blocks', fabric: 'fabrics', colour: 'colours', print: 'prints', fit: 'fits' };
const SLOTS = [['exploit', 0.5], ['neighbour', 0.2], ['discovery', 0.2], ['cohort', 0.1]];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const weighted = (pairs) => { let r = Math.random(); for (const [v, w] of pairs) if ((r -= w) <= 0) return v; return pairs[0][0]; };

export async function seedSynthetic(catalog, n = 24) {
  const cards = await loadCards();
  const counters = {};
  const add = (k, v = 1) => (counters[k] = (counters[k] || 0) + v);
  const buyers = []; // { u, spec } to share with cohorts once cohorts exist
  for (let i = 0; i < n; i++) {
    const persona = PERSONAS[i % PERSONAS.length];
    const u = `synth-${persona.name}-${pushId().slice(-4)}`;
    const customerType = Math.random() < 0.6 ? 'existing' : 'new';
    const segment = customerType === 'new' ? 'new' : Math.random() < 0.55 ? 'power' : 'dormant';
    const user = { gender: persona.gender, occasions: persona.occasions };
    const ok = new Set(allowedBlocks(catalog, user));
    const t0 = Date.now() - Math.floor(Math.random() * 6 * 3600e3);
    const score = (s) => Object.entries(persona.likes).filter(([g, v]) => v.includes(s[g])).length;
    // slot-dependent behaviour: discovery lands less often but is not ignored
    const decide = (s, slot) => {
      const base = 0.06 + 0.19 * score(s) + (segment === 'power' ? 0.06 : 0) + (slot === 'cohort' ? 0.1 : slot === 'discovery' ? -0.05 : 0);
      const p = Math.min(0.95, Math.max(0.03, base));
      const r = Math.random();
      return r < p * (segment === 'power' ? 0.13 : 0.06) ? 'order' : r < p ? 'like' : 'nope';
    };
    const personaSpec = (lean) => {
      const s = Object.fromEntries(Object.entries(persona.likes).map(([g, v]) => [g, Math.random() < lean ? pick(v) : pick(Object.keys(catalog[TABLE[g]]))]));
      if (!ok.has(s.block)) s.block = pick(persona.likes.block.filter((b) => ok.has(b))) || pick([...ok]);
      if (!catalog.blocks[s.block].fabrics.includes(s.fabric)) s.fabric = pick(catalog.blocks[s.block].fabrics);
      return s;
    };

    let profile = emptyProfile();
    const swipes = {}, signals = {};
    const log = (s, kind, track, ts, slot) => {
      const sig = track === 'onboarding' ? (decide(s, slot) === 'nope' ? 'nope' : 'like') : decide(s, slot);
      if (sig !== 'order' && Math.random() < 0.25) { // lingered without buying
        profile = applySignal(profile, s, 'dwell');
        signals[pushId() + i] = { signal: 'dwell', designKey: designKey(s), spec: s, ts, track, slot: slot || null, synthetic: true };
        add('live/totals/dwells'); if (slot) add(`live/slots/${slot}/dwells`);
      }
      profile = applySignal(profile, s, sig);
      swipes[pushId() + i] = { itemId: s.id || designKey(s), kind, track, dir: sig === 'order' ? 'super' : sig, designKey: designKey(s), spec: s, ts, slot: slot || null, synthetic: true,
        appeal: track === 'onboarding' ? null : Math.max(0, Math.min(3, score(s) * 0.6 + (Math.random() - 0.5))) };
      const f = { like: 'likes', nope: 'nopes', order: 'orders' }[sig];
      specAttrs(s).forEach((a) => add(`live/attr/${rtKey(a)}/${f}`));
      add(`live/designs/${rtKey(designKey(s))}/${f}`); add(`live/totals/${f}`);
      if (slot) { add(`live/slots/${slot}/${f}`); add(`live/slots/${slot}/shown`); }
      return sig;
    };

    // existing customers start with a purchase history in their persona's style
    const past = [];
    if (customerType === 'existing') {
      for (let j = 0; j < 6 + Math.floor(Math.random() * 6); j++) {
        const spec = personaSpec(0.85), daysAgo = 10 + Math.floor(Math.random() * 320);
        profile = applySignal(profile, spec, 'purchase', { strength: Math.exp(-daysAgo / 240), decay: false });
        past.push({ spec, daysAgo });
      }
      profile.pastOrders = past;
    }
    cards.filter((c) => ok.has(c.block)).slice(0, 12).forEach((c, j) => log(c, 'card', 'onboarding', t0 + j * 4000));
    const designs = 10 + Math.floor(Math.random() * (segment === 'power' ? 30 : segment === 'new' ? 16 : 10));
    for (let j = 0; j < designs; j++) {
      const slot = weighted(SLOTS);
      const s = personaSpec(slot === 'discovery' ? 0.25 : slot === 'neighbour' ? 0.55 : 0.75);
      const sig = log(s, 'design', 'lofi', t0 + 90e3 + j * 6000, slot);
      if (sig === 'order') {
        buyers.push({ u, spec: s });
        await DB.fs.add('orders', { username: u, designKey: designKey(s), name: designKey(s), spec: s, track: 'lofi', createdAt: t0 + j * 6000, status: 'queued', synthetic: true,
          workOrder: { orderNo: `WO-S${pushId().slice(-6).toUpperCase()}`, supplierHub: catalog.fabrics[s.fabric].hub, patternBlock: s.block, fabricType: s.fabric,
            unitCost: costOf(catalog, s).singleUnitCost, sucpPct: costOf(catalog, s).sucpPct } });
      }
    }
    const vals = Object.values(swipes);
    await DB.rt.set(`users/${u}`, { createdAt: t0, customerType, segment, gender: persona.gender, occasions: persona.occasions, persona: null,
      consent: { activity: true, cohort: true, socials: false, photo: false }, onboarding: 'swipe', onboardingDone: true, rewardPoints: 200, synthetic: true });
    await DB.rt.set(`swipes/${u}`, swipes);
    await DB.rt.set(`signals/${u}`, signals);
    await DB.fs.set('profiles', u, { username: u, ...profile, swipeCount: vals.length, likeCount: vals.filter((s) => s.dir !== 'nope').length,
      orderCount: vals.filter((s) => s.dir === 'super').length, createdAt: t0, updatedAt: Date.now(), synthetic: true, persona: persona.name }, false);
  }
  await DB.rt.incMany(counters);
  // form cohorts, then share every synthetic purchase with the buyer's cohort
  const snap = await ensureCohorts(catalog, { force: true });
  if (snap) {
    const profiles = Object.fromEntries((await DB.fs.list('profiles', { where: [['synthetic', '==', true]] })).map((p) => [p.id, p]));
    for (const b of buyers) {
      const cid = profiles[b.u]?.cohortId;
      if (cid) await publishToPool(cid, b.u, { key: designKey(b.spec), spec: b.spec, ipRisk: 0.05 });
    }
  }
}

export async function clearSynthetic() {
  const users = (await DB.rt.get('users')) || {};
  const synth = Object.keys(users).filter((u) => users[u]?.synthetic);
  const counters = {};
  const dec = (k) => (counters[k] = (counters[k] || 0) - 1);
  for (const u of synth) {
    for (const s of Object.values((await DB.rt.get(`swipes/${u}`)) || {})) {
      const f = { like: 'likes', nope: 'nopes', super: 'orders' }[s.dir];
      specAttrs(s.spec).forEach((a) => dec(`live/attr/${rtKey(a)}/${f}`));
      dec(`live/designs/${rtKey(s.designKey)}/${f}`); dec(`live/totals/${f}`);
      if (s.slot) { dec(`live/slots/${s.slot}/${f}`); dec(`live/slots/${s.slot}/shown`); }
    }
    for (const s of Object.values((await DB.rt.get(`signals/${u}`)) || {})) {
      if (s.signal === 'dwell') { dec('live/totals/dwells'); if (s.slot) dec(`live/slots/${s.slot}/dwells`); }
    }
    await Promise.all([DB.rt.remove(`users/${u}`), DB.rt.remove(`swipes/${u}`), DB.rt.remove(`signals/${u}`), DB.fs.del('profiles', u)]);
  }
  for (const o of await DB.fs.list('orders', { where: [['synthetic', '==', true]] })) await DB.fs.del('orders', o.id);
  // drop synthetic buyers from cohort pools
  const pools = (await DB.rt.get('cohortPool')) || {};
  for (const [cid, items] of Object.entries(pools)) {
    for (const [k, it] of Object.entries(items || {})) {
      const left = Object.keys(it.buyers || {}).filter((b) => !synth.includes(b));
      const removed = Object.keys(it.buyers || {}).length - left.length;
      if (!removed) continue;
      for (let i = 0; i < removed; i++) dec('live/pool/published');
      if (!left.length) await DB.rt.remove(`cohortPool/${cid}/${k}`);
      else await DB.rt.update(`cohortPool/${cid}/${k}`, { buyers: Object.fromEntries(left.map((b) => [b, true])), count: left.length });
    }
  }
  if (Object.keys(counters).length) await DB.rt.incMany(counters);
  return synth.length;
}
