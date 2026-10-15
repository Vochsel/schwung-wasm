// Load every built catalog module into the REAL engine (through the web param
// ring, as Schwung's web manager does) and check it makes sound there:
// synths get notes on slot 1; audio FX sit after a synth; MIDI FX before one.
// Usage: node tests/catalog.mjs [ids...]   → build/smoke/catalog.json
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(ROOT, 'build/tools/package.json'))('playwright');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const srv = createServer(async (req, res) => {
  const p = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try { const b = await readFile(p); res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
}).listen(0);
function shell() {
  const c = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(c)) return undefined;
  for (const d of readdirSync(c).filter(d => d.startsWith('chromium_headless_shell')).sort().reverse())
    for (const sub of readdirSync(join(c, d))) {
      const exe = join(c, d, sub, sub.startsWith('chrome-headless-shell') ? 'chrome-headless-shell' : 'headless_shell');
      if (existsSync(exe)) return exe;
    }
}
const manifest = JSON.parse(await readFile(join(ROOT, 'build/vfs/modules-manifest.json'), 'utf8')).modules;
const only = process.argv.slice(2);
const mods = manifest.filter(m => !only.length || only.includes(m.id));
const browser = await chromium.launch({ executablePath: process.env.CHROME || shell() });
const page = await browser.newPage();
const lines = [];
page.on('console', m => lines.push(m.text()));
page.on('pageerror', e => lines.push('PAGEERROR ' + e.message + '\n' + (e.stack || '')));
page.on('worker', w => { w.on('console', m => lines.push('[worker] ' + m.text())); });
await page.goto(`http://localhost:${srv.address().port}/tests/engine.html?log`);
const wait = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 80 && !(await page.evaluate(() => window.ready).catch(() => false)); i++) await wait(250);
await wait(6000);
// Run JS in the shadow UI's own context (engine/ui_eval.c) and wait for the answer.
const uiEval = async src => {
  const id = await page.evaluate(s => window.M.ccall('sw_ui_eval', 'number', ['string'], [s]), src);
  for (let i = 0; i < 200; i++) { if (await page.evaluate(() => window.M._sw_ui_done()) >= id) break; await wait(25); }
  return page.evaluate(() => window.M.UTF8ToString(window.M._sw_ui_result()));
};
const set = (slot, key, val) => uiEval(`shadow_set_param_timeout(${slot}, ${JSON.stringify(key)}, ${JSON.stringify(val)}, 4000)`);
const ext = (st, a, b) => page.evaluate(([st, a, b]) => window.M._sw_midi_in(2, st, a, b), [st, a, b]);
const cpeak = () => page.evaluate(() => window.M._sw_stat(8));
const frames = () => page.evaluate(() => window.M._sw_stat(0));
const SOURCE = 'hush1';   // a plain synth to feed FX
async function play(notes, ms = 350) {
  await cpeak();
  for (const n of notes) { await ext(0x90, n, 110); await wait(ms); await ext(0x80, n, 0); }
  await wait(250);
  return cpeak();
}
console.log('probe ->', await uiEval('typeof shadow_set_param_timeout + " " + shadow_get_param(0, "synth:module")'));
const results = [];
for (const m of mods) {
  const t0 = Date.now();
  const f0 = await frames();
  let r = { id: m.id, type: m.type };
  try {
    for (const k of ['synth:module', 'fx1:module', 'midi_fx1:module']) await set(0, k, '');
    await wait(400);
    if (m.type === 'sound_generator') {
      await set(0, 'synth:module', m.id); await wait(1500);
      r.peak = await play([36, 38, 48, 60, 67]);
    } else if (m.type === 'audio_fx') {
      await set(0, 'synth:module', SOURCE); await wait(1200);
      r.dry = await play([48, 60]);
      await set(0, 'fx1:module', m.id); await wait(1500);
      r.peak = await play([48, 60]);
    } else if (m.type === 'midi_fx') {
      await set(0, 'synth:module', SOURCE); await wait(1200);
      await set(0, 'midi_fx1:module', m.id); await wait(1500);
      await page.evaluate(() => { window.M._sw_transport(1); });
      r.peak = await play([48, 52, 55], 700);
      await page.evaluate(() => { window.M._sw_transport(0); });
    }
    const f1 = await frames();
    r.realtime = +(((f1 - f0) * 128 / 44100) / ((Date.now() - t0) / 1000)).toFixed(2);   // engine kept up?
    r.ok = r.peak > 50;
  } catch (e) { r.error = String(e).slice(0, 200); r.ok = false; }
  results.push(r);
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${m.type.padEnd(16)} ${m.id.padEnd(18)} peak=${r.peak}${r.dry !== undefined ? ' dry=' + r.dry : ''} rt=${r.realtime}`);
}
await mkdir(join(ROOT, 'build/smoke'), { recursive: true });
await writeFile(join(ROOT, 'build/smoke/catalog.json'), JSON.stringify(results, null, 1));
await writeFile(join(ROOT, 'build/smoke/catalog-console.txt'), lines.join('\n'));
await writeFile(join(ROOT, 'build/smoke/catalog-debug.log'), await page.evaluate(() => window.readLog()));
console.log(`${results.filter(r => r.ok).length}/${results.length} ok`);
await browser.close(); srv.close();
