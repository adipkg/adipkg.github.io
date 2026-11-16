// Team dashboard: collective trends, cohorts, AI performance, review queue. Everything updates live.
import { chrome, toast, escapeHtml } from './ui.js';
import { DB } from './db.js';
import { loadCatalog, GROUPS, options, optionLabel, attrKey, trendScore, vectorize, normalise, sourceMix, SOURCES, SOURCE_LABEL } from './taste.js';
import { pca2, unitVec, ensureCohorts } from './cohorts.js';
import { slateMix, DEFAULT_EXPLORE } from './engine.js';
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
const S = { users: {}, swipes: {}, live: {}, inventory: null, escalations: {}, profiles: [], designs: [], orders: [], cohorts: null, pool: {}, explore: DEFAULT_EXPLORE };
let timer;
const schedule = () => { clearTimeout(timer); timer = setTimeout(render, 250); };
DB.rt.on('users', (v) => { S.users = v || {}; schedule(); });
DB.rt.on('swipes', (v) => { S.swipes = v || {}; schedule(); });
DB.rt.on('live', (v) => { S.live = v || {}; schedule(); });
DB.rt.on('inventory', (v) => { S.inventory = v; schedule(); });
DB.rt.on('escalations', (v) => { S.escalations = v || {}; schedule(); });
DB.rt.on('cohorts/current', (v) => { S.cohorts = v; schedule(); });
DB.rt.on('cohortPool', (v) => { S.pool = v || {}; schedule(); });
DB.rt.on('settings/explore', (v) => { S.explore = typeof v === 'number' ? v : DEFAULT_EXPLORE; renderExploreControl(); });
DB.fs.watch('profiles', {}, (r) => { S.profiles = r; schedule(); });
DB.fs.watch('designs', {}, (r) => { S.designs = r; schedule(); });
DB.fs.watch('orders', {}, (r) => { S.orders = r; schedule(); });

let trendGroup = 'block';

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
  renderSignals();
  renderExploration(swipes);
  renderSharing();
  renderAudience();
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
    ['Shared to cohorts', S.live.pool?.published || 0],
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
      score: trendScore(c) };
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

function renderCohorts() {
  const snap = S.cohorts;
  if (!snap?.cohorts?.length) {
    $('#cohort-table').innerHTML = '<p class="muted small">No cohorts yet: they form automatically once 6+ shoppers have opted in and made 5+ signals. Add synthetic shoppers below to see them.</p>';
    charts.cohorts?.destroy(); return;
  }
  $('#k').value = String(snap.k);
  const idx = Object.fromEntries(snap.cohorts.map((c, i) => [c.id, i]));
  const profs = S.profiles.filter((p) => p.cohortId in idx && p.weights && Object.keys(p.weights).length);
  if (profs.length >= 3) {
    const xy = pca2(profs.map((p) => unitVec(vectorize(catalog, p.weights))));
    chart('cohorts', {
      type: 'scatter',
      data: { datasets: snap.cohorts.map((c, i) => ({
        label: `${c.label} (${profs.filter((p) => p.cohortId === c.id).length})`, backgroundColor: i < 3 ? PALETTE[i] : 'rgba(255,255,255,.9)', borderColor: PALETTE[i % PALETTE.length], borderWidth: 1.5,
        pointStyle: SHAPES[i % SHAPES.length], pointRadius: 7, pointHoverRadius: 9,
        data: profs.map((p, j) => ({ x: xy[j][0], y: xy[j][1], u: p.id, c: p.cohortId })).filter((d) => d.c === c.id),
      })) },
      options: {
        scales: { x: { title: { display: true, text: 'PC1' }, ticks: { display: false } }, y: { title: { display: true, text: 'PC2' }, ticks: { display: false } } },
        plugins: { tooltip: { callbacks: { label: (ctx) => ctx.raw.u } } },
        onClick: (_, els) => { const e = els[0]; if (e) location.href = `profile.html?u=${encodeURIComponent(charts.cohorts.data.datasets[e.datasetIndex].data[e.index].u)}`; },
      },
    });
  }
  $('#cohort-table').innerHTML = `<table><tr><th></th><th>Cohort</th><th>Size</th><th>Shared</th><th>Signature</th></tr>${snap.cohorts.map((c, i) => {
    const members = profs.filter((p) => p.cohortId === c.id);
    return `<tr><td>${shapeSvg(i)}</td><td><strong>${escapeHtml(c.label)}</strong><br><span class="muted small">${segMix(members)}</span></td>
      <td>${members.length}</td><td>${Object.keys(S.pool[c.id] || {}).length}</td><td class="small">${escapeHtml(Object.values(c.signature || {}).join(', '))}</td></tr>`;
  }).join('')}</table><p class="muted small" style="margin-top:8px">Updated ${new Date(snap.updatedAt).toLocaleTimeString()} from ${snap.n} profiles</p>`;
}
const shapeSvg = (i) => {
  const c = PALETTE[i % PALETTE.length], f = i < 3 ? c : 'none';
  const shape = ['<circle cx="7" cy="7" r="5"/>', '<path d="M7 2l5.5 10h-11z"/>', '<rect x="2.5" y="2.5" width="9" height="9"/>',
    '<path d="M7 1.5L12.5 7 7 12.5 1.5 7z"/>', '<path d="M3 3l8 8M11 3l-8 8"/>', '<path d="M7 1.5l1.7 3.6 3.8.4-2.9 2.6.9 3.8L7 10l-3.5 1.9.9-3.8L1.5 5.5l3.8-.4z"/>'][i % 6];
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="${f}" stroke="${c}" stroke-width="1.5">${shape}</svg>`;
};
const segMix = (profs) => {
  const by = (s) => profs.filter((x) => S.users[x.id]?.segment === s).length;
  return `${by('power')} power · ${by('dormant')} dormant · ${by('new')} new`;
};

$('#recompute').onclick = async () => {
  const btn = $('#recompute'); btn.disabled = true;
  try { const r = await ensureCohorts(catalog, { force: true, k: Number($('#k').value) }); toast(r ? `Recomputed ${r.cohorts.length} cohorts` : 'Not enough shoppers yet'); }
  catch (e) { toast(e.message); } finally { btn.disabled = false; }
};
$('#k').onchange = () => $('#recompute').click();

$('#name-cohorts').onclick = async () => {
  const snap = S.cohorts;
  if (!snap?.cohorts?.length) return toast('No cohorts yet');
  const btn = $('#name-cohorts'); btn.disabled = true; btn.textContent = 'Asking Gemini…';
  try {
    const brief = snap.cohorts.map((c) => ({ id: c.id, size: c.size, signature: c.signature }));
    const { text } = await geminiText([{ text: `You name fashion style cohorts for a trend dashboard. For each cohort, give a catchy 1–3 word aesthetic name (e.g. "Cyber-Y2K", "Quiet Luxury", "Coastal Minimal"). Names must be distinct. Return JSON: {"<id>": "<name>"}.\n${JSON.stringify(brief)}` }], { json: true, temperature: 0.7 });
    const names = JSON.parse(text.replace(/^```json|```$/g, '').trim());
    const cohorts = snap.cohorts.map((c) => (names[c.id] ? { ...c, label: names[c.id], named: true } : c));
    await DB.rt.set('cohorts/current', { ...snap, cohorts });
    const label = Object.fromEntries(cohorts.map((c) => [c.id, c.label]));
    await Promise.all(S.profiles.filter((p) => p.cohortId in label).map((p) => DB.fs.set('profiles', p.id, { cohortLabel: label[p.cohortId] })));
    toast('Cohorts named; names stay through recomputes');
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = 'Name with Gemini'; }
};

function renderSegments(swipes) {
  const groups = [['Existing · power', (x) => x?.segment === 'power'], ['Existing · dormant', (x) => x?.segment === 'dormant'], ['New', (x) => x?.segment === 'new']];
  const st = groups.map(([, f]) => {
    const users = Object.keys(S.users).filter((u) => f(S.users[u]));
    const sw = swipes.filter((s) => f(S.users[s.u]) && s.track !== 'onboarding');
    const ord = S.orders.filter((o) => f(S.users[o.username])).length;
    return { n: users.length, likeRate: sw.length ? sw.filter((s) => s.dir !== 'nope').length / sw.length : 0,
      swipesPer: users.length ? sw.length / users.length : 0, ordersPer: users.length ? ord / users.length : 0 };
  });
  chart('segments', {
    type: 'bar',
    data: { labels: ['Like rate (%)', 'Design swipes per shopper', 'Orders per shopper ×10'], datasets: groups.map(([label], i) => ({
      label: `${label} (${st[i].n})`, backgroundColor: [INK, MID, LIGHT][i],
      data: [st[i].likeRate * 100, st[i].swipesPer, st[i].ordersPer * 10].map((x) => +x.toFixed(1)),
    })) },
  });
}

function renderSignals() {
  const t = S.live.totals || {};
  const imports = S.profiles.filter((p) => p.pastOrders?.length).length;
  $('#signal-kpis').innerHTML = [['Likes', t.likes || 0], ['Passes', t.nopes || 0], ['Orders', t.orders || 0], ['Dwell signals', t.dwells || 0], ['Order histories', imports]]
    .map(([k, v]) => `<div class="kpi"><b>${v}</b><span>${k}</span></div>`).join('');
  const profs = S.profiles.filter((p) => p.weights && Object.keys(p.weights).length);
  const avg = Object.fromEntries(SOURCES.map((s) => [s, 0]));
  profs.forEach((p) => { const m = sourceMix(normalise(p)); SOURCES.forEach((s) => (avg[s] += m[s] / profs.length)); });
  const split = (f) => { const ps = profs.filter((p) => f(S.users[p.id])); const a = Object.fromEntries(SOURCES.map((s) => [s, 0]));
    ps.forEach((p) => { const m = sourceMix(normalise(p)); SOURCES.forEach((s) => (a[s] += m[s] / ps.length)); }); return a; };
  const ex = split((x) => x?.customerType === 'existing'), nw = split((x) => x?.customerType === 'new');
  chart('signals', {
    type: 'bar',
    data: { labels: ['All shoppers', 'Existing', 'New'], datasets: SOURCES.map((s, i) => ({
      label: SOURCE_LABEL[s], data: [avg[s], ex[s], nw[s]].map((x) => +(x * 100).toFixed(1)),
      backgroundColor: ['#111111', '#3a3a3a', '#5c5c5c', '#8a8a8a', '#b4b4b4', '#d9d9d9'][i],
    })) },
    options: { indexAxis: 'y', scales: { x: { stacked: true, max: 100, ticks: { callback: (v) => v + '%' } }, y: { stacked: true } } },
  });
}

function renderExploreControl() {
  $('#explore').value = String(S.explore);
  const m = slateMix(S.explore);
  $('#explore-val').textContent = `explore level ${S.explore.toFixed(2)}`;
  $('#mix-desc').textContent = `Each batch: ${m.exploit} best match${m.exploit > 1 ? 'es' : ''} · ${m.neighbour} twist · ${m.discovery} discovery (+ 1 cohort or trending pick when available)`;
}
$('#explore').oninput = (e) => { S.explore = Number(e.target.value); renderExploreControl(); };
$('#explore').onchange = (e) => DB.rt.set('settings/explore', Number(e.target.value)).then(() => toast('Explore level updated for all shoppers'));

function renderExploration(swipes) {
  const slots = S.live.slots || {};
  const names = ['exploit', 'neighbour', 'discovery', 'cohort', 'trend'];
  const label = { exploit: 'Best match', neighbour: 'Twist', discovery: 'Discovery', cohort: 'Cohort buy', trend: 'Trending' };
  const rate = (s, f) => { const c = slots[s] || {}; const n = (c.likes || 0) + (c.nopes || 0) + (c.orders || 0); return n ? +(100 * (f === 'like' ? (c.likes || 0) + (c.orders || 0) : c.orders || 0) / n).toFixed(1) : null; };
  chart('slots', {
    type: 'bar',
    data: { labels: names.map((n) => `${label[n]} (${(slots[n]?.shown || 0)})`), datasets: [
      { label: 'Like rate (%)', data: names.map((n) => rate(n, 'like')), backgroundColor: INK },
      { label: 'Order rate (%)', data: names.map((n) => rate(n, 'order')), backgroundColor: LIGHT },
    ] },
    options: { scales: { y: { beginAtZero: true, max: 100 } } },
  });
  // catalogue coverage: share of all attribute values shown in the last 400 design swipes
  const design = swipes.filter((s) => s.track !== 'onboarding' && s.spec).sort((a, b) => b.ts - a.ts);
  const recent = design.slice(0, 400);
  const total = GROUPS.reduce((n, g) => n + options(catalog, g).length, 0);
  const seen = new Set(recent.flatMap((s) => GROUPS.map((g) => attrKey(g, s.spec[g]))));
  // variety: average distinct garment types in each shopper's last 20 design swipes
  const per = {};
  design.forEach((s) => { (per[s.u] ||= []).length < 20 && per[s.u].push(s.spec.block); });
  const shoppers = Object.values(per).filter((a) => a.length >= 5);
  const variety = shoppers.length ? shoppers.reduce((n, a) => n + new Set(a).size, 0) / shoppers.length : 0;
  const shown = Object.values(slots).reduce((n, c) => n + (c.shown || 0), 0);
  const explored = ['neighbour', 'discovery'].reduce((n, k) => n + (slots[k]?.shown || 0), 0);
  $('#explore-kpis').innerHTML = [['Catalogue coverage', pct(seen.size / total)], ['Garment types / shopper', variety ? variety.toFixed(1) : '–'], ['Exploratory share', pct(shown ? explored / shown : NaN)]]
    .map(([k, v]) => `<div class="kpi"><b>${v}</b><span>${k}</span></div>`).join('');
}

function renderSharing() {
  const t = S.live.totals || {}, c = S.live.slots?.cohort || {};
  chart('sharing', {
    type: 'bar',
    data: { labels: ['Purchases', 'Shared to cohort', 'Shown to cohort', 'Liked by cohort', 'Bought by cohort'], datasets: [{
      label: 'Count', backgroundColor: [INK, INK, MID, MID, LIGHT],
      data: [t.orders || 0, S.live.pool?.published || 0, c.shown || 0, (c.likes || 0) + (c.orders || 0), c.orders || 0],
    }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } } },
  });
}

function renderAudience() {
  const us = Object.values(S.users);
  const occ = Object.keys(catalog.occasions);
  chart('audience', {
    type: 'bar',
    data: { labels: occ.map((o) => catalog.occasions[o].label), datasets: [
      { label: 'Womenswear', data: occ.map((o) => us.filter((x) => x.gender === 'women' && x.occasions?.includes(o)).length), backgroundColor: INK },
      { label: 'Menswear', data: occ.map((o) => us.filter((x) => x.gender === 'men' && x.occasions?.includes(o)).length), backgroundColor: MID },
      { label: 'Both / not said', data: occ.map((o) => us.filter((x) => (!x.gender || x.gender === 'any') && x.occasions?.includes(o)).length), backgroundColor: LIGHT },
    ] },
    options: { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } },
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
  const h = S.live.hifi || {};
  $('#hifi-kpis').innerHTML = [['Renders on a model', h.model || 0], ['Renders on me (private)', h.me || 0]]
    .map(([k, v]) => `<div class="kpi"><b>${v}</b><span>${k}</span></div>`).join('');
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
  $('#users').innerHTML = `<table><tr><th>Shopper</th><th>Customer</th><th>Wears</th><th>Onboarding</th><th>Swipes</th><th>Orders</th><th>Cohort</th></tr>${rows.map(([u, x]) => `<tr>
    <td><a href="profile.html?u=${encodeURIComponent(u)}">${escapeHtml(u)}</a>${x.synthetic ? ' <span class="pill">synthetic</span>' : ''}</td>
    <td>${escapeHtml(x.customerType === 'existing' ? `existing · ${x.segment}` : x.customerType || x.segment || '–')}</td><td>${escapeHtml(x.gender || '–')}</td><td>${escapeHtml(x.onboarding || '–')}</td>
    <td>${profs[u]?.swipeCount || 0}</td><td>${profs[u]?.orderCount || 0}</td><td>${escapeHtml(profs[u]?.cohortLabel || '–')}</td></tr>`).join('')}</table>`;
}

$('#seed').onclick = async () => { $('#seed').disabled = true; await seedSynthetic(catalog, 24); $('#seed').disabled = false; toast('Added 24 synthetic shoppers'); };
$('#unseed').onclick = async () => { const n = await clearSynthetic(); toast(`Removed ${n} synthetic shoppers`); };
renderExploreControl();
render();
