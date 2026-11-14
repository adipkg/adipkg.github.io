// Team dashboard: collective trends, cohorts, AI performance, review queue. Everything updates live.
import { chrome, toast, escapeHtml } from './ui.js';
import { DB } from './db.js';
import { loadCatalog, GROUPS, options, optionLabel, attrKey } from './taste.js';
import { clusterProfiles, describeCentroid } from './cohorts.js';
import { geminiText } from './api.js';
import { MODELS, imageFor } from './hifi.js';
import { seedSynthetic, clearSynthetic } from './seed.js';

chrome('dashboard.html');
const catalog = await loadCatalog();
const $ = (s) => document.querySelector(s);
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–');
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
// Monochrome: cohorts differ by shade AND point shape so they stay distinguishable without colour.
const PALETTE = ['#111111', '#5c5c5c', '#9a9a9a', '#111111', '#5c5c5c', '#9a9a9a'];
const SHAPES = ['circle', 'triangle', 'rect', 'rectRot', 'crossRot', 'star'];
const INK = '#111111', MID = '#7a7a7a', LIGHT = '#c9c9c9';

Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
Chart.defaults.animation = false;
Chart.defaults.maintainAspectRatio = false;
Chart.defaults.plugins.legend.labels.boxWidth = 10;
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.font.size = 11;
const charts = {};
function chart(id, config) {
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--line');
  charts[id]?.destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}

// ---------- live state ----------
const S = { users: {}, swipes: {}, live: {}, inventory: null, escalations: {}, profiles: [], designs: [], orders: [] };
let timer;
const schedule = () => { clearTimeout(timer); timer = setTimeout(render, 250); };
DB.rt.on('users', (v) => { S.users = v || {}; schedule(); });
DB.rt.on('swipes', (v) => { S.swipes = v || {}; schedule(); });
DB.rt.on('live', (v) => { S.live = v || {}; schedule(); });
DB.rt.on('inventory', (v) => { S.inventory = v; schedule(); });
DB.rt.on('escalations', (v) => { S.escalations = v || {}; schedule(); });
DB.fs.watch('profiles', {}, (r) => { S.profiles = r; schedule(); });
DB.fs.watch('designs', {}, (r) => { S.designs = r; schedule(); });
DB.fs.watch('orders', {}, (r) => { S.orders = r; schedule(); });

let trendGroup = 'block';
let cohortResult = null;

function allSwipes() {
  return Object.entries(S.swipes).flatMap(([u, m]) => Object.values(m || {}).map((s) => ({ ...s, u })));
}

function render() {
  const swipes = allSwipes();
  renderKpis(swipes);
  renderTrend();
  renderActivity(swipes);
  renderCohorts();
  renderSegments(swipes);
  renderCalibration(swipes);
  renderGuardrails();
  renderModels();
  renderQueue();
  renderEscalations();
  renderOrders();
  renderUsers();
  $('#updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
}

function renderKpis(swipes) {
  const t = S.live.totals || {};
  const likes = (t.likes || 0) + (t.orders || 0), total = likes + (t.nopes || 0);
  const g = S.live.guardrails || {};
  const blocked = (g.cost || 0) + (g.stock || 0) + (g.ip || 0) + (g.block || 0);
  const tiles = [
    ['Shoppers', Object.keys(S.users).length],
    ['Swipes', total],
    ['Like rate', pct(likes / total)],
    ['Orders', S.orders.length],
    ['Designs generated', S.designs.filter((d) => d.spec && d.track).length],
    ['Blocked by guardrails', blocked],
    ['LATR escalations', Object.keys(S.escalations).length],
    ['Awaiting review', S.designs.filter((d) => d.status === 'pending').length],
  ];
  $('#kpis').innerHTML = tiles.map(([k, v]) => `<div class="kpi"><b>${v}</b><span>${k}</span></div>`).join('');
}

function renderTrend() {
  $('#trend-tabs').innerHTML = GROUPS.map((g) => `<button class="${g === trendGroup ? 'on' : ''}" data-g="${g}">${g}</button>`).join('');
  const attr = S.live.attr || {};
  const rows = options(catalog, trendGroup).map((o) => {
    const c = attr[attrKey(trendGroup, o)] || {};
    return { label: optionLabel(catalog, trendGroup, o), likes: c.likes || 0, orders: c.orders || 0, nopes: c.nopes || 0,
      score: (c.likes || 0) + 2 * (c.orders || 0) - 0.5 * (c.nopes || 0) };
  }).sort((a, b) => b.score - a.score);
  chart('trend', {
    type: 'bar',
    data: { labels: rows.map((r) => r.label), datasets: [
      { label: 'Likes', data: rows.map((r) => r.likes), backgroundColor: INK },
      { label: 'Orders', data: rows.map((r) => r.orders), backgroundColor: MID },
      { label: 'Nopes', data: rows.map((r) => -r.nopes), backgroundColor: LIGHT },
    ] },
    options: { indexAxis: 'y', scales: { x: { stacked: true }, y: { stacked: true } } },
  });
}
$('#trend-tabs').addEventListener('click', (e) => { const g = e.target.dataset.g; if (g) { trendGroup = g; renderTrend(); } });

function renderActivity(swipes) {
  if (!swipes.length) return;
  const B = 10 * 60e3;
  const end = Math.ceil(Date.now() / B) * B;
  const start = Math.max(Math.min(...swipes.map((s) => s.ts)), end - 36 * B);
  const n = Math.max(1, Math.ceil((end - start) / B));
  const bucket = (dir) => { const a = new Array(n).fill(0); swipes.forEach((s) => { const i = Math.floor((s.ts - start) / B); if (i >= 0 && i < n && dir(s.dir)) a[i]++; }); return a; };
  const labels = Array.from({ length: n }, (_, i) => new Date(start + i * B).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  chart('activity', {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Likes + orders', data: bucket((d) => d !== 'nope'), borderColor: INK, backgroundColor: 'rgba(17,17,17,.08)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 },
      { label: 'Nopes', data: bucket((d) => d === 'nope'), borderColor: MID, borderDash: [5, 4], tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
    ] },
    options: { scales: { x: { ticks: { maxTicksLimit: 6 } }, y: { beginAtZero: true } } },
  });
}

function eligibleProfiles() {
  return S.profiles.filter((p) => (p.swipeCount || 0) >= 5 && S.users[p.id]?.consent?.cohort !== false && p.weights && Object.keys(p.weights).length);
}

function renderCohorts() {
  const profs = eligibleProfiles();
  const k = Number($('#k').value);
  if (profs.length < k + 1) {
    $('#cohort-table').innerHTML = `<p class="muted small">Need at least ${k + 1} eligible shoppers (have ${profs.length}).</p>`;
    charts.cohorts?.destroy(); cohortResult = null; return;
  }
  const r = clusterProfiles(catalog, profs, k);
  const saved = Object.fromEntries(profs.map((p) => [p.id, p.cohortLabel]));
  cohortResult = { ...r, profs, cohorts: r.centroids.map((c, i) => ({
    id: i, size: r.assign.filter((a) => a === i).length, ...describeCentroid(catalog, c),
    label: mostCommon(profs.filter((_, j) => r.assign[j] === i).map((p) => saved[p.id]).filter(Boolean)),
    segments: segMix(profs.filter((_, j) => r.assign[j] === i)),
  })) };
  const name = (c) => c.label || c.top.slice(0, 2).join(' · ');
  chart('cohorts', {
    type: 'scatter',
    data: { datasets: cohortResult.cohorts.map((c, i) => ({
      label: `${name(c)} (${c.size})`, backgroundColor: i < 3 ? PALETTE[i] : 'rgba(255,255,255,.9)', borderColor: PALETTE[i % PALETTE.length], borderWidth: 1.5,
      pointStyle: SHAPES[i % SHAPES.length], pointRadius: 7, pointHoverRadius: 9,
      data: r.xy.map(([x, y], j) => ({ x, y, u: profs[j].id })).filter((_, j) => r.assign[j] === i),
    })) },
    options: {
      scales: { x: { title: { display: true, text: 'PC1' }, ticks: { display: false } }, y: { title: { display: true, text: 'PC2' }, ticks: { display: false } } },
      plugins: { tooltip: { callbacks: { label: (ctx) => ctx.raw.u } } },
      onClick: (_, els) => { const e = els[0]; if (e) location.href = `profile.html?u=${encodeURIComponent(charts.cohorts.data.datasets[e.datasetIndex].data[e.index].u)}`; },
    },
  });
  $('#cohort-table').innerHTML = `<table><tr><th></th><th>Cohort</th><th>Size</th><th>Signature</th></tr>${cohortResult.cohorts.map((c, i) => `<tr>
    <td>${shapeSvg(i)}</td>
    <td><strong>${escapeHtml(name(c))}</strong><br><span class="muted small">${c.segments}</span></td><td>${c.size}</td>
    <td class="small">${escapeHtml(Object.values(c.perGroup).join(', '))}</td></tr>`).join('')}</table>`;
}
$('#k').onchange = renderCohorts;
const shapeSvg = (i) => {
  const c = PALETTE[i % PALETTE.length], f = i < 3 ? c : 'none';
  const shape = ['<circle cx="7" cy="7" r="5"/>', '<path d="M7 2l5.5 10h-11z"/>', '<rect x="2.5" y="2.5" width="9" height="9"/>',
    '<path d="M7 1.5L12.5 7 7 12.5 1.5 7z"/>', '<path d="M3 3l8 8M11 3l-8 8"/>', '<path d="M7 1.5l1.7 3.6 3.8.4-2.9 2.6.9 3.8L7 10l-3.5 1.9.9-3.8L1.5 5.5l3.8-.4z"/>'][i % 6];
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="${f}" stroke="${c}" stroke-width="1.5">${shape}</svg>`;
};
const mostCommon = (a) => { const m = {}; a.forEach((x) => (m[x] = (m[x] || 0) + 1)); return Object.entries(m).sort((x, y) => y[1] - x[1])[0]?.[0] || null; };
const segMix = (profs) => { const p = profs.filter((x) => S.users[x.id]?.segment === 'power').length; return `${p} power · ${profs.length - p} dormant`; };

$('#name-cohorts').onclick = async () => {
  if (!cohortResult) return toast('Not enough shoppers to cluster yet');
  const btn = $('#name-cohorts'); btn.disabled = true; btn.textContent = 'Asking Gemini…';
  try {
    const brief = cohortResult.cohorts.map((c) => ({ id: c.id, size: c.size, signature: c.perGroup }));
    const { text } = await geminiText([{ text: `You name fashion style cohorts for a trend dashboard. For each cohort, give a catchy 1–3 word aesthetic name (e.g. "Cyber-Y2K", "Quiet Luxury", "Coastal Minimal"). Names must be distinct. Return JSON: {"<id>": "<name>"}.\n${JSON.stringify(brief)}` }], { json: true, temperature: 0.7 });
    const names = JSON.parse(text.replace(/^```json|```$/g, '').trim());
    const snapshotId = `snap-${Date.now()}`;
    await DB.fs.set('cohorts', snapshotId, { createdAt: Date.now(), k: cohortResult.cohorts.length, cohorts: cohortResult.cohorts.map((c) => ({ id: c.id, size: c.size, label: names[c.id] || null, signature: c.perGroup })) }, false);
    await Promise.all(cohortResult.profs.map((p, j) => DB.fs.set('profiles', p.id, { cohortId: `${snapshotId}:${cohortResult.assign[j]}`, cohortLabel: names[cohortResult.assign[j]] || null })));
    toast('Cohorts named and saved to shopper profiles');
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = 'Name with Gemini & save'; }
};

function renderSegments(swipes) {
  const segs = ['power', 'dormant'];
  const stat = (seg) => {
    const users = Object.keys(S.users).filter((u) => S.users[u]?.segment === seg);
    const sw = swipes.filter((s) => S.users[s.u]?.segment === seg);
    const ord = S.orders.filter((o) => S.users[o.username]?.segment === seg).length;
    return { n: users.length, likeRate: sw.length ? sw.filter((s) => s.dir !== 'nope').length / sw.length : 0,
      swipesPer: users.length ? sw.length / users.length : 0, ordersPer: users.length ? ord / users.length : 0 };
  };
  const st = segs.map(stat);
  chart('segments', {
    type: 'bar',
    data: { labels: ['Like rate (%)', 'Swipes per shopper', 'Orders per shopper ×10'], datasets: segs.map((s, i) => ({
      label: `${s} (${st[i].n})`, backgroundColor: i ? LIGHT : INK,
      data: [st[i].likeRate * 100, st[i].swipesPer, st[i].ordersPer * 10].map((x) => +x.toFixed(1)),
    })) },
  });
}

function renderCalibration(swipes) {
  const lo = swipes.filter((s) => s.track === 'lofi' && s.appeal != null);
  const bins = [0, 1, 2, 3].map((b) => lo.filter((s) => Math.min(3, Math.round(s.appeal)) === b));
  chart('calib', {
    type: 'bar',
    data: { labels: ['Unlikely', 'Might', 'Likely', 'Will love'], datasets: [{
      label: 'Actual like rate (%)', backgroundColor: INK,
      data: bins.map((b) => (b.length >= 5 ? +(100 * b.filter((s) => s.dir !== 'nope').length / b.length).toFixed(1) : null)), // hide thin bins
    }] },
    options: { scales: { y: { beginAtZero: true, max: 100 } }, plugins: { tooltip: { callbacks: { afterLabel: (c) => `n = ${bins[c.dataIndex].length}` } } } },
  });
}

function renderGuardrails() {
  const g = S.live.guardrails || {};
  $('#guard').innerHTML = [['Evaluated', g.evaluated || 0], ['Cost / speed', g.cost || 0], ['Out of stock', g.stock || 0], ['IP risk', g.ip || 0], ['Fabric re-mapped', g.fabricRemapped || 0]]
    .map(([k, v]) => `<div class="kpi"><b>${v}</b><span>${k}</span></div>`).join('');
  const inv = S.inventory || catalog.inventoryMeters;
  const fabrics = Object.keys(catalog.inventoryMeters);
  chart('inventory', {
    type: 'bar',
    data: { labels: fabrics.map((f) => catalog.fabrics[f].label), datasets: [
      { label: 'In stock (m)', data: fabrics.map((f) => inv[f] ?? 0), backgroundColor: INK },
      { label: 'Used (m)', data: fabrics.map((f) => +(catalog.inventoryMeters[f] - (inv[f] ?? 0)).toFixed(1)), backgroundColor: LIGHT },
    ] },
    options: { scales: { x: { stacked: true, ticks: { autoSkip: false, maxRotation: 60 } }, y: { stacked: true } } },
  });
}

function renderModels() {
  const hifi = S.designs.filter((d) => d.track === 'hifi');
  const live = S.live.models || {};
  const rows = Object.entries(MODELS).map(([id, m]) => {
    const ds = hifi.filter((d) => d.model === id);
    const l = live[id] || {};
    const avg = (f) => (ds.length ? ds.reduce((s, d) => s + (f(d) || 0), 0) / ds.length : NaN);
    const likes = (l.likes || 0) + (l.orders || 0), n = likes + (l.nopes || 0);
    return `<tr><td><strong>${m.label}</strong><br><span class="muted small">${m.enabled ? id : m.note}</span></td><td>${ds.length}</td>
      <td>${ds.filter((d) => d.status === 'blocked').length}</td><td>${Number.isFinite(avg((d) => d.latencyMs)) ? (avg((d) => d.latencyMs) / 1000).toFixed(1) + 's' : '–'}</td>
      <td>${pct(avg((d) => d.jev?.specMatch))}</td><td>${n ? `${pct(likes / n)} <span class="muted small">(${n})</span>` : '–'}</td></tr>`;
  });
  $('#models').innerHTML = `<table><tr><th>Model</th><th>Made</th><th>Blocked</th><th>Latency</th><th>Spec match</th><th>Like rate</th></tr>${rows.join('')}</table>`;
  const bodies = {};
  hifi.filter((d) => d.bodyType).forEach((d) => { const b = d.bodyType.split(',')[0]; bodies[b] = (bodies[b] || 0) + 1; });
  $('#bodies').innerHTML = Object.keys(bodies).length ? Object.entries(bodies).map(([b, n]) => `<span class="pill">${escapeHtml(b)} · ${n}</span>`).join('') : '<span class="muted small">No on-model images yet.</span>';
}

let queueKey = null;
function renderQueue() {
  const items = S.designs.filter((d) => d.track === 'hifi' && (d.status === 'pending' || d.status === 'blocked')).sort((a, b) => b.createdAt - a.createdAt).slice(0, 24);
  const key = items.map((d) => d.id + d.status).join();
  if (key === queueKey) return; // avoid reloading images on every live tick
  queueKey = key;
  if (!items.length) { $('#queue').innerHTML = '<p class="muted small">Nothing waiting for review.</p>'; return; }
  $('#queue').innerHTML = items.map((d) => `<div class="qcard" data-id="${escapeHtml(d.id)}"><img alt="" data-img="${escapeHtml(d.imageId)}"><div>
    <strong>${escapeHtml(d.name)}</strong><br><span class="muted">${MODELS[d.model]?.label || d.model} · by ${escapeHtml(d.createdBy)}</span><br>
    <span class="muted">IP risk ${pct(d.jev?.ipRisk)} · spec match ${pct(d.jev?.specMatch)}</span><br>
    ${d.status === 'blocked' ? `<span class="pill bad">blocked: ${escapeHtml((d.failed || []).join(', '))}</span>` : ''}
    <div class="row" style="padding:8px 0 0"><button class="btn sm primary" data-act="approved">Approve</button>
    <button class="btn sm ghost" data-act="rejected">Reject</button></div></div></div>`).join('');
  $('#queue').querySelectorAll('img[data-img]').forEach(async (img) => (img.src = await imageFor(img.dataset.img)));
}
$('#queue').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.closest('.qcard').dataset.id;
  await DB.fs.set('designs', id, { status: b.dataset.act, reviewedAt: Date.now(), reviewer: 'team' });
  toast(b.dataset.act === 'approved' ? 'Approved: now in the shared library' : 'Rejected');
});

function renderEscalations() {
  const es = Object.values(S.escalations).sort((a, b) => b.triggeredAt - a.triggeredAt);
  $('#escalations').innerHTML = es.length ? `<table><tr><th>Design</th><th>Likes</th><th>Orders</th><th>Batch</th><th>Status</th></tr>${es.map((e) => `<tr>
    <td>${escapeHtml(GROUPS.map((g) => optionLabel(catalog, g, e.spec[g])).join(' · '))}</td><td>${e.likes}</td><td>${e.orders}</td><td>${e.batchSize}</td><td><span class="pill accent">${escapeHtml(e.status)}</span></td></tr>`).join('')}</table>`
    : '<p class="muted small">No design has crossed the threshold yet.</p>';
}

function renderOrders() {
  const os = [...S.orders].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
  $('#orders').innerHTML = os.length ? `<table><tr><th>Order</th><th>Design</th><th>Hub</th><th>Unit cost</th><th>SUCP</th></tr>${os.map((o) => `<tr>
    <td class="small">${escapeHtml(o.workOrder?.orderNo || '–')}<br><span class="muted">${escapeHtml(o.username)}</span></td><td class="small">${escapeHtml(GROUPS.map((g) => optionLabel(catalog, g, o.spec[g])).join(' · '))}</td>
    <td class="small">${escapeHtml(o.workOrder?.supplierHub || '')}</td><td>${o.workOrder?.unitCost ? '$' + o.workOrder.unitCost.toFixed(2) : '–'}</td><td>${o.workOrder?.sucpPct != null ? o.workOrder.sucpPct + '%' : '–'}</td></tr>`).join('')}</table>`
    : '<p class="muted small">No orders yet.</p>';
}

function renderUsers() {
  const profs = Object.fromEntries(S.profiles.map((p) => [p.id, p]));
  const rows = Object.entries(S.users).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0)).slice(0, 60);
  $('#users').innerHTML = `<table><tr><th>Shopper</th><th>Segment</th><th>Onboarding</th><th>Swipes</th><th>Likes</th><th>Cohort</th><th>Points</th></tr>${rows.map(([u, x]) => `<tr>
    <td><a href="profile.html?u=${encodeURIComponent(u)}">${escapeHtml(u)}</a>${x.synthetic ? ' <span class="pill">synthetic</span>' : ''}</td><td>${escapeHtml(x.segment || '–')}</td><td>${escapeHtml(x.onboarding || '–')}</td>
    <td>${profs[u]?.swipeCount || 0}</td><td>${profs[u]?.likeCount || 0}</td><td>${escapeHtml(profs[u]?.cohortLabel || '–')}</td><td>${x.rewardPoints || 0}</td></tr>`).join('')}</table>`;
}

$('#seed').onclick = async () => { $('#seed').disabled = true; await seedSynthetic(catalog, 24); $('#seed').disabled = false; toast('Added 24 synthetic shoppers'); };
$('#unseed').onclick = async () => { const n = await clearSynthetic(); toast(`Removed ${n} synthetic shoppers`); };
render();
