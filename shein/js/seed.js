// Synthetic shoppers so the dashboard has something to show before a live session.
// Every record is flagged `synthetic: true`, and the dashboard can remove them in one click.
import { DB, pushId, rtKey } from './db.js';
import { specAttrs, updateWeights, designKey, loadCards } from './taste.js';
import { costOf } from './guardrails.js';

const PERSONAS = [
  { name: 'y2k', likes: { block: ['crop_top', 'tee', 'slip_dress'], fabric: ['mesh', 'rib_knit', 'satin'], colour: ['lilac', 'hot_pink', 'cobalt'], print: ['y2k_graphic', 'leopard'], fit: ['fitted'] } },
  { name: 'minimal', likes: { block: ['shirt', 'wide_leg_trousers', 'blazer'], fabric: ['linen', 'poplin', 'crepe'], colour: ['cream', 'white', 'charcoal', 'black'], print: ['solid'], fit: ['oversized', 'regular'] } },
  { name: 'street', likes: { block: ['hoodie', 'tee', 'wide_leg_trousers'], fabric: ['french_terry', 'denim', 'cotton_jersey'], colour: ['black', 'charcoal', 'denim_blue'], print: ['abstract_swirl', 'y2k_graphic', 'solid'], fit: ['oversized'] } },
  { name: 'romantic', likes: { block: ['wrap_dress', 'slip_dress', 'a_line_skirt'], fabric: ['chiffon', 'satin', 'crepe'], colour: ['butter', 'sage', 'hot_pink', 'lilac'], print: ['floral', 'polka_dot', 'gingham'], fit: ['regular', 'fitted'] } },
];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

export async function seedSynthetic(catalog, n = 24) {
  const cards = await loadCards();
  const counters = {};
  const add = (k, v = 1) => (counters[k] = (counters[k] || 0) + v);
  for (let i = 0; i < n; i++) {
    const persona = PERSONAS[i % PERSONAS.length];
    const u = `synth-${persona.name}-${pushId().slice(-4)}`;
    const segment = Math.random() < 0.55 ? 'power' : 'dormant';
    const t0 = Date.now() - Math.floor(Math.random() * 6 * 3600e3);
    const score = (s) => Object.entries(persona.likes).filter(([g, v]) => v.includes(s[g])).length;
    let weights = {};
    const swipes = {};
    const decide = (s) => {
      const p = Math.min(0.95, 0.08 + 0.2 * score(s) + (segment === 'power' ? 0.06 : 0));
      const r = Math.random();
      return r < p * (segment === 'power' ? 0.12 : 0.05) ? 'super' : r < p ? 'like' : 'nope';
    };
    const log = (s, kind, track, ts) => {
      const dir = decide(s);
      weights = updateWeights(weights, s, dir);
      swipes[pushId() + i] = { itemId: s.id || designKey(s), kind, track, dir, designKey: designKey(s), spec: s, ts, synthetic: true };
      const f = { like: 'likes', nope: 'nopes', super: 'orders' }[dir];
      specAttrs(s).forEach((a) => add(`live/attr/${rtKey(a)}/${f}`));
      add(`live/designs/${rtKey(designKey(s))}/${f}`); add(`live/totals/${f}`);
      return dir;
    };
    cards.forEach((c, j) => log(c, 'card', 'onboarding', t0 + j * 4000));
    const designs = 10 + Math.floor(Math.random() * (segment === 'power' ? 30 : 10));
    for (let j = 0; j < designs; j++) {
      // persona-leaning designs, as the engine would show them
      const s = Object.fromEntries(Object.entries(persona.likes).map(([g, v]) => [g, Math.random() < 0.7 ? pick(v) : pick(Object.keys(catalog[{ block: 'blocks', fabric: 'fabrics', colour: 'colours', print: 'prints', fit: 'fits' }[g]]))]));
      if (!catalog.blocks[s.block].fabrics.includes(s.fabric)) s.fabric = pick(catalog.blocks[s.block].fabrics);
      const dir = log(s, 'design', 'lofi', t0 + 90e3 + j * 6000);
      swipes[Object.keys(swipes).at(-1)].appeal = Math.max(0, Math.min(3, score(s) * 0.6 + (Math.random() - 0.5)));
      if (dir === 'super') await DB.fs.add('orders', { username: u, designKey: designKey(s), name: designKey(s), spec: s, track: 'lofi', createdAt: t0 + j * 6000, status: 'queued', synthetic: true,
        workOrder: { orderNo: `WO-S${pushId().slice(-6).toUpperCase()}`, supplierHub: catalog.fabrics[s.fabric].hub, patternBlock: s.block, fabricType: s.fabric,
          unitCost: costOf(catalog, s).singleUnitCost, sucpPct: costOf(catalog, s).sucpPct } });
    }
    const vals = Object.values(swipes);
    await DB.rt.set(`users/${u}`, { createdAt: t0, segment, consent: { swipe: true, cohort: true, socialSync: false }, onboarding: 'swipe', onboardingDone: true, rewardPoints: 200, synthetic: true });
    await DB.rt.set(`swipes/${u}`, swipes);
    await DB.fs.set('profiles', u, { username: u, weights, swipeCount: vals.length, likeCount: vals.filter((s) => s.dir !== 'nope').length, createdAt: t0, updatedAt: Date.now(), synthetic: true, persona: persona.name }, false);
  }
  await DB.rt.incMany(counters);
}

export async function clearSynthetic() {
  const users = (await DB.rt.get('users')) || {};
  const synth = Object.keys(users).filter((u) => users[u]?.synthetic);
  // remove their contribution from the live counters
  const counters = {};
  for (const u of synth) {
    for (const s of Object.values((await DB.rt.get(`swipes/${u}`)) || {})) {
      const f = { like: 'likes', nope: 'nopes', super: 'orders' }[s.dir];
      specAttrs(s.spec).forEach((a) => (counters[`live/attr/${rtKey(a)}/${f}`] = (counters[`live/attr/${rtKey(a)}/${f}`] || 0) - 1));
      const k = `live/designs/${rtKey(s.designKey)}/${f}`; counters[k] = (counters[k] || 0) - 1;
      counters[`live/totals/${f}`] = (counters[`live/totals/${f}`] || 0) - 1;
    }
    await Promise.all([DB.rt.remove(`users/${u}`), DB.rt.remove(`swipes/${u}`), DB.fs.del('profiles', u)]);
  }
  for (const o of await DB.fs.list('orders', { where: [['synthetic', '==', true]] })) await DB.fs.del('orders', o.id);
  if (Object.keys(counters).length) await DB.rt.incMany(counters);
  return synth.length;
}
