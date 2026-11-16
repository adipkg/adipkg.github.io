// Shared design presentation for the swipe deck and the "For you" gallery:
// the swipe card, the detail sheet (3D + why + guardrails + actions) and the "See it for real" sheet.
import { garmentCard, inspect, toast, escapeHtml, icon } from './ui.js';
import { guardrailSummary } from './guardrails.js';
import { GROUPS, optionLabel, describeSpec } from './taste.js';
import { APPEAL } from './engine.js';
import { MODELS, DEFAULT_MODEL, renderForReal, getPhoto, quotaLeft, DAILY_CAP } from './hifi.js';

const pct = (x) => `${Math.round(x * 100)}%`;
export const SLOT_BADGE = { cohort: 'Bought by your cohort', trend: 'Trending', discovery: 'New for you', neighbour: 'A twist' };
export const DWELL_MS = 4000;

export function designCard(catalog, it, { onInspect, onReal } = {}) {
  const g = it.guard;
  const sub = [it.reason, it.appeal != null && it.slot !== 'cohort' ? APPEAL[Math.round(it.appeal)]?.toLowerCase() : null].filter(Boolean).join(' · ');
  return garmentCard(catalog, it.spec, {
    title: describeSpec(catalog, it.spec),
    subtitle: sub,
    badge: SLOT_BADGE[it.slot] ? `<span class="pill accent">${SLOT_BADGE[it.slot]}</span>` : '',
    extra: `<div class="chips">${guardrailSummary(g)}${it.conf ? `<span class="pill" title="Mean Jev probability across the five design choices">Jev ${pct(Object.values(it.conf).reduce((a, b) => a + b, 0) / 5)} confident</span>` : ''}</div>
      <p class="foot"><span>Made for you in ${g.cost.turnaroundDays} days</span><span>$${g.cost.singleUnitCost.toFixed(2)} · SUCP ${g.cost.sucpPct}%</span></p>`,
    onInspect, onReal,
  });
}

export function detailHtml(catalog, it) {
  const rows = GROUPS.map((gr) => `<span class="k">${gr}</span><span>${escapeHtml(optionLabel(catalog, gr, it.spec[gr]))}</span>
    ${it.conf ? `<span class="conf" title="Jev probability ${pct(it.conf[gr])}"><i style="width:${pct(it.conf[gr])}"></i></span>` : '<span></span>'}`).join('');
  const checks = Object.values(it.guard.checks).map((c) => `<span class="k">${c.label}</span><span>${escapeHtml(c.detail)}</span><span>${c.pass === false ? '✕' : '✓'}</span>`).join('');
  return `${it.reason ? `<p class="muted small" style="margin:-4px 0 10px">${escapeHtml(it.reason)}</p>` : ''}
    <h3 style="margin-top:12px">Design decisions${it.conf ? ' · Jev probability' : ''}</h3><div class="kv">${rows}</div>
    <h3 style="margin-top:16px">Guardrails</h3><div class="kv">${checks}</div>
    <p class="small muted" style="margin-top:10px">Batch unit cost $${it.guard.cost.batchUnitCost} · single unit $${it.guard.cost.singleUnitCost} · ${escapeHtml(catalog.fabrics[it.spec.fabric].hub)}</p>`;
}

// Detail sheet with actions. handlers: { onSignal(signal), onOrder(), onReal() }. Long views report a dwell signal.
export function openDesignSheet(catalog, it, { onSignal, onOrder, onReal, actions = true } = {}) {
  let acted = false;
  const actionHtml = actions ? `<div class="row" style="margin-top:16px">
      <button class="btn ghost sm" data-a="nope">${icon('x')} Pass</button>
      <button class="btn ghost sm" data-a="like">${icon('heart')} Like</button>
      <button class="btn primary sm" data-a="order">${icon('bag')} Order one-off</button>
      <button class="btn sm" data-a="real">${icon('spark')} See it for real</button></div>` : '';
  inspect(catalog, it.spec, detailHtml(catalog, it) + actionHtml, {
    onMount: (dlg) => dlg.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.a;
      if (a === 'real') { dlg.close(); onReal?.(); return; }
      acted = true; dlg.close();
      if (a === 'order') onOrder?.(); else onSignal?.(a);
    })),
    onClose: (ms) => { if (!acted && ms >= DWELL_MS) onSignal?.('dwell'); },
  });
}

// "See it for real": on a model (shared, cached) or on me (private, on-device photo).
export function openRealSheet(catalog, { u, user, inventory }, it) {
  const hasPhoto = !!getPhoto(u);
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<div class="sheet-body">
    <span class="eyebrow">See it for real</span><h2>${escapeHtml(describeSpec(catalog, it.spec))}</h2>
    <div class="choice-grid" style="grid-template-columns:1fr 1fr;margin:12px 0" data-modes>
      <button class="choice selected" data-mode="model"><strong>On a model</strong><span class="muted small">Studio shot, body types rotate, face cropped</span></button>
      <button class="choice" data-mode="me" ${hasPhoto ? '' : 'disabled style="opacity:.45"'}><strong>On me</strong><span class="muted small">${hasPhoto ? 'Uses your photo. Stays on this device' : 'Add a photo in your profile'}</span></button>
    </div>
    <label class="small muted">Image model <select data-model>${Object.entries(MODELS).map(([id, m]) => `<option value="${id}" ${m.enabled ? '' : 'disabled'} ${id === DEFAULT_MODEL ? 'selected' : ''}>${m.label}${m.enabled ? '' : ' (pending docs)'}</option>`).join('')}</select></label>
    <p class="small muted" data-quota style="margin:8px 0"></p>
    <div data-out style="display:none;margin:10px 0"><img alt="" style="width:100%;border-radius:14px;display:block;background:var(--wash)"></div>
    <p class="small muted" data-step aria-live="polite"></p>
    <div class="row"><button class="btn primary" data-go>${icon('spark')} Render</button><button class="btn ghost" value="close">Close</button></div>
  </div>`;
  document.body.append(dlg);
  dlg.showModal();
  let mode = 'model';
  const $ = (s) => dlg.querySelector(s);
  quotaLeft(u).then((n) => ($('[data-quota]').textContent = `${Math.max(0, n)} of ${DAILY_CAP} renders left today. Re-opening a design someone already rendered on a model is free.`));
  $('[data-modes]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]'); if (!b || b.disabled) return;
    mode = b.dataset.mode;
    dlg.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('selected', x === b));
  });
  $('[value=close]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  $('[data-go]').addEventListener('click', async () => {
    const go = $('[data-go]'); go.disabled = true;
    try {
      const r = await renderForReal(catalog, { u, user, spec: it.spec, mode, model: $('[data-model]').value, inventory, onStep: (s) => ($('[data-step]').textContent = s) });
      $('[data-out]').style.display = 'block';
      $('[data-out] img').src = r.src;
      $('[data-step]').textContent = r.private ? 'Saved privately on this device (see Profile → My looks).'
        : r.cached ? 'Already rendered for another shopper, so this one was free.'
        : r.blocked ? `Blocked by guardrails (${r.doc.failed.join(', ')}). Kept for audit only.`
        : `Rendered in ${(r.latencyMs / 1000).toFixed(1)}s. It joins the shared gallery after human review.`;
    } catch (e) {
      $('[data-step]').innerHTML = `<span class="err">${escapeHtml(e.message)}</span>`;
    } finally { go.disabled = false; quotaLeft(u).then((n) => ($('[data-quota]').textContent = `${Math.max(0, n)} of ${DAILY_CAP} renders left today.`)); }
  });
}

export { toast };
