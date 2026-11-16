// One data API over two back-ends:
//   - Firebase Realtime Database (project adip-hku) when FIREBASE_CONFIG is set
//   - a localStorage stand-in with the same shape, so the demo also runs offline / before config
//
// Everything this demo stores lives under the `shein/` root of the shared database, so it can
// never touch the other apps' data (budget, todos, events, ...). Two namespaces:
//   rt.*  → live, high-frequency paths     shein/{path}          e.g. shein/live/attr/...
//   fs.*  → document collections            shein/docs/{col}/{id} e.g. shein/docs/profiles/mira
// The `fs` API mirrors Firestore's shape (get/set/add/list/watch with where/orderBy/limit),
// implemented over RTDB: one `==` filter runs server-side (needs .indexOn), the rest client-side.
import { FIREBASE_CONFIG } from './config.js';

const FB = 'https://www.gstatic.com/firebasejs/13.3.0/';
const ROOT = 'shein';

const clean = (v) => JSON.parse(JSON.stringify(v ?? null)); // strips undefined, which Firebase rejects

export const pushId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// RTDB keys may not contain . # $ [ ] /
export const rtKey = (s) => String(s).replace(/[.#$[\]/]/g, '_');

const getAt = (o, path) => path.split(/[./]/).reduce((x, k) => (x == null ? undefined : x[k]), o);
const CMP = { '==': (a, b) => a === b, '!=': (a, b) => a !== b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
  '<': (a, b) => a < b, '<=': (a, b) => a <= b, in: (a, b) => b.includes(a), 'array-contains': (a, b) => (a || []).includes(b) };

function applyQuery(map, { where = [], orderBy, limit } = {}) {
  let out = Object.entries(map || {}).map(([id, d]) => ({ id, ...d }));
  out = out.filter((d) => where.every(([f, op, v]) => CMP[op](getAt(d, f), v)));
  if (orderBy) {
    const [f, dir] = orderBy;
    out.sort((a, b) => ((a[f] > b[f]) - (a[f] < b[f])) * (dir === 'desc' ? -1 : 1));
  }
  return limit ? out.slice(0, limit) : out;
}

async function firebaseBackend(cfg) {
  const { initializeApp } = await import(FB + 'firebase-app.js');
  const R = await import(FB + 'firebase-database.js');
  const app = initializeApp(cfg, 'shein'); // named app: never collides with other pages' default app
  const rdb = R.getDatabase(app);
  const ref = (p) => R.ref(rdb, `${ROOT}/${p}`.replace(/\/+$/, ''));
  const col = (c) => ref(`docs/${c}`);
  const doc = (c, id) => ref(`docs/${c}/${rtKey(id)}`);

  // push the first == filter to the server so a collection isn't downloaded whole
  const serverQuery = (c, opts = {}) => {
    const eq = (opts.where || []).find(([, op]) => op === '==');
    return eq ? R.query(col(c), R.orderByChild(eq[0].replace(/\./g, '/')), R.equalTo(eq[2])) : col(c);
  };

  return {
    mode: 'firebase',
    rt: {
      get: async (p) => (await R.get(ref(p))).val(),
      set: (p, v) => R.set(ref(p), clean(v)),
      update: (p, v) => R.update(ref(p), clean(v)),
      push: async (p, v) => { const r = R.push(ref(p)); await R.set(r, clean(v)); return r.key; },
      remove: (p) => R.remove(ref(p)),
      // counters: { "live/attr/colour:black/likes": 1, ... } applied atomically in one multi-path update
      incMany: (map) => R.update(R.ref(rdb, ROOT), Object.fromEntries(Object.entries(map).map(([k, n]) => [k, R.increment(n)]))),
      txn: async (p, fn) => { const r = await R.runTransaction(ref(p), fn); return { committed: r.committed, value: r.snapshot.val() }; },
      on: (p, cb) => R.onValue(ref(p), (s) => cb(s.val())),
    },
    fs: {
      get: async (c, id) => (await R.get(doc(c, id))).val(),
      set: (c, id, d, merge = true) => (merge ? R.update(doc(c, id), clean(d)) : R.set(doc(c, id), clean(d))),
      add: async (c, d) => { const r = R.push(col(c)); await R.set(r, clean(d)); return r.key; },
      del: (c, id) => R.remove(doc(c, id)),
      list: async (c, opts) => {
        try { return applyQuery((await R.get(serverQuery(c, opts))).val(), opts); }
        catch (e) { // no .indexOn for this field yet: filter client-side instead
          if (!/index/i.test(e.message)) throw e;
          return applyQuery((await R.get(col(c))).val(), opts);
        }
      },
      watch: (c, opts, cb) => R.onValue(serverQuery(c, opts), (s) => cb(applyQuery(s.val(), opts))),
    },
  };
}

function localBackend() {
  const K_RT = 'sd_rt', K_FS = 'sd_fs';
  const load = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
  const save = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch (e) { console.warn('[db] local storage full: configure Firebase for larger data', e); }
  };
  const subs = new Set();
  const notify = () => subs.forEach((f) => f());
  window.addEventListener('storage', (e) => { if (e.key === K_RT || e.key === K_FS) notify(); }); // other tabs

  const segs = (p) => p.split('/').filter(Boolean);
  const at = (t, p) => segs(p).reduce((o, k) => (o == null ? undefined : o[k]), t);
  const setAt = (t, p, v) => {
    const s = segs(p);
    let o = t;
    for (const k of s.slice(0, -1)) { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }
    if (v === null || v === undefined) delete o[s.at(-1)]; else o[s.at(-1)] = v;
  };
  const mutateRt = (fn) => { const t = load(K_RT); fn(t); save(K_RT, t); notify(); };
  const mutateFs = (fn) => { const t = load(K_FS); fn(t); save(K_FS, t); notify(); };
  const watch = (read, cb) => { const f = () => cb(read()); subs.add(f); f(); return () => subs.delete(f); };

  return {
    mode: 'local',
    rt: {
      get: async (p) => clean(at(load(K_RT), p)),
      set: async (p, v) => mutateRt((t) => setAt(t, p, clean(v))),
      update: async (p, v) => mutateRt((t) => Object.entries(clean(v)).forEach(([k, x]) => setAt(t, `${p}/${k}`, x))),
      push: async (p, v) => { const id = pushId(); mutateRt((t) => setAt(t, `${p}/${id}`, clean(v))); return id; },
      remove: async (p) => mutateRt((t) => setAt(t, p, null)),
      incMany: async (map) => mutateRt((t) => Object.entries(map).forEach(([k, n]) => setAt(t, k, (at(t, k) || 0) + n))),
      txn: async (p, fn) => {
        let committed = false, value;
        mutateRt((t) => { const next = fn(clean(at(t, p))); if (next !== undefined) { setAt(t, p, next); committed = true; } value = at(t, p); });
        return { committed, value };
      },
      on: (p, cb) => watch(() => clean(at(load(K_RT), p)), cb),
    },
    fs: {
      get: async (c, id) => clean(load(K_FS)[c]?.[rtKey(id)]) || null,
      set: async (c, id, d, merge = true) => mutateFs((t) => {
        t[c] = t[c] || {};
        const k = rtKey(id);
        t[c][k] = merge ? { ...(t[c][k] || {}), ...clean(d) } : clean(d);
      }),
      add: async (c, d) => { const id = pushId(); mutateFs((t) => { t[c] = t[c] || {}; t[c][id] = clean(d); }); return id; },
      del: async (c, id) => mutateFs((t) => { if (t[c]) delete t[c][rtKey(id)]; }),
      list: async (c, opts) => applyQuery(load(K_FS)[c], opts),
      watch: (c, opts, cb) => watch(() => applyQuery(load(K_FS)[c], opts), cb),
    },
  };
}

// localStorage sd_db=local forces the in-browser database (offline pitch fallback, and tests that must not touch live data)
const forceLocal = (() => { try { return localStorage.getItem('sd_db') === 'local'; } catch { return false; } })();
export const DB = FIREBASE_CONFIG && !forceLocal ? await firebaseBackend(FIREBASE_CONFIG) : localBackend();
