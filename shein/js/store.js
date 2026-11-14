// The demo's data model. Every read/write of app data goes through here so the
// live-vs-document split lives in one place.
//
// All under shein/ in the adip-hku Realtime Database.
// Live paths (DB.rt)                               Document collections (DB.fs → shein/docs/…)
//   users/{u}            account + consent          profiles/{u}   taste weights, counts, cohort
//   swipes/{u}/{id}      swipe stream               designs/{key}  generated designs
//   live/attr/{attr}     like/nope/order counters   orders/{id}    work orders
//   live/designs/{key}   per-design counters        cohorts/{id}   cohort snapshots
//   inventory/{fabric}   fabric meters in stock     designImages/{id}  hi-fi images
//   escalations/{key}    LATR micro-batch triggers
//   presence/{u}         last seen
import { DB, rtKey } from './db.js';
import { specAttrs, updateWeights, designKey } from './taste.js';

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
  await DB.fs.set('profiles', u, { username: u, weights: {}, swipeCount: 0, likeCount: 0, createdAt: Date.now() }, false);
}
export const updateUser = (u, data) => DB.rt.update(`users/${u}`, data);
export const touchPresence = (u) => DB.rt.set(`presence/${u}`, Date.now());

export const getProfile = (u) => DB.fs.get('profiles', u);

// Cohort consent per user, kept live so a swipe never waits on a read.
const consentCache = new Map();
function cohortConsent(u) {
  if (!consentCache.has(u)) {
    consentCache.set(u, true);
    DB.rt.on(`users/${u}/consent/cohort`, (v) => consentCache.set(u, v !== false));
  }
  return consentCache.get(u);
}

// One swipe = swipe log + live counters + updated taste profile document.
// Returns the new profile immediately; the three writes run in the background (Firebase applies
// them locally at once and syncs in order), so swiping never waits on the network.
export async function recordSwipe(u, profile, { spec, itemId, kind, dir, track = 'onboarding', meta = {} }) {
  const key = designKey(spec);
  const field = { like: 'likes', nope: 'nopes', super: 'orders' }[dir];
  const counters = { [`live/designs/${rtKey(key)}/${field}`]: 1, [`live/totals/${field}`]: 1 };
  // users who opted out of cohort aggregation still personalise, but don't feed collective trends
  if (cohortConsent(u)) specAttrs(spec).forEach((a) => (counters[`live/attr/${rtKey(a)}/${field}`] = 1));

  const weights = updateWeights(profile.weights || {}, spec, dir);
  const next = {
    ...profile, weights, updatedAt: Date.now(),
    swipeCount: (profile.swipeCount || 0) + 1,
    likeCount: (profile.likeCount || 0) + (dir === 'nope' ? 0 : 1),
  };
  Promise.all([
    DB.rt.push(`swipes/${u}`, { itemId, kind, track, dir, designKey: key, spec, ts: Date.now(), ...meta }),
    DB.rt.incMany(counters),
    DB.fs.set('profiles', u, { weights, updatedAt: next.updatedAt, swipeCount: next.swipeCount, likeCount: next.likeCount }),
  ]).catch((e) => console.error('[store] swipe not saved', e));
  return next;
}

export async function resetPreferences(u) {
  await DB.fs.set('profiles', u, { weights: {}, swipeCount: 0, likeCount: 0, cohortId: null, updatedAt: Date.now() });
  await DB.rt.update(`users/${u}`, { onboardingDone: false });
}

// "Delete my data": removes the profile, swipe history, orders and account record.
export async function deleteUserData(u) {
  const orders = await DB.fs.list('orders', { where: [['username', '==', u]] });
  await Promise.all([
    DB.rt.remove(`users/${u}`), DB.rt.remove(`swipes/${u}`), DB.rt.remove(`presence/${u}`),
    DB.fs.del('profiles', u), ...orders.map((o) => DB.fs.del('orders', o.id)),
  ]);
  if (currentUser() === u) setCurrentUser(null);
}

export { DB };
