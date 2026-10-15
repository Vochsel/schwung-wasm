#!/usr/bin/env node
// Headless end-to-end test of the 3D view (web/view3d.js).
//
//   node scripts/smoke-3d.mjs
//
// Opens ?view=3d, powers on the engine, then drives the 3D Move only through
// real pointer events on the WebGL canvas (raycast picking): presses a pad,
// drags a knob, scrolls the master, turns and clicks the jog, presses Menu,
// opens Schwung from the toolbar, orbits on empty space (must send no MIDI),
// uses Top/Reset view, switches 2D <-> 3D (engine must keep running) and
// checks a phone-width layout. Screenshots: build/smoke/3d-*.png.
//
// Same requirements and env as scripts/smoke.mjs (SMOKE_URL, SMOKE_ENGINE,
// CHROME, PLAYWRIGHT_DIR, BOOT_MS, VERBOSE).

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build', 'smoke');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlaywright() {
  const bases = [process.env.PLAYWRIGHT_DIR, join(ROOT, 'build/tools'), ROOT].filter(Boolean);
  for (const b of bases) {
    try { return createRequire(join(b, 'package.json'))('playwright'); } catch {}
  }
  throw new Error('playwright not found. Run: npm i --prefix build/tools playwright@1.56.1 && npx -y playwright@1.56.1 install chromium');
}
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
  url += (url.includes('?') ? '&' : '?') + 'view=3d';
  if (process.env.SMOKE_ENGINE) url += '&engine=' + process.env.SMOKE_ENGINE;
  const { chromium } = loadPlaywright();
  const exe = findChrome();
  console.log('browser:', exe || '(playwright default)');
  console.log('url:    ', url);
  browser = await chromium.launch({
    executablePath: exe,
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
           '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
           '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
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
  const shot = async (name, opts = {}) => { await sleep(120); await page.screenshot({ path: join(OUT, name), ...opts }); console.log('  saved', join('build/smoke', name)); };
  const center = (id) => evaluate(`swDebug.center(${JSON.stringify(id)})`);
  const sent = () => evaluate('swDebug.sent()');
  const click = async (p, hold = 120) => { await page.mouse.move(p.x, p.y); await page.mouse.down(); await sleep(hold); await page.mouse.up(); };
  const oled = () => evaluate('Array.from(swDebug.panel.oledBits).join(",")');

  await page.goto(url);
  await waitFor('document.readyState === "complete" && !!window.swDebug');
  const ready = await waitFor('swDebug.view === "3d" && swDebug.view3d && swDebug.view3d.active && swDebug.view3d.frames > 0', 15000);
  check('3D view loads and renders (import map, vendored three)', !!ready, ready ? '' : await evaluate('document.getElementById("v3dLoading")?.textContent'));
  if (!ready) return;
  check('3D toggle is on', await evaluate('document.getElementById("v3d").classList.contains("on")'));

  // Power on with a real click.
  const pb = await evaluate('(() => { const r = document.getElementById("powerBtn").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  await click(pb, 30);
  const started = await waitFor('swDebug.started && swDebug.audioState === "running"', 20000);
  check('engine started, AudioContext running', !!started, started ? '' : await evaluate('document.getElementById("powerMsg").textContent'));
  if (!started) return;
  const engine = await evaluate('swDebug.engine');
  console.log('  engine:', engine);
  await sleep(engine === 'real' ? +(process.env.BOOT_MS || 6000) : 1500);
  await shot('3d-boot.png');
  const ctlBoot = await evaluate('swDebug.ctl()');
  check('OLED live in 3D (texture fed from sw_display)', (await evaluate('swDebug.oledLit()')) > 50 && (await evaluate('swDebug.view3d.lastDisplaySeq')) > 0,
    `${await evaluate('swDebug.oledLit()')} lit px, 3D seq ${await evaluate('swDebug.view3d.lastDisplaySeq')}`);

  // Render-on-demand: with nothing animating, the frame counter should mostly idle.
  const fr0 = await evaluate('swDebug.view3d.frames'); await sleep(1000);
  info('3D frames rendered in 1 s idle (display/LED driven)', String((await evaluate('swDebug.view3d.frames')) - fr0));

  // Pad (note 68, bottom-left), by raycast.
  const pads0 = await evaluate('swDebug.stat(6)');
  const pad = await center('pad-68');
  await page.mouse.move(pad.x, pad.y); await page.mouse.down();
  await sleep(500);
  const padLed = await evaluate('swDebug.noteLed(68)');
  const held = await evaluate('swDebug.panel.held.has("pad-68")');
  await shot('3d-pad.png');
  await page.mouse.up();
  await sleep(200);
  const pads1 = await evaluate('swDebug.stat(6)');
  check('pad click reaches Move (sw_stat(6) pads seen)', engine !== 'real' || pads1 > pads0, `stat6 ${pads0} -> ${pads1}, held=${held}, LED ${JSON.stringify(padLed)}`);
  check('pad LED lights in engine', !!padLed && padLed[0] > 0, JSON.stringify(padLed));
  const vel = await evaluate('swDebug.sent().last');
  info('last MIDI after pad release', vel);

  // Knob 2: drag up.
  const s0 = await sent();
  const kn = await center('knob-2');
  await page.mouse.move(kn.x, kn.y); await page.mouse.down();
  for (let i = 1; i <= 15; i++) { await page.mouse.move(kn.x, kn.y - i * 6); await sleep(16); }
  const rot = await evaluate('swDebug.view3d.parts.get("knob-2").group.rotation.y');
  await page.mouse.up();
  const s1 = await sent();
  check('knob drag sends relative CCs (+ touch notes)', s1.cc > s0.cc && s1.notes >= s0.notes + 2, `${s1.cc - s0.cc} CCs, ${s1.notes - s0.notes} notes, last ${s1.last}`);
  check('knob rotates visually', Math.abs(rot) > 0.1, `rotation.y ${rot.toFixed(3)}`);

  // Wheel over the master knob.
  const mk = await center('master');
  const s2 = (await sent()).cc;
  await page.mouse.move(mk.x, mk.y); await page.mouse.wheel(0, -120); await sleep(120);
  check('wheel over master sends CC 79', (await sent()).cc > s2, (await sent()).last);

  // Jog: drag around the rim (quarter turn), then click the centre.
  const j = await evaluate('(() => { const v = swDebug.view3d, p = v.parts.get("jog"); return [0, 1, 2, 3, 4, 5, 6].map((k) => { const a = -Math.PI / 2 + k * Math.PI / 12; return v.clientOn("jog", Math.cos(a) * p.r * 0.75, Math.sin(a) * p.r * 0.75); }); })()');
  const s3 = await sent();
  await page.mouse.move(j[0].x, j[0].y); await page.mouse.down();
  for (const p of j.slice(1)) { await page.mouse.move(p.x, p.y, { steps: 3 }); await sleep(16); }
  await page.mouse.up();
  const s4 = await sent();
  check('jog drag-around sends CC 14', s4.cc - s3.cc >= 3, `${s4.cc - s3.cc} CCs, last ${s4.last}`);
  await click(await center('jog'));
  const s5 = await sent();
  check('jog centre click sends CC 3', s5.cc > s4.cc, `last ${s5.last}`);

  // A button (Menu) and the three-dot button (Shift).
  const s6 = await sent();
  await click(await center('btn-shift'));
  check('three-dot button is Shift (CC 49)', (await sent()).cc === s6.cc + 2 && (await sent()).last === 'b0 31 00', (await sent()).last);

  // Open Schwung from the toolbar.
  const before = await oled();
  const ob = await evaluate('(() => { const r = document.getElementById("openBtn").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  await click(ob, 30);
  await sleep(1500);
  const after = await oled();
  check('Open Schwung changes the 3D OLED', before !== after && (await evaluate('swDebug.view3d.lastDisplaySeq')) === (await evaluate('swDebug.panel.lastDisplaySeq')));
  await shot('3d-schwung.png');
  // Close-up on the display for legibility.
  await evaluate(`(() => { const v = swDebug.view3d; const p = v.move.oled.getWorldPosition(v._v.clone()); v.orbit.target.copy(p); v.orbit.radius = 9; v.orbit.phi = 0.35; v.orbit.theta = 0; v._applyCamera(); })()`);
  await sleep(300);
  await shot('3d-oled.png');
  await evaluate('swDebug.view3d.resetView()');

  // Orbit on empty space: camera moves, no MIDI.
  const s7 = await sent();
  const cam0 = await evaluate('swDebug.view3d.camera.position.toArray().join(",")');
  await page.mouse.move(60, 140); await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(60 + i * 18, 140 + i * 4); await sleep(16); }
  await page.mouse.up();
  const cam1 = await evaluate('swDebug.view3d.camera.position.toArray().join(",")');
  const s8 = await sent();
  check('orbit on empty space moves camera, sends no MIDI', cam0 !== cam1 && s8.cc === s7.cc && s8.notes === s7.notes);
  await shot('3d-orbit.png');
  await click(await evaluate('(() => { const r = document.getElementById("camTop").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()'), 30);
  await sleep(300);
  await shot('3d-top.png');
  await click(await evaluate('(() => { const r = document.getElementById("camReset").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()'), 30);
  await sleep(300);

  // Keyboard still drives the device in 3D.
  const s9 = await sent();
  await page.keyboard.down('d'); await sleep(120);
  const kHeld = await evaluate('swDebug.panel.held.has("pad-72")');
  const kY = await evaluate('swDebug.view3d.parts.get("pad-72").group.position.y < swDebug.view3d.parts.get("pad-72").baseY');
  await page.keyboard.up('d');
  check('keyboard plays pads in 3D (and pad depresses)', kHeld && kY && (await sent()).notes > s9.notes);

  // 2D <-> 3D does not restart the engine or audio.
  const blk0 = await evaluate('swDebug.stat(0)'), ctl0 = await evaluate('swDebug.ctl()');
  await evaluate('document.getElementById("v2d").click()'); await sleep(600);
  await shot('3d-switch-2d.png');
  const in2d = await evaluate('swDebug.view === "2d" && getComputedStyle(document.getElementById("device")).display !== "none"');
  await evaluate('document.getElementById("v3d").click()'); await sleep(600);
  const blk1 = await evaluate('swDebug.stat(0)'), ctl1 = await evaluate('swDebug.ctl()');
  check('2D <-> 3D keeps engine + audio running', in2d && blk1 > blk0 && ctl1[1] > ctl0[1] && (await evaluate('swDebug.audioState')) === 'running',
    `blocks ${blk0} -> ${blk1}, underruns +${(ctl1[3] - ctl0[3]) >>> 0}`);
  check('view remembered in localStorage', (await evaluate('localStorage.getItem("schwung.view")')) === '3d');

  // Hover tooltip.
  const b = await center('btn-menu');
  await page.mouse.move(b.x + 1, b.y + 1); await sleep(50); await page.mouse.move(b.x, b.y); await sleep(100);
  const tipText = await evaluate('document.getElementById("tip").classList.contains("on") && document.getElementById("tip").textContent');
  check('hover tooltip names the control', /^Menu/.test(tipText || ''), String(tipText));
  await shot('3d.png');

  const c2 = await evaluate('swDebug.ctl()');
  const dU = (c2[3] - ctlBoot[3]) >>> 0;
  check('no underruns while interacting in 3D (after boot)', dU <= 3, `+${dU} (total ${c2[3]})`);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  // Phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(600);
  const fits = await evaluate('(() => { const r = swDebug.view3d.canvas.getBoundingClientRect(); return r.right <= innerWidth + 0.5 && r.left >= 0 && document.documentElement.scrollWidth <= innerWidth; })()');
  check('3D fits phone width (390 px)', fits);
  await shot('3d-phone.png');
}

const WATCHDOG = setTimeout(() => { console.error('smoke-3d: timed out after 120 s'); results.push({ ok: false }); browser?.close(); server?.kill(); process.exit(2); }, 120000);
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
