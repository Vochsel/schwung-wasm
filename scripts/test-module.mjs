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
    'build/schwung/src/host/plugin_api_v1.h', 'build/schwung/src/host/audio_fx_api_v2.h',
    'build/schwung/src/host/midi_fx_api_v1.h'];
  const h = crypto.createHash('sha256');
  for (const f of inputs) h.update(fs.readFileSync(path.join(ROOT, f)));
  const flags = '-O2 -pthread -sMAIN_MODULE=1 -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 '
    + '-sMAXIMUM_MEMORY=2147483648 -sPTHREAD_POOL_SIZE=4 -sENVIRONMENT=node,worker -lnodefs.js';
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
    const t0 = Date.now();
    // test.params: {key: value} applied with set_param after create_instance
    // test.create_json: string (or object) passed as create_instance's 2nd arg
    // test.audio_in: feed the saw into the mailbox audio-in for generators too
    // test.seconds: render length
    const params = Object.entries(testCfg.params || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    const cj = testCfg.create_json == null ? '' : typeof testCfg.create_json === 'string' ? testCfg.create_json : JSON.stringify(testCfg.create_json);
    const secs = testCfg.seconds ?? seconds;
    const r = run(process.execPath, [TH_JS, m.type, `${m.path}/${m.dsp}`, m.path, `/out/${id}.wav`, String(secs), transport ? '1' : '0', threaded ? '1' : '0'], {
      env: { ...process.env, TESTHOST_DATA: path.join(VFS, 'data'), TESTHOST_OUT: OUT,
        TESTHOST_PARAMS: params, TESTHOST_CREATE_JSON: cj, TESTHOST_AUDIO_IN: testCfg.audio_in ? '1' : '0' },
      timeout: timeoutS * 1000,
    });
    const ms = Date.now() - t0;
    const out = (r.stdout || '') + (r.stderr || '');
    fs.writeFileSync(path.join(OUT, `${id}.log`), out);
    const line = out.split('\n').reverse().find(l => l.startsWith('@@RESULT '));
    const stats = line ? JSON.parse(line.slice(9)) : null;
    res = { id, type: m.type, ms, ...(stats || {}) };
    const peakDb = stats && stats.peak > 0 ? 20 * Math.log10(stats.peak / 32768) : -999;
    if (r.error && r.error.code === 'ETIMEDOUT') res.reason = `timeout after ${timeoutS}s`;
    else if (!stats) {
      const err = out.split('\n').find(l => /Error|error:|Aborted|abort/.test(l)) || `exit ${r.status}`;
      res.reason = `crash: ${err.trim().slice(0, 200)}`;
    } else if (!stats.ok) res.reason = `${stats.stage}: ${stats.error}`;
    else if (m.type === 'midi_fx' && !stats.midi_out_note_ons) res.reason = 'no note-ons out of the MIDI FX';
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
  console.log(`${res.pass ? 'PASS' : 'FAIL'}  ${id.padEnd(20)} ${res.ok ? `rms ${res.rms_dbfs} dBFS  peak ${res.peak_dbfs} dBFS${extra}  (${res.ms} ms)` : ''}${res.reason ? '  ' + res.reason : ''}${res.warn ? '  [warn: ' + res.warn + ']' : ''}`);
}
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + '\n');
console.log(`${todo.length - failed}/${todo.length} passed; results in build/module-test/results.json`);
process.exit(failed ? 1 : 0);
