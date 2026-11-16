// "Made for you": a curated gallery, separate from the regular catalogue. Same engine and signals as the
// swipe deck, laid out as rows a shopper can browse; every tile can be liked or passed in place.
import { chrome, toast, escapeHtml, icon } from './ui.js';
import { snapshot } from './garment.js';
import { loadCatalog, describeSpec, specFromKey, trendScore, specVector, vectorize, cosine, designKey } from './taste.js';
import { requireUser, getUser, getProfile, recordSignal, touchPresence, DB } from './store.js';
import { createEngine } from './engine.js';
import { checkSpec } from './guardrails.js';
import { placeOrder, maybeEscalate } from './orders.js';
import { openDesignSheet, openRealSheet, SLOT_BADGE } from './design-ui.js';
import { approvedLooks, imageFor, myLooks } from './hifi.js';

chrome('foryou.html');
const u = requireUser();
const [catalog, user] = await Promise.all([loadCatalog(), getUser(u)]);
if (!user) location.replace('index.html');
if (!user.onboardingDone) location.replace('swipe.html');
let profile = await getProfile(u);
touchPresence(u);
const engine = await createEngine({ catalog, u, user, getProfile: () => profile });
const ctx = { u, user, get inventory() { return engine.state.inventory; } };
const $ = (s) => document.querySelector(s);
$('#intro').textContent = profile.cohortLabel
  ? `Designed from your taste and your style cohort, “${profile.cohortLabel}”. Tap a piece for details, like or pass it here, or see it for real.`
  : 'Designed from your taste. Tap a piece for details, like or pass it here, or see it for real.';

const reacted = new Map(); // key → signal, for this visit
function signal(it, sig, extra = {}) {
  profile = recordSignal(u, profile, { spec: it.spec, signal: sig, itemId: it.key, track: 'gallery', meta: { slot: it.slot || 'gallery', surface: 'gallery', ...extra } });
  if (sig !== 'dwell') { reacted.set(it.key, sig); engine.noteReaction(it.spec, sig); paintTile(it); }
  if (sig === 'like' || sig === 'order') maybeEscalate(it);
}
async function order(it) {
  if (await placeOrder(catalog, u, { ...it, track: 'gallery' }, { cohortId: profile.cohortId })) signal(it, 'order');
}
const open = (it) => openDesignSheet(catalog, it, {
  onSignal: (s) => signal(it, s, s === 'dwell' ? { via: 'detail' } : {}), onOrder: () => order(it), onReal: () => openRealSheet(catalog, ctx, it),
});

// ---------- tiles ----------
const tiles = new Map();
function tile(it) {
  const el = document.createElement('article');
  el.className = 'tile';
  el.innerHTML = `<button class="tile-art" aria-label="Open ${escapeHtml(describeSpec(catalog, it.spec))}">
      <img alt="" src="${it.image ? '' : snapshot(catalog, it.spec, { w: 320, h: 400 })}" style="${it.image ? 'object-fit:cover' : ''}">
      ${SLOT_BADGE[it.slot] && it.slot !== 'exploit' ? `<span class="pill accent tile-badge">${SLOT_BADGE[it.slot]}</span>` : ''}</button>
    <div class="tile-meta"><strong>${escapeHtml(describeSpec(catalog, it.spec))}</strong>
      <span class="muted">${escapeHtml(it.reason || '')}</span></div>
    <div class="tile-acts"><button class="icon-btn" data-s="nope" aria-label="Pass">${icon('x')}</button>
      <span class="muted small">$${it.guard.cost.singleUnitCost.toFixed(2)}</span>
      <button class="icon-btn" data-s="like" aria-label="Like">${icon('heart')}</button></div>`;
  if (it.image) imageFor(it.image).then((src) => (el.querySelector('img').src = src));
  el.querySelector('.tile-art').onclick = () => open(it);
  el.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => signal(it, b.dataset.s)));
  tiles.set(it.key, { el, it });
  return el;
}
function paintTile(it) {
  const t = tiles.get(it.key); if (!t) return;
  const s = reacted.get(it.key);
  t.el.classList.toggle('liked', s === 'like' || s === 'order');
  t.el.classList.toggle('passed', s === 'nope');
  t.el.querySelector('[data-s=like]').innerHTML = icon('heart', { fill: s === 'like' || s === 'order' });
}

// ---------- rows ----------
function row(id, title, sub) {
  const sec = document.createElement('section');
  sec.className = 'gallery-row';
  sec.innerHTML = `<div class="head-row"><h2 style="margin:0">${title}</h2><span class="muted small">${sub}</span></div>
    <div class="rail" data-rail>${'<div class="tile skeleton"></div>'.repeat(3)}</div>`;
  $('#rows').append(sec);
  return {
    fill(items, empty) {
      const rail = sec.querySelector('[data-rail]');
      rail.innerHTML = '';
      if (!items.length) { rail.outerHTML = `<p class="muted small" style="margin:8px 0 0">${empty}</p>`; return; }
      items.forEach((it) => rail.append(tile(it)));
    },
    fail(e) { sec.querySelector('[data-rail]').outerHTML = `<p class="err small">${escapeHtml(e.message)}</p>`; },
  };
}

// Trending in the shopper's style: top designs by collective trend score, nearest to their taste.
async function trendingInStyle(n = 6) {
  const live = (await DB.rt.get('live/designs')) || {};
  const me = vectorize(catalog, profile.weights || {});
  const ok = new Set(engine.blocks);
  return Object.entries(live)
    .map(([k, c]) => ({ spec: specFromKey(k), score: trendScore(c), c }))
    .filter((x) => x.score > 0 && ok.has(x.spec.block) && catalog.blocks[x.spec.block]?.fabrics.includes(x.spec.fabric))
    .map((x) => ({ ...x, sim: cosine(me, specVector(catalog, x.spec)) }))
    .sort((a, b) => b.score * (0.5 + b.sim) - a.score * (0.5 + a.sim)).slice(0, n)
    .map((x) => ({ key: designKey(x.spec), spec: x.spec, slot: 'trend', reason: `${x.c.orders || 0} bought · ${x.c.likes || 0} liked`,
      guard: checkSpec(catalog, x.spec, { inventory: engine.state.inventory, ipRisk: 0 }) }));
}

async function load() {
  $('#rows').innerHTML = ''; tiles.clear();
  const made = row('made', 'Made for you', 'Your strongest matches');
  const cohort = row('cohort', 'Bought by your cohort', profile.cohortLabel ? `Shoppers like you · ${profile.cohortLabel}` : 'Shoppers with your taste');
  const trend = row('trend', 'Trending in your style', 'Most liked & bought, nearest your taste');
  const fresh = row('new', 'Something new', 'Exploring outside your usual picks');
  const looks = row('looks', 'Real-life looks', 'Human-approved photo renders');
  engine.batch({ size: 6, mix: { exploit: 4, neighbour: 2, discovery: 0 }, extras: false }).then((i) => made.fill(i, 'No designs yet.')).catch((e) => made.fail(e));
  engine.cohortItems(8).then((i) => cohort.fill(i, 'Nobody in your cohort has bought a design yet. Be the first: it will appear here for them.')).catch((e) => cohort.fail(e));
  trendingInStyle().then((i) => trend.fill(i, 'Nothing trending yet.')).catch((e) => trend.fail(e));
  engine.batch({ size: 4, mix: { exploit: 0, neighbour: 0, discovery: 4 }, extras: false }).then((i) => fresh.fill(i, 'Nothing new right now.')).catch((e) => fresh.fail(e));
  approvedLooks(catalog, profile.weights).then((docs) => looks.fill(docs.slice(0, 8).map((d) => ({
    key: d.id, spec: d.spec, image: d.imageId, slot: 'gallery', reason: `${d.bodyType ? d.bodyType.split(',')[0] + ' model' : 'Studio'} · ${Math.round(d.match * 100)}% match`,
    guard: checkSpec(catalog, d.spec, { inventory: engine.state.inventory, ipRisk: d.jev?.ipRisk ?? 0 }),
  })), 'No approved photo renders yet. Use “See it for real” on any design.')).catch((e) => looks.fail(e));
  const mine = myLooks(u);
  if (mine.length) {
    const sec = document.createElement('section');
    sec.className = 'gallery-row';
    sec.innerHTML = `<div class="head-row"><h2 style="margin:0">On you</h2><span class="muted small">Private · stored on this device only</span></div>
      <div class="rail">${mine.map((m) => `<figure class="tile" style="margin:0"><img src="${m.src}" alt="" style="width:100%;aspect-ratio:4/5;object-fit:cover;display:block">
      <figcaption class="tile-meta"><strong>${escapeHtml(describeSpec(catalog, m.spec))}</strong></figcaption></figure>`).join('')}</div>`;
    $('#rows').append(sec);
  }
}
$('#refresh').onclick = () => { load(); toast('Fresh picks on the way'); };
load();
