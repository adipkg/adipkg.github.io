// Shared page chrome, icons, and the garment card / 3D inspector used by every deck.
import { snapshot, openInspector } from './garment.js';
import { escapeHtml } from './swipe.js';
import { optionLabel, describeSpec } from './taste.js';
import { DB } from './db.js';

export { escapeHtml };

const PAGES = [['swipe.html', 'Swipe'], ['foryou.html', 'For you'], ['profile.html', 'Profile'], ['dashboard.html', 'Dashboard']];

const PATHS = {
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/>',
  bag: '<path d="M5 8h14l-1.2 12.5H6.2L5 8z"/><path d="M9 10V6.5a3 3 0 0 1 6 0V10"/>',
  rotate: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4v5h-5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
};
export const icon = (name, { fill = false, size } = {}) =>
  `<svg class="i" viewBox="0 0 24 24" ${size ? `style="width:${size}px;height:${size}px"` : ''} fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;

export const brandHtml = '<span class="wordmark">SHEIN</span><span class="sub">co·create</span>';

export function chrome(active) {
  if (!document.querySelector('link[rel=icon]')) {
    document.head.insertAdjacentHTML('beforeend', `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#111"/><text x="16" y="22.5" font-family="Arial,Helvetica,sans-serif" font-weight="800" font-size="18" fill="#fff" text-anchor="middle">S</text></svg>')}">`);
  }
  const top = document.querySelector('.topbar');
  if (top) {
    top.innerHTML = `<a class="brand" href="index.html" aria-label="SHEIN co-create home">${brandHtml}</a>
      <nav class="nav" aria-label="Main">${PAGES.map(([h, l]) => `<a href="${h}" class="${h === active ? 'active' : ''}" ${h === active ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>`;
  }
  const foot = document.querySelector('.footer');
  if (foot) foot.innerHTML = `MAIB7003 student concept prototype · not affiliated with or endorsed by SHEIN<br>Data: ${DB.mode === 'firebase' ? 'shared (Firebase)' : 'this browser only'}`;
}

export function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2700);
}

// The visual card for any garment spec. `extra` is HTML added under the chips (badges etc).
export function garmentCard(catalog, spec, { title, subtitle, extra = '', badge = '', onInspect, onReal } = {}) {
  const frag = document.createDocumentFragment();
  const art = document.createElement('div');
  art.className = 'art';
  art.innerHTML = `<img alt="${escapeHtml(describeSpec(catalog, spec))}" src="${snapshot(catalog, spec)}">
    ${badge ? `<div class="badge">${badge}</div>` : ''}
    <div class="corner">${onReal ? `<button class="icon-btn" data-real title="See it for real" aria-label="See it for real">${icon('spark')}</button>` : ''}
      <button class="icon-btn" data-inspect title="Inspect in 3D" aria-label="Inspect in 3D">${icon('rotate')}</button></div>`;
  art.querySelector('[data-inspect]').addEventListener('click', () => (onInspect ? onInspect() : inspect(catalog, spec)));
  art.querySelector('[data-real]')?.addEventListener('click', onReal);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<h3>${escapeHtml(title || describeSpec(catalog, spec))}</h3>
    ${subtitle ? `<p class="sub">${escapeHtml(subtitle)}</p>` : ''}
    <p class="attrs">${['block', 'fabric', 'colour', 'print', 'fit'].map((g) => escapeHtml(optionLabel(catalog, g, spec[g]))).join('<i>·</i>')}</p>
    ${extra}`;
  frag.append(art, meta);
  return frag;
}

// 3D inspector sheet. opts.onMount(dlg) wires extra buttons; opts.onClose(msOpen) reports how long it was viewed.
export function inspect(catalog, spec, bodyHtml = '', { onMount, onClose } = {}) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<div class="inspector-stage"></div>
    <div class="sheet-body"><span class="eyebrow">Drag to rotate · scroll to zoom</span><h2>${escapeHtml(describeSpec(catalog, spec))}</h2>${bodyHtml}
    <button class="btn ghost block" value="close" style="margin-top:12px">Close</button></div>`;
  document.body.append(dlg);
  dlg.showModal();
  const opened = Date.now();
  const stop = openInspector(dlg.querySelector('.inspector-stage'), catalog, spec);
  dlg.querySelector('button[value=close]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { stop(); dlg.remove(); onClose?.(Date.now() - opened); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  onMount?.(dlg);
  return dlg;
}
