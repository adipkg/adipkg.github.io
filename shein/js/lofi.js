// Lo-fi prototype: the endless swipe deck of Jev-designed garments rendered in three.js.
// Design generation lives in engine.js; this file wires it to the deck and records every signal:
//   → like · ← pass · ↑ order (strongest signal; shared with the shopper's cohort)
//   a card looked at for ≥ 4 s, or opened in 3D, without being bought → weak "dwell" signal
import { Deck } from './swipe.js';
import { createEngine } from './engine.js';
import { recordSignal } from './store.js';
import { assignCohort } from './cohorts.js';
import { placeOrder, maybeEscalate } from './orders.js';
import { designCard, openDesignSheet, openRealSheet, DWELL_MS } from './design-ui.js';

const RECLUSTER_EVERY = 8; // signals between cohort re-assignments

export async function startDesignDeck({ el, catalog, u, user, getProfile, setProfile, setPhase }) {
  const engine = await createEngine({ catalog, u, user, getProfile });
  let reviewed = getProfile().swipeCount || 0;
  let sinceCohort = 0;
  const label = () => setPhase(`Your co-created feed · ${reviewed} designs reviewed`, 100);
  label();
  const inspected = new Set();

  const signal = (it, sig, extra = {}) => {
    setProfile(recordSignal(u, getProfile(), {
      spec: it.spec, signal: sig, itemId: it.key, track: 'lofi',
      meta: { slot: it.slot, appeal: it.appeal ?? null, ipRisk: it.ipRisk ?? null, ...extra },
    }));
    if (sig !== 'dwell') engine.noteReaction(it.spec, sig);
  };

  const ctx = { u, user, get inventory() { return engine.state.inventory; } };
  const render = (it) => designCard(catalog, it, {
    onInspect: () => {
      inspected.add(it.key);
      openDesignSheet(catalog, it, { actions: false, onSignal: (s) => s === 'dwell' && signal(it, 'dwell', { via: 'inspect' }) });
    },
    onReal: () => openRealSheet(catalog, ctx, it),
  });

  async function onSwipe(it, dir, { viewedMs }) {
    let sig = { like: 'like', nope: 'nope', super: 'order' }[dir];
    if (sig === 'order' && !(await placeOrder(catalog, u, { ...it, track: 'lofi' }, { cohortId: getProfile().cohortId }))) sig = 'like';
    // weak signal: lingered on it (or opened it in 3D) but didn't buy
    if (sig !== 'order' && (viewedMs >= DWELL_MS || inspected.has(it.key))) signal(it, 'dwell', { viewedMs });
    signal(it, sig);
    reviewed++; label();
    if (sig !== 'nope') maybeEscalate(it);
    if (++sinceCohort >= RECLUSTER_EVERY) {
      sinceCohort = 0;
      setProfile(await assignCohort(catalog, u, getProfile()));
    }
  }

  const deck = new Deck(el, { render, need: () => engine.batch(), minQueue: 3, onSwipe, emptyHtml: '<p class="muted">No more designs right now.</p>' });
  deck.refill();
  return deck;
}
