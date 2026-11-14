// The four-tier manufacturability guardrail engine (Stream 2, task B3).
//  1. Pattern block   – the design must use a verified master block, with a fabric that block supports
//  2. Fabric stock    – enough metres of that fabric in the supplier hubs right now
//  3. Cost & speed    – single-unit cost premium (SUCP) ≤ 18% and turnaround ≤ 7 days
//  4. IP screening    – Jev's probability that the design copies protected IP stays under the limit
export function costOf(catalog, spec) {
  const B = catalog.blocks[spec.block], F = catalog.fabrics[spec.fabric], P = catalog.prints[spec.print];
  const fabricCost = F.costPerM * B.meters;
  const batch = B.labour + fabricCost + P.cost + B.trims;                     // per unit in a 100–200 micro-batch
  const single = B.labour * (1 + B.setupPremium) + fabricCost * 1.08          // set-up + cutting waste
    + P.cost * P.singleFactor + B.trims;                                      // print set-up for one piece
  return {
    batchUnitCost: +batch.toFixed(2),
    singleUnitCost: +single.toFixed(2),
    sucpPct: +(((single - batch) / batch) * 100).toFixed(1),
    turnaroundDays: B.days + P.days,
    meters: B.meters,
  };
}

export function checkSpec(catalog, spec, { inventory = {}, ipRisk = null } = {}) {
  const L = catalog.limits;
  const B = catalog.blocks[spec.block];
  const cost = costOf(catalog, spec);
  const stock = inventory[spec.fabric] ?? catalog.inventoryMeters[spec.fabric] ?? 0;
  const checks = {
    block: { pass: !!B && B.fabrics.includes(spec.fabric), label: 'Pattern block', detail: B ? `${B.label} master block` : 'unknown block' },
    stock: { pass: stock >= cost.meters, label: 'Fabric stock', detail: `${Math.round(stock)} m ${catalog.fabrics[spec.fabric].label.toLowerCase()} in stock` },
    cost: {
      pass: cost.sucpPct <= L.maxSucpPct && cost.turnaroundDays <= L.maxTurnaroundDays, label: 'Cost & speed',
      detail: `SUCP ${cost.sucpPct}% (≤${L.maxSucpPct}%) · ${cost.turnaroundDays} days (≤${L.maxTurnaroundDays})`,
    },
    ip: { pass: ipRisk == null ? null : ipRisk <= L.maxIpRisk, label: 'IP screen', detail: ipRisk == null ? 'pending' : `risk ${(ipRisk * 100).toFixed(0)}% (≤${L.maxIpRisk * 100}%)` },
  };
  const failed = Object.entries(checks).filter(([, c]) => c.pass === false).map(([k]) => k);
  return { checks, cost, pass: failed.length === 0, failed };
}

const MARK = { ok: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  bad: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' };
// Compact form for cards: one pill summarising all four checks; detail lives in the 3D inspector.
export function guardrailSummary(g) {
  const all = Object.values(g.checks);
  const failed = all.filter((c) => c.pass === false);
  const title = all.map((c) => `${c.pass === false ? '✕' : '✓'} ${c.label}: ${c.detail}`).join('\n');
  return failed.length
    ? `<span class="pill bad" title="${title}">${MARK.bad}Blocked: ${failed.map((c) => c.label.toLowerCase()).join(', ')}</span>`
    : `<span class="pill ok" title="${title}">${MARK.ok}${all.length}/${all.length} guardrails passed</span>`;
}

export const guardrailPills = (g) => Object.values(g.checks)
  .map((c) => `<span class="pill ${c.pass === false ? 'bad' : c.pass ? 'ok' : ''}" title="${c.detail}">${c.pass === false ? MARK.bad : MARK.ok}${c.label}</span>`).join('');
