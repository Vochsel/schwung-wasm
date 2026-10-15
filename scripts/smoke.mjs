#!/usr/bin/env node
// Headless end-to-end smoke test of the web front-end.
//
//   node scripts/smoke.mjs
//
// Starts scripts/serve.mjs on a spare port (or uses SMOKE_URL), launches
// Chromium headless via Playwright with --autoplay-policy=no-user-gesture-required,
// clicks Power on, presses a pad, turns a knob, and asserts:
//   - crossOriginIsolated
//   - the worklet is consuming ring blocks and underruns stop growing after warm-up
//   - the OLED buffer is non-empty and changes when a knob turns
//   - the pressed pad's LED lights
// Saves build/smoke/panel.png (+ panel-pad.png while the pad is held).
//
// SMOKE_ENGINE=mock|real forces the engine (default: real if web/engine exists).

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build', 'smoke');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Playwright is a test-only tool, not a project dependency: resolved from
// build/tools (where the engine scripts install it), $PLAYWRIGHT_DIR, or a
// global install. Install: npm i --prefix build/tools playwright@1.56.1 &&
// npx -y playwright@1.56.1 install chromium
function loadPlaywright() {
  const bases = [process.env.PLAYWRIGHT_DIR, join(ROOT, 'build/tools'), ROOT].filter(Boolean);
  for (const b of bases) {
    try { return createRequire(join(b, 'package.json'))('playwright'); } catch {}
  }
  throw new Error('playwright not found. Run: npm i --prefix build/tools playwright@1.56.1 && npx -y playwright@1.56.1 install chromium');
}
// $CHROME overrides; else the newest full Chromium in Playwright's cache (new
// headless mode, real audio output so the AudioWorklet actually runs); else
// whatever this Playwright version expects.
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const base of [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
    if (!existsSync(base)) continue;
    const dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => b.split('-')[1] - a.split('-')[1]);
    for (const d of dirs) for (const rel of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(base, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/* ---------------- run ---------------- */
const results = [];
const info = (name, detail = '') => console.log(`INFO  ${name}${detail ? '  — ' + detail : ''}`);
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

let server = null, browser = null;
async function main() {
  mkdirSync(OUT, { recursive: true });
  let url = process.env.SMOKE_URL;
  if (!url) {
    const port = 8790 + 100 + Math.floor(Math.random() * 500);
    server = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs')], { env: { ...process.env, PORT: String(port), QUIET: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res, rej) => { server.stdout.once('data', res); server.once('exit', (c) => rej(new Error('server exited ' + c))); });
    url = `http://localhost:${port}/`;
  }
  if (process.env.SMOKE_ENGINE) url += (url.includes('?') ? '&' : '?') + 'engine=' + process.env.SMOKE_ENGINE;
  const { chromium } = loadPlaywright();
  const exe = findChrome();
  console.log('browser:', exe || '(playwright default)');
  console.log('url:    ', url);
  browser = await chromium.launch({
    executablePath: exe,
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
           '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (process.env.VERBOSE || m.type() === 'error' || m.type() === 'warning') console.log(`  [console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => { errors.push(e.message); console.log('  [pageerror]', e.message); });
  const evaluate = (expr) => page.evaluate(expr);
  const waitFor = async (expr, ms = 10000) => {
    const t0 = Date.now();
    for (;;) { const v = await evaluate(expr).catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); }
  };
  const mouse = async (type, x, y) => {
    if (type === 'mouseMoved') return page.mouse.move(x, y);
    await page.mouse.move(x, y);
    return type === 'mousePressed' ? page.mouse.down() : page.mouse.up();
  };
  const shot = async (name) => { await page.screenshot({ path: join(OUT, name) }); console.log('  saved', join('build/smoke', name)); };
  await page.goto(url);
  await waitFor('document.readyState === "complete" && !!window.swDebug');

  check('crossOriginIsolated', await evaluate('crossOriginIsolated') === true, await evaluate('location.href + " isSecure=" + isSecureContext + " SAB=" + (typeof SharedArrayBuffer)'));
  await shot('poweroff.png');

  // Power on with a real (trusted) click.
  const pb = await evaluate('(() => { const r = document.getElementById("powerBtn").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  await mouse('mousePressed', pb.x, pb.y); await mouse('mouseReleased', pb.x, pb.y);
  const started = await waitFor('swDebug.started && swDebug.audioState === "running"', 15000);
  const err = await evaluate('document.getElementById("powerMsg").textContent');
  check('engine started, AudioContext running', !!started, started ? '' : 'powerMsg: ' + err);
  if (!started) return;
  const engine = await evaluate('swDebug.engine');
  console.log('  engine:', engine, ' sampleRate:', await evaluate('swDebug.sampleRate'));

  // The real engine shows a boot splash for ~4 s before the home screen.
  if (engine === 'real') { await sleep(+(process.env.BOOT_MS || 6000)); await shot('boot.png'); }
  // Warm up, then measure pacing over 3 s.
  await sleep(1500);
  const c0 = await evaluate('swDebug.ctl()'); const t0 = Date.now();
  await sleep(3000);
  const c1 = await evaluate('swDebug.ctl()'); const dt = (Date.now() - t0) / 1000;
  const consumed = (c1[1] - c0[1]) >>> 0, expected = dt * 44100 / 128;
  check('worklet consuming blocks', consumed > expected * 0.9 && consumed < expected * 1.1, `${consumed} blocks in ${dt.toFixed(2)} s (expect ~${expected.toFixed(0)})`);
  const dUnder = (c1[3] - c0[3]) >>> 0;
  check('underruns stable after warm-up', dUnder <= 2, `+${dUnder} over ${dt.toFixed(1)} s (total ${c1[3]}), ring ${(c1[0] - c1[1]) >>> 0}/${c1[2]}`);

  const lit0 = await evaluate('swDebug.oledLit()');
  check('OLED buffer non-empty', lit0 > 50, `${lit0} lit pixels, seq ${await evaluate('swDebug.displaySeq()')}`);

  // Press pad 1 (bottom-left, note 68).
  const pad = await evaluate('swDebug.center("pad-68")');
  await mouse('mouseMoved', pad.x, pad.y);
  if (engine === 'real') await evaluate('swDebug.stat(8)');           // reset audio peak
  await mouse('mousePressed', pad.x, pad.y);
  await sleep(engine === 'real' ? 600 : 250);
  if (engine === 'real') { const pk = await evaluate('swDebug.stat(8)'); info('pad audio peak (sw_stat 8; 0 is normal until a sound is loaded in a slot)', String(pk)); }
  const led = await evaluate('swDebug.noteLed(68)');
  check('pad press reaches engine (LED lit)', !!led && led[0] > 0, `note 68 LED = ${JSON.stringify(led)}`);
  if (engine === 'mock') check('pad LED bright while held', led[0] === 1, `palette ${led[0]}`);
  await shot('panel-pad.png');
  await mouse('mouseReleased', pad.x, pad.y);

  // Turn knob 2 (cutoff): drag up 90 px.
  const disp0 = await evaluate('Array.from(swDebug.panel.oledBits).join(",")');
  const kn = await evaluate('swDebug.center("knob-2")');
  const sent0 = await evaluate('swDebug.sent()');
  await mouse('mouseMoved', kn.x, kn.y);
  await mouse('mousePressed', kn.x, kn.y);
  for (let i = 1; i <= 15; i++) { await mouse('mouseMoved', kn.x, kn.y - i * 6); await sleep(16); }
  await sleep(150);
  const touched = await evaluate('swDebug.ccLed(72)');
  await mouse('mouseReleased', kn.x, kn.y - 90);
  const sent1 = await evaluate('swDebug.sent()');
  check('knob drag sends relative CCs', sent1.cc > sent0.cc, `${sent1.cc - sent0.cc} CC messages, last ${sent1.last}`);
  if (engine === 'mock') check('knob touch lights knob LED', touched && touched[0] > 0, JSON.stringify(touched));
  await sleep(300);
  const disp1 = await evaluate('Array.from(swDebug.panel.oledBits).join(",")');
  if (engine === 'mock') check('OLED updates after knob turn', disp0 !== disp1);
  else info('OLED changed after knob turn', String(disp0 !== disp1));

  // Wheel over the master knob + keyboard pad.
  const mk = await evaluate('swDebug.center("master")');
  const s2 = await evaluate('swDebug.sent().cc');
  await page.mouse.move(mk.x, mk.y); await page.mouse.wheel(0, -120);
  await sleep(100);
  check('wheel over knob sends CC', (await evaluate('swDebug.sent().cc')) > s2);
  await page.keyboard.down('d');
  await sleep(120);
  const kLed = await evaluate('swDebug.noteLed(72)');
  await page.keyboard.up('d');
  if (engine === 'mock') check('keyboard "d" plays pad 5 (note 72)', kLed && kLed[0] === 1, JSON.stringify(kLed));

  if (engine === 'real') {
    const before = await evaluate('Array.from(swDebug.panel.oledBits).join(",")');
    await evaluate('swDebug.openSchwung()');
    await sleep(1500);
    await shot('schwung-open.png');
    const after = await evaluate('Array.from(swDebug.panel.oledBits).join(",")');
    check('Open Schwung changes the screen', before !== after);
    await page.keyboard.down('Backspace'); await sleep(80); await page.keyboard.up('Backspace'); await sleep(600);
  }
  await sleep(800);
  const c2 = await evaluate('swDebug.ctl()');
  check('no new underruns during interaction', ((c2[3] - c1[3]) >>> 0) <= 2, `+${(c2[3] - c1[3]) >>> 0}`);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await shot('panel.png');

  // Phone-width layout.
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  const fits = await evaluate('(() => { const r = document.getElementById("device").getBoundingClientRect(); return r.right <= innerWidth && r.left >= 0 && document.documentElement.scrollWidth <= innerWidth; })()');
  check('fits phone width (390 px)', fits);
  await shot('panel-phone.png');
}

const WATCHDOG = setTimeout(() => { console.error('smoke: timed out after 90 s'); results.push({ ok: false }); browser?.close(); server?.kill(); process.exit(2); }, 90000);
main()
  .catch((e) => { console.error(e); results.push({ ok: false }); })
  .finally(() => {
    browser?.close().catch(() => {});
    try { server?.kill(); } catch {}
    clearTimeout(WATCHDOG);
    const failed = results.filter((r) => !r.ok).length;
    console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${results.length} checks passed`);
    setTimeout(() => process.exit(failed ? 1 : 0), 400);
  });
