#!/usr/bin/env node
// Smoke-test Schwung modules built by scripts/build-modules.sh.
//
//   node scripts/test-module.mjs [--build] [--threaded] [--seconds N] [id ...]
//
// With no ids, tests every module in build/vfs/modules-manifest.json.
// --build runs scripts/build-modules.sh for the ids first.
// --threaded renders on a pthread that already existed when the module was
// dlopen()ed on the main thread (the engine's loader-thread/audio-thread shape).
//
// For each module: builds (once, cached) the Emscripten MAIN_MODULE test host
// (modules/testhost/testhost.c), runs it under Node with build/vfs/data
// mounted at /data, dlopens the module's side module from its device path,
// calls the right init + create_instance(module_dir, NULL), plays notes
// (sound generators), a saw (audio FX) or notes through the MIDI FX into a sine
// synth, renders 2 s and writes build/module-test/<id>.wav.
//
// Pass = ran to completion, non-silent (peak > -60 dBFS), no NaN symptom,
// not railed; for midi_fx at least one note-on came out.
// Results: build/module-test/results.json (merged across runs).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VFS = path.join(ROOT, 'build/vfs');
const OUT = path.join(ROOT, 'build/module-test');
const TH_DIR = path.join(ROOT, 'build/testhost');
let TH_JS; // build/testhost/<input-hash>/testhost.js, set by ensureTestHost()

const args = process.argv.slice(2);
let doBuild = false, seconds = 2, timeoutS = 180, threaded = false;
const ids = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--build') doBuild = true;
  else if (args[i] === '--threaded') threaded = true;
  else if (args[i] === '--seconds') seconds = Number(args[++i]);
  else if (args[i] === '--timeout') timeoutS = Number(args[++i]);
  else ids.push(args[i]);
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  return r;
}

// ---- test host (cached on a hash of its inputs) ----------------------------
function ensureTestHost() {
  if (!fs.existsSync(path.join(ROOT, 'build/schwung/src/host/plugin_api_v1.h'))) {
    const p = run('bash', ['scripts/prepare.sh'], { stdio: 'inherit' });
    if (p.status !== 0) throw new Error('prepare.sh failed');
  }
  const inputs = ['modules/testhost/testhost.c', 'modules/testhost/pre.js', 'compat/wasm_compat.h',
    'compat/include/schwung_module_prelude.h',
    'build/schwung/src/host/plugin_api_v1.h', 'build/schwung/src/host/audio_fx_api_v2.h',
    'build/schwung/src/host/midi_fx_api_v1.h'];
  const h = crypto.createHash('sha256');
  for (const f of inputs) h.update(fs.readFileSync(path.join(ROOT, f)));
  const flags = '-O2 -pthread -sMAIN_MODULE=1 -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 '
    + '-sMAXIMUM_MEMORY=2147483648 -sPTHREAD_POOL_SIZE=8 -sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB -sENVIRONMENT=node,worker -lnodefs.js';
  h.update(flags);
  const stamp = h.digest('hex');
  // Content-addressed output dir, built in a temp dir and renamed into place,
  // so concurrent runs never load a half-written testhost.js/.wasm pair.
  const dir = path.join(TH_DIR, stamp.slice(0, 16));
  TH_JS = path.join(dir, 'testhost.js');
  if (fs.existsSync(TH_JS)) return;
  fs.mkdirSync(TH_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(TH_DIR, 'tmp-'));
  const rel = path.relative(ROOT, tmp);
  console.log('building test host…');
  // em++ link so libc++/libc++abi are in the main module for C++ side modules.
  const sh = 'emcc -c -O2 -pthread -fPIC -include /w/compat/wasm_compat.h -I/w/build/schwung/src/host '
    + `modules/testhost/testhost.c -o ${rel}/testhost.o && `
    + `em++ ${flags} --pre-js modules/testhost/pre.js ${rel}/testhost.o -o ${rel}/testhost.js`;
  const r = run(path.join(ROOT, 'scripts/em'), ['bash', '-c', sh]);
  if (r.status !== 0) { process.stderr.write(r.stdout + r.stderr); fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('test host build failed'); }
  try { fs.renameSync(tmp, dir); } catch { fs.rmSync(tmp, { recursive: true, force: true }); } // lost the race: fine
}

// test.notes: [[t, status, d1, d2], ...] or plain note numbers (each played
// for 0.2 s, one every 0.25 s, velocity 110)
function notesEnv(notes) {
  if (!notes || !notes.length) return '';
  const ev = notes.flatMap((n, i) => Array.isArray(n) ? [n]
    : [[i * 0.25, 0x90, n, 110], [i * 0.25 + 0.2, 0x80, n, 0]]);
  return ev.map(e => e.join(',')).join(';');
}

// ---- import check: every symbol a side module needs must be exported by the
// main module. Emscripten stubs missing ones lazily, so without this a gap
// (e.g. sched_setscheduler) only traps when a worker thread first calls it.
function wasmSections(buf) {
  let p = 8;
  const u = () => { let r = 0, sh = 0, b; do { b = buf[p++]; r |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); return r >>> 0; };
  const str = () => { const n = u(); const s = buf.toString('utf8', p, p + n); p += n; return s; };
  const limits = () => { const f = u(); u(); if (f & 1) u(); };
  const imps = [], exps = new Set();
  while (p < buf.length) {
    const id = buf[p++], size = u(), end = p + size;
    if (id === 2) {
      for (let n = u(); n > 0; n--) {
        const mod = str(), field = str(), kind = buf[p++];
        if (kind === 0) u(); else if (kind === 1) { p++; limits(); } else if (kind === 2) limits();
        else if (kind === 3) { p += 2; } else if (kind === 4) { p++; u(); }
        imps.push([mod, field]);
      }
    } else if (id === 7) {
      for (let n = u(); n > 0; n--) { exps.add(str()); p++; u(); }
    }
    p = end;
  }
  return { imps, exps };
}
let mainExports = null;
const PLUMBING = new Set(['memory', '__indirect_function_table', '__stack_pointer', '__memory_base', '__table_base']);
function missingImports(soPath) {
  if (!mainExports) mainExports = wasmSections(fs.readFileSync(TH_JS.replace(/\.js$/, '.wasm'))).exps;
  const { imps, exps } = wasmSections(fs.readFileSync(soPath));
  const miss = new Set();
  for (const [mod, f] of imps) {
    if (PLUMBING.has(f) || exps.has(f) || mainExports.has(f)) continue;
    if (mod === 'env' || mod.startsWith('GOT.')) miss.add(f);
  }
  return [...miss].sort();
}

// ---- main --------------------------------------------------------------------
if (doBuild) {
  const r = run('bash', ['scripts/build-modules.sh', ...ids], { stdio: 'inherit' });
  if (r.status !== 0) console.warn('build-modules.sh reported failures; testing what was built');
}
const manifestPath = path.join(VFS, 'modules-manifest.json');
if (!fs.existsSync(manifestPath)) { console.error('no build/vfs/modules-manifest.json; run scripts/build-modules.sh'); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).modules;
const byId = Object.fromEntries(manifest.map(m => [m.id, m]));
const todo = ids.length ? ids : manifest.map(m => m.id);

ensureTestHost();
fs.mkdirSync(OUT, { recursive: true });
const resultsPath = path.join(OUT, 'results.json');
let results = {};
try { results = JSON.parse(fs.readFileSync(resultsPath, 'utf8')); } catch {}

let failed = 0;
for (const id of todo) {
  const m = byId[id];
  let res;
  if (!m) {
    res = { id, pass: false, reason: 'not built (missing from modules-manifest.json)' };
  } else {
    // Per-recipe test overrides: modules/recipes/<id>.json "test": {"transport": bool}
    let testCfg = {};
    try { testCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'modules/recipes', `${id}.json`), 'utf8')).test || {}; } catch {}
    const transport = testCfg.transport ?? (m.type === 'midi_fx');
    const unresolved = missingImports(path.join(VFS, m.path, m.dsp));
    const t0 = Date.now();
    // test.params: {key: value} applied with set_param after create_instance
    // test.create_json: string (or object) passed as create_instance's 2nd arg
    // test.audio_in: feed the saw into the mailbox audio-in for generators too
    // test.seconds: render length
    // test.wait_ms: after create_instance, wait (pumping proxied calls) for loader threads
    // test.realtime: pace rendering at real time (modules that build DSP on a worker)
    // test.notes: [[t, status, d1, d2], ...] replaces the default note stimulus
    const params = Object.entries(testCfg.params || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    const cj = testCfg.create_json == null ? '' : typeof testCfg.create_json === 'string' ? testCfg.create_json : JSON.stringify(testCfg.create_json);
    const secs = testCfg.seconds ?? seconds;
    const r = run(process.execPath, [TH_JS, m.type, `${m.path}/${m.dsp}`, m.path, `/out/${id}.wav`, String(secs), transport ? '1' : '0', threaded ? '1' : '0'], {
      env: { ...process.env, TESTHOST_DATA: path.join(VFS, 'data'), TESTHOST_OUT: OUT,
        TESTHOST_PARAMS: params, TESTHOST_CREATE_JSON: cj, TESTHOST_AUDIO_IN: testCfg.audio_in ? '1' : '0',
        TESTHOST_REALTIME: testCfg.realtime ? '1' : '0',
        TESTHOST_WAIT_MS: String(testCfg.wait_ms || 0),
        TESTHOST_NOTES: notesEnv(testCfg.notes) },
      timeout: timeoutS * 1000,
    });
    const ms = Date.now() - t0;
    const out = (r.stdout || '') + (r.stderr || '');
    fs.writeFileSync(path.join(OUT, `${id}.log`), out);
    const line = out.split('\n').reverse().find(l => l.startsWith('@@RESULT '));
    const stats = line ? JSON.parse(line.slice(9)) : null;
    res = { id, type: m.type, ms, ...(stats || {}) };
    const peakDb = stats && stats.peak > 0 ? 20 * Math.log10(stats.peak / 32768) : -999;
    if (unresolved.length) res.reason = `unresolved imports (main module lacks): ${unresolved.slice(0, 8).join(', ')}${unresolved.length > 8 ? ', …' : ''}`;
    else if (r.error && r.error.code === 'ETIMEDOUT') res.reason = `timeout after ${timeoutS}s`;
    else if (!stats) {
      const err = out.split('\n').find(l => /Error|error:|Aborted|abort/.test(l)) || `exit ${r.status}`;
      res.reason = `crash: ${err.trim().slice(0, 200)}`;
    } else if (!stats.ok) res.reason = `${stats.stage}: ${stats.error}`;
    else if (m.type === 'midi_fx' && !stats.midi_out_note_ons) res.reason = 'no note-ons out of the MIDI FX';
    else if (peakDb < -60 && stats.host_midi_msgs > 0) res.note = `silent audio, sent ${stats.host_midi_msgs} MIDI msgs to host`;
    else if (peakDb < -60 && testCfg.expect_silent) res.note = `silent by design: ${testCfg.silent_reason || 'expect_silent'}`;
    else if (peakDb < -60) res.reason = `silent (peak ${peakDb.toFixed(1)} dBFS)`;
    else if (stats.nan_suspect) res.reason = 'output died while input was live (NaN?)';
    else if (stats.railed_frac > 0.5) res.reason = `railed output (${(stats.railed_frac * 100).toFixed(0)}% at full scale)`;
    res.peak_dbfs = Number(peakDb.toFixed(2));
    res.pass = !res.reason;
    const warn = [];
    if (stats && stats.ok && m.type === 'audio_fx' && stats.fx_diff_dbfs <= -90) warn.push('output == input (pass-through at defaults)');
    if (stats && stats.ok && stats.railed_frac > 0.3) warn.push(`${(stats.railed_frac * 100).toFixed(0)}% of samples at full scale`);
    if (warn.length) res.warn = warn.join('; ');
    if (res.pass) res.wav = `build/module-test/${id}.wav`;
  }
  res.tested_at = new Date().toISOString();
  results[id] = res;
  if (!res.pass) failed++;
  const extra = !res.ok ? '' : res.type === 'midi_fx' ? `  notes_out ${res.midi_out_note_ons}` : res.type === 'audio_fx' ? `  wet-dry ${res.fx_diff_dbfs} dBFS` : '';
  console.log(`${res.pass ? 'PASS' : 'FAIL'}  ${id.padEnd(20)} ${res.ok ? `rms ${res.rms_dbfs} dBFS  peak ${res.peak_dbfs} dBFS${extra}  (${res.ms} ms)` : ''}${res.reason ? '  ' + res.reason : ''}${res.note ? '  (' + res.note + ')' : ''}${res.warn ? '  [warn: ' + res.warn + ']' : ''}`);
}
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + '\n');
console.log(`${todo.length - failed}/${todo.length} passed; results in build/module-test/results.json`);
process.exit(failed ? 1 : 0);
