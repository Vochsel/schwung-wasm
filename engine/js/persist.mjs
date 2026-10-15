// Keep the user's Schwung state across page loads.
//
// The engine's filesystem is an in-memory copy of the device's /data/UserData,
// rebuilt from the bundle on every load. Everything Schwung writes there that
// isn't part of the bundle (slot state, presets, set state, settings, samples)
// is saved to IndexedDB and written back before the engine starts.

const DB = 'schwung-wasm', STORE = 'files', ROOT = '/data/UserData';
// Shipped with the build; never persisted (a new build must win).
const BUNDLED = [/^\/data\/UserData\/schwung\/(host|shared|shadow)\//, /^\/data\/UserData\/schwung\/modules\//,
                 /\/debug\.log$/, /_log_on$/, /\/shadow_midi_out\.log$/];
const MAX_FILE = 64 << 20;

const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = (db, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(STORE, mode);
  const out = fn(t.objectStore(STORE));
  t.oncomplete = () => res(out?.result ?? out);
  t.onerror = () => rej(t.error);
});

function walk(FS, dir, out) {
  let names;
  try { names = FS.readdir(dir); } catch { return out; }
  for (const n of names) {
    if (n === '.' || n === '..') continue;
    const p = dir + '/' + n;
    let st;
    try { st = FS.stat(p); } catch { continue; }
    if (FS.isDir(st.mode)) walk(FS, p, out);
    else if (FS.isFile(st.mode) && !BUNDLED.some(r => r.test(p)) && st.size <= MAX_FILE)
      out.set(p, `${st.size}:${+st.mtime}`);
  }
  return out;
}

function mkdirp(FS, path) {
  const parts = path.split('/').slice(1, -1);
  let cur = '';
  for (const s of parts) { cur += '/' + s; try { FS.mkdir(cur); } catch {} }
}

export async function restore(M) {
  try {
    const db = await idb();
    const all = await tx(db, 'readonly', s => s.getAll());
    for (const { path, data } of all || []) { mkdirp(M.FS, path); M.FS.writeFile(path, data); }
    return (all || []).length;
  } catch (e) { console.warn('persist: restore failed', e); return 0; }
}

// Diff the tree against the last save every few seconds and write what changed.
export function autosave(M, { everyMs = 4000 } = {}) {
  let last = walk(M.FS, ROOT, new Map());
  let busy = false;
  const save = async () => {
    if (busy) return; busy = true;
    try {
      const now = walk(M.FS, ROOT, new Map());
      const put = [...now].filter(([p, sig]) => last.get(p) !== sig).map(([p]) => p);
      const del = [...last.keys()].filter(p => !now.has(p));
      if (put.length || del.length) {
        const db = await idb();
        const files = put.map(p => { try { return { path: p, data: M.FS.readFile(p) }; } catch { return null; } }).filter(Boolean);
        await tx(db, 'readwrite', s => { for (const f of files) s.put(f, f.path); for (const p of del) s.delete(p); });
      }
      last = now;
    } catch (e) { console.warn('persist: save failed', e); }
    busy = false;
  };
  const id = setInterval(save, everyMs);
  addEventListener('pagehide', save);
  addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && save());
  return { save, stop: () => clearInterval(id) };
}

export async function reset() {
  const db = await idb();
  await tx(db, 'readwrite', s => s.clear());
}

// Whole user tree as a {path: base64} JSON blob, and back.
export function exportState(M) {
  const files = {};
  for (const p of walk(M.FS, ROOT, new Map()).keys()) {
    const d = M.FS.readFile(p); let s = '';
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
    files[p] = btoa(s);
  }
  return new Blob([JSON.stringify({ schwungWasm: 1, files })], { type: 'application/json' });
}
