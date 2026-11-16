// Single-unit orders → supplier work orders, and cohort-trend escalation to LATR micro-batches (Stream 2, task B4).
import { DB, rtKey } from './db.js';
import { describeSpec, trendScore } from './taste.js';
import { toast } from './ui.js';
import { publishToPool } from './cohorts.js';
import { cohortConsent } from './store.js';

export const ESCALATE_AT = 8; // trend score (likes + 4 × orders …), summed across all shoppers
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// it = { key, spec, guard: { cost }, track, model?, ipRisk? }; opts.cohortId shares the purchase with that cohort
export async function placeOrder(catalog, u, it, { cohortId } = {}) {
  const { cost } = it.guard;
  const F = catalog.fabrics[it.spec.fabric];
  const stock = await DB.rt.txn(`inventory/${it.spec.fabric}`, (cur) => {
    const have = cur ?? catalog.inventoryMeters[it.spec.fabric];
    return have >= cost.meters ? +(have - cost.meters).toFixed(1) : undefined;
  });
  if (!stock.committed) { toast(`Out of ${F.label.toLowerCase()}, so we couldn't place the order`); return false; }
  await DB.fs.add('orders', {
    username: u, designKey: it.key, name: cap(describeSpec(catalog, it.spec)), spec: it.spec, track: it.track || 'lofi',
    model: it.model || null, createdAt: Date.now(), status: 'queued',
    workOrder: {
      orderNo: `WO-${Date.now().toString(36).toUpperCase()}`, trigger: 'single-unit', patternBlock: it.spec.block,
      fabricType: it.spec.fabric, fabricSku: F.sku, meters: cost.meters, colour: it.spec.colour, colourHex: catalog.colours[it.spec.colour].hex,
      print: it.spec.print, fit: it.spec.fit, supplierHub: F.hub, cuttingFile: `cut/${it.key}.dxf`,
      unitCost: cost.singleUnitCost, batchUnitCost: cost.batchUnitCost, sucpPct: cost.sucpPct, turnaroundDays: cost.turnaroundDays,
    },
  });
  await DB.rt.txn(`users/${u}/rewardPoints`, (p) => (p || 0) + 50);
  // a purchase is shared with the buyer's style cohort immediately (unless they opted out)
  if (cohortId && cohortConsent(u)) await publishToPool(cohortId, u, it);
  toast(`Ordered! Single-unit work order sent to ${F.hub}${cohortId && cohortConsent(u) ? ', and shared with your style cohort' : ''}`);
  return true;
}

export async function maybeEscalate(it) {
  const c = (await DB.rt.get(`live/designs/${rtKey(it.key)}`)) || {};
  const score = Math.round(trendScore(c));
  if (score < ESCALATE_AT) return false;
  const r = await DB.rt.txn(`escalations/${rtKey(it.key)}`, (cur) => (cur ? undefined : {
    spec: it.spec, key: it.key, triggeredAt: Date.now(), likes: c.likes || 0, orders: c.orders || 0, score,
    ipRisk: it.ipRisk ?? null, batchSize: Math.min(200, 100 + 10 * (score - ESCALATE_AT)), status: 'LATR micro-batch queued',
  }));
  if (r.committed) {
    await DB.fs.set('designs', it.key, { status: 'escalated', escalatedAt: Date.now() });
    toast('This design is trending: queued for an LATR micro-batch');
  }
  return r.committed;
}
