// The demo's data model. Every read/write of app data goes through here.
//
// All under shein/ in the adip-hku Realtime Database.
// Live paths (DB.rt)                                 Document collections (DB.fs → shein/docs/…)
//   users/{u}             account, consent, answers     profiles/{u}   taste profile (see taste.js), counts, cohort
//   swipes/{u}/{id}       like / nope / order stream    designs/{key}  generated designs
//   signals/{u}/{id}      dwell, purchase, social log   orders/{id}    work orders
//   live/attr/{attr}      collective counters           designImages/{id}  shared hi-fi images
//   live/designs/{key}    per-design counters
//   live/totals           likes, nopes, orders, dwells
//   inventory/{fabric}    fabric metres in stock
//   cohorts/current       centroids + labels            cohortPool/{cohort}/{key}  designs bought in a cohort
//   escalations/{key}     LATR micro-batch triggers     quota/{u}/{day}  hi-fi generations used
import { DB, rtKey } from './db.js';
import { specAttrs, designKey, applySignal, applyPrior, emptyProfile, normalise, allowedBlocks, attrKey } from './taste.js';

const USER_KEY = 'sd_user';

export const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
export const currentUser = () => { try { return localStorage.getItem(USER_KEY); } catch { return null; } };
export const setCurrentUser = (u) => { try { u ? localStorage.setItem(USER_KEY, u) : localStorage.removeItem(USER_KEY); } catch {} };

export function requireUser() {
  const u = currentUser();
  if (!u) { location.replace('index.html'); throw new Error('no user'); }
  return u;
}

export const getUser = (u) => DB.rt.get(`users/${u}`);
export async function createUser(u, data) {
  await DB.rt.set(`users/${u}`, { createdAt: Date.now(), rewardPoints: 0, ...data });
  await DB.fs.set('profiles', u, { username: u, ...emptyProfile(), swipeCount: 0, likeCount: 0, orderCount: 0, createdAt: Date.now() }, false);
}
export const updateUser = (u, data) => DB.rt.update(`users/${u}`, data);
export const touchPresence = (u) => DB.rt.set(`presence/${u}`, Date.now());

export async function getProfile(u) { return normalise(await DB.fs.get('profiles', u)); }

const PROFILE_FIELDS = ['weights', 'bySource', 'post', 'shown', 'events', 'swipeCount', 'likeCount', 'orderCount', 'dwellCount', 'cohortId', 'cohortLabel', 'pastOrders'];
export function saveProfile(u, p) {
  const out = { updatedAt: Date.now() };
  for (const f of PROFILE_FIELDS) if (p[f] !== undefined) out[f] = p[f];
  return DB.fs.set('profiles', u, out);
}

// Cohort consent per user, kept live so a signal never waits on a read.
const consentCache = new Map();
export function cohortConsent(u) {
  if (!consentCache.has(u)) {
    consentCache.set(u, true);
    DB.rt.on(`users/${u}/consent/cohort`, (v) => consentCache.set(u, v !== false));
  }
  return consentCache.get(u);
}

const SWIPE_SIGNALS = new Set(['like', 'nope', 'order']);
const COUNTER = { like: 'likes', nope: 'nopes', order: 'orders', dwell: 'dwells' };

// One piece of evidence = log entry + live counters + updated taste profile.
// Returns the new profile immediately; the writes run in the background (Firebase applies
// them locally at once and syncs in order), so swiping never waits on the network.
//   signal: like | nope | order | dwell | purchase | social
//   meta.slot: exploit | neighbour | discovery | cohort | trend  (which part of the engine proposed it)
export function recordSignal(u, profile, { spec, signal, itemId, kind = 'design', track = 'lofi', meta = {}, strength = 1 }) {
  const key = designKey(spec);
  const next = applySignal(profile, spec, signal, { strength });
  next.swipeCount = (profile.swipeCount || 0) + (SWIPE_SIGNALS.has(signal) ? 1 : 0);
  next.likeCount = (profile.likeCount || 0) + (signal === 'like' || signal === 'order' ? 1 : 0);
  next.orderCount = (profile.orderCount || 0) + (signal === 'order' ? 1 : 0);
  next.dwellCount = (profile.dwellCount || 0) + (signal === 'dwell' ? 1 : 0);
  for (const f of ['cohortId', 'cohortLabel', 'pastOrders']) if (profile[f] !== undefined) next[f] = profile[f];

  const writes = [saveProfile(u, next)];
  const entry = { itemId: itemId || key, kind, track, designKey: key, spec, ts: Date.now(), ...meta };
  if (SWIPE_SIGNALS.has(signal)) writes.push(DB.rt.push(`swipes/${u}`, { ...entry, dir: signal === 'order' ? 'super' : signal }));
  else writes.push(DB.rt.push(`signals/${u}`, { ...entry, signal }));

  const field = COUNTER[signal];
  if (field) {
    const counters = { [`live/designs/${rtKey(key)}/${field}`]: 1, [`live/totals/${field}`]: 1 };
    if (meta.slot) counters[`live/slots/${meta.slot}/${field}`] = 1;
    // opted-out shoppers still personalise, but don't feed collective trends
    if (cohortConsent(u)) specAttrs(spec).forEach((a) => (counters[`live/attr/${rtKey(a)}/${field}`] = 1));
    writes.push(DB.rt.incMany(counters));
  }
  Promise.all(writes).catch((e) => console.error('[store] signal not saved', e));
  return next;
}

// Existing customers: seed the strongest signal from their order history (older orders count less).
export function importPurchaseHistory(u, profile, persona) {
  let p = normalise(profile);
  const past = [];
  for (const [block, fabric, colour, print, fit, daysAgo] of persona.orders) {
    const spec = { block, fabric, colour, print, fit };
    p = applySignal(p, spec, 'purchase', { strength: Math.exp(-daysAgo / 240), decay: false });
    past.push({ spec, daysAgo });
  }
  p.pastOrders = past;
  DB.rt.push(`signals/${u}`, { signal: 'purchase', kind: 'history', count: past.length, persona: persona.id, ts: Date.now() });
  return p;
}

// Cold-start prior from the onboarding answers: garment types that fit the chosen occasions.
export function applyAnswers(catalog, profile, user) {
  const occ = user.occasions || [];
  const prior = {};
  for (const b of allowedBlocks(catalog, user)) {
    const hits = catalog.blocks[b].occasions.filter((o) => occ.includes(o)).length;
    if (hits) prior[attrKey('block', b)] = 0.6 * hits;
  }
  return applyPrior(profile, prior, 'answers');
}

export async function resetPreferences(u) {
  await DB.fs.set('profiles', u, { ...emptyProfile(), swipeCount: 0, likeCount: 0, orderCount: 0, dwellCount: 0, cohortId: null, cohortLabel: null, pastOrders: null, updatedAt: Date.now() });
  await DB.rt.update(`users/${u}`, { onboardingDone: false, onboardingStage: null });
}

// "Delete my data": removes the profile, histories, orders, account record and on-device photo.
export async function deleteUserData(u) {
  const orders = await DB.fs.list('orders', { where: [['username', '==', u]] });
  await Promise.all([
    DB.rt.remove(`users/${u}`), DB.rt.remove(`swipes/${u}`), DB.rt.remove(`signals/${u}`), DB.rt.remove(`presence/${u}`), DB.rt.remove(`quota/${u}`),
    DB.fs.del('profiles', u), ...orders.map((o) => DB.fs.del('orders', o.id)),
  ]);
  try { localStorage.removeItem(`sd_photo_${u}`); localStorage.removeItem(`sd_mine_${u}`); } catch {}
  if (currentUser() === u) setCurrentUser(null);
}

export { DB };
