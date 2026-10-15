#!/usr/bin/env node
// Headless end-to-end smoke test of the web front-end.
//
//   node scripts/smoke.mjs
//
// Starts scripts/serve.mjs on a spare port (or uses SMOKE_URL), launches
// Chromium headless with --autoplay-policy=no-user-gesture-required, talks to
// it over the DevTools protocol on a pipe (Node stdlib only, no Playwright
// package needed), clicks Power on, presses a pad, turns a knob, and asserts:
//   - crossOriginIsolated
//   - the worklet is consuming ring blocks and underruns stop growing after warm-up
//   - the OLED buffer is non-empty and changes when a knob turns
//   - the pressed pad's LED lights
// Saves build/smoke/panel.png (+ panel-pad.png while the pad is held).
//
// Browser: $CHROME, else Playwright's cached Chromium, else Google Chrome.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build', 'smoke');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const pw = join(homedir(), 'Library/Caches/ms-playwright');
  const linuxPw = join(homedir(), '.cache/ms-playwright');
  for (const base of [pw, linuxPw]) {
    if (!existsSync(base)) continue;
    const dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const p = join(base, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'])
    if (existsSync(p)) return p;
  throw new Error('No Chromium found. Set CHROME=/path/to/chrome or run: npx -y playwright@1.56.1 install chromium');
}

/* ---------------- CDP over --remote-debugging-pipe ---------------- */
class CDP {
  constructor(proc) {
    this.w = proc.stdio[3]; this.r = proc.stdio[4];
    this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.buf = '';
    this.r.on('data', (chunk) => {
      this.buf += chunk.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\0')) >= 0) {
        const msg = JSON.parse(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1);
        if (msg.id && this.pending.has(msg.id)) {
          const { res, rej, method } = this.pending.get(msg.id); this.pending.delete(msg.id);
          msg.error ? rej(new Error(method + ': ' + msg.error.message)) : res(msg.result);
        } else if (msg.method) (this.handlers.get(msg.method) || []).forEach((h) => h(msg.params, msg.sessionId));
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    if (process.env.CDP_TRACE) console.log('  > ' + method);
    this.w.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    return new Promise((res, rej) => this.pending.set(id, { res, rej, method }));
  }
  on(method, fn) { (this.handlers.get(method) || this.handlers.set(method, []).get(method)).push(fn); }
}

/* ---------------- run ---------------- */
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

let server = null, chrome = null, profile = null;
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
  const exe = findChrome();
  console.log('browser:', exe);
  console.log('url:    ', url);
  profile = mkdtempSync(join(tmpdir(), 'sw-smoke-'));
  chrome = spawn(exe, [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1440,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  chrome.stderr.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(d); });
  const cdp = new CDP(chrome);

  // The browser answers before it is ready to open tabs; wait for its first page.
  // Then open a fresh tab directly at the URL: navigating an existing tab into
  // a COOP/COEP page swaps its process and the old session never gets a reply.
  for (let i = 0; i < 100; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    if (targetInfos.some((t) => t.type === 'page')) break;
    await sleep(100);
  }
  const { targetId } = await cdp.send('Target.createTarget', { url, newWindow: false });
  const { sessionId: S } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [];
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (p.type === 'error') errors.push(text);
    if (process.env.VERBOSE || p.type === 'error' || p.type === 'warning') console.log(`  [console.${p.type}] ${text}`);
  });
  cdp.on('Runtime.exceptionThrown', (p) => { const t = p.exceptionDetails.exception?.description || p.exceptionDetails.text; errors.push(t); console.log('  [exception]', t); });
  await cdp.send('Runtime.enable', {}, S);
  await cdp.send('Page.enable', {}, S);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }, S);

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) throw new Error('eval failed: ' + expr + '\n' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const waitFor = async (expr, ms = 10000) => {
    const t0 = Date.now();
    for (;;) { const v = await evaluate(expr).catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); }
  };
  const mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra }, S);
  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, S);
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
    console.log('  saved', join('build/smoke', name));
  };

  await waitFor('document.readyState === "complete" && !!window.swDebug');

  check('crossOriginIsolated', await evaluate('crossOriginIsolated') === true);
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
  await mouse('mousePressed', pad.x, pad.y);
  await sleep(250);
  const led = await evaluate('swDebug.noteLed(68)');
  check('pad press reaches engine (LED lit)', !!led, `note 68 LED = ${JSON.stringify(led)}`);
  if (engine === 'mock') check('pad LED bright while held', led[0] === 1, `palette ${led[0]}`);
  await shot('panel-pad.png');
  await mouse('mouseReleased', pad.x, pad.y);

  // Turn knob 2 (cutoff): drag up 90 px.
  const disp0 = await evaluate('Array.from(swDebug.panel.oledBits).join(",")');
  const kn = await evaluate('swDebug.center("knob-2")');
  const sent0 = await evaluate('swDebug.sent()');
  await mouse('mouseMoved', kn.x, kn.y);
  await mouse('mousePressed', kn.x, kn.y);
  for (let i = 1; i <= 15; i++) { await mouse('mouseMoved', kn.x, kn.y - i * 6, { buttons: 1 }); await sleep(16); }
  await sleep(150);
  const touched = await evaluate('swDebug.ccLed(72)');
  await mouse('mouseReleased', kn.x, kn.y - 90);
  const sent1 = await evaluate('swDebug.sent()');
  check('knob drag sends relative CCs', sent1.cc > sent0.cc, `${sent1.cc - sent0.cc} CC messages, last ${sent1.last}`);
  if (engine === 'mock') check('knob touch lights knob LED', touched && touched[0] > 0, JSON.stringify(touched));
  await sleep(300);
  const disp1 = await evaluate('Array.from(swDebug.panel.oledBits).join(",")');
  check('OLED updates after knob turn', disp0 !== disp1);

  // Wheel over the master knob + keyboard pad.
  const mk = await evaluate('swDebug.center("master")');
  const s2 = await evaluate('swDebug.sent().cc');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mk.x, y: mk.y, deltaX: 0, deltaY: -120 }, S);
  await sleep(100);
  check('wheel over knob sends CC', (await evaluate('swDebug.sent().cc')) > s2);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68 }, S);
  await sleep(120);
  const kLed = await evaluate('swDebug.noteLed(72)');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68 }, S);
  if (engine === 'mock') check('keyboard "d" plays pad 5 (note 72)', kLed && kLed[0] === 1, JSON.stringify(kLed));

  await sleep(800);
  const c2 = await evaluate('swDebug.ctl()');
  check('no new underruns during interaction', ((c2[3] - c1[3]) >>> 0) <= 2, `+${(c2[3] - c1[3]) >>> 0}`);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await shot('panel.png');

  // Phone-width layout.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, S);
  await sleep(400);
  const fits = await evaluate('(() => { const r = document.getElementById("device").getBoundingClientRect(); return r.right <= innerWidth && r.left >= 0 && document.documentElement.scrollWidth <= innerWidth; })()');
  check('fits phone width (390 px)', fits);
  await shot('panel-phone.png');
}

const WATCHDOG = setTimeout(() => { console.error('smoke: timed out after 90 s'); results.push({ ok: false }); chrome?.kill(); server?.kill(); process.exit(2); }, 90000);
main()
  .catch((e) => { console.error(e); results.push({ ok: false }); })
  .finally(() => {
    try { chrome?.kill(); } catch {}
    try { server?.kill(); } catch {}
    setTimeout(() => { try { profile && rmSync(profile, { recursive: true, force: true }); } catch {} }, 300);
    clearTimeout(WATCHDOG);
    const failed = results.filter((r) => !r.ok).length;
    console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${results.length} checks passed`);
    setTimeout(() => process.exit(failed ? 1 : 0), 400);
  });
