// Headless boot test for the real engine: serve the repo with COOP/COEP, open
// tests/engine.html, let Schwung boot, press things, and print what happened.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { oledPng } from './oled-png.mjs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'build/tools/package.json'));
const { chromium } = require('playwright');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.json': 'application/json' };
const srv = createServer(async (req, res) => {
  const p = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try {
    const body = await readFile(p);
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = srv.address().port;
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
// Use whatever headless shell is already in Playwright's cache, if the pinned one isn't.
function shell() {
  const c = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(c)) return undefined;
  for (const d of readdirSync(c).filter(d => d.startsWith('chromium_headless_shell')).sort().reverse())
    for (const sub of readdirSync(join(c, d))) {
      const exe = join(c, d, sub, sub.startsWith('chrome-headless-shell') ? 'chrome-headless-shell' : 'headless_shell');
      if (existsSync(exe)) return exe;
    }
}
const browser = await chromium.launch({ executablePath: process.env.CHROME || shell() });
const page = await browser.newPage();
const lines = [];
page.on('console', m => lines.push(m.text()));
page.on('pageerror', e => lines.push('PAGEERROR ' + e.message));
await page.goto(`http://localhost:${port}/tests/engine.html`);
const wait = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 60 && !(await page.evaluate(() => window.ready).catch(() => false)); i++) await wait(250);
if (!(await page.evaluate(() => window.ready).catch(() => false))) {
  console.log('engine did not come up:\n' + lines.slice(-40).join('\n'));
  await browser.close(); srv.close(); process.exit(1);
}
const secs = +(process.env.BOOT_SECS || 8);
await wait(secs * 1000);
const s1 = await page.evaluate(() => window.stats());
console.log('after boot:', JSON.stringify(s1));
const midi = (c, a, b, d) => page.evaluate(([c, a, b, d]) => window.M._sw_midi_in(c, a, b, d), [c, a, b, d]);
await page.evaluate(() => window.resetPeak());
for (const n of [68, 72, 75]) await midi(0, 0x90, n, 110);
await wait(1500);
const s2 = await page.evaluate(() => window.stats());
console.log('pads held:', JSON.stringify(s2));
for (const n of [68, 72, 75]) await midi(0, 0x80, n, 0);
const oled = await page.evaluate(() => window.oled());
await mkdir(join(ROOT, 'build/smoke'), { recursive: true });
await writeFile(join(ROOT, 'build/smoke/oled.png'), oledPng(oled));
const rows = [];
for (let y = 0; y < 64; y += 2) { let r = ''; for (let x = 0; x < 128; x++) r += (oled[(y >> 3) * 128 + x] >> (y & 7)) & 1 ? '#' : ' '; rows.push(r.trimEnd()); }
console.log(rows.join('\n'));
await mkdir(join(ROOT, 'build/smoke'), { recursive: true });
await writeFile(join(ROOT, 'build/smoke/engine-console.txt'), lines.join('\n'));
console.log(`console: ${lines.length} lines → build/smoke/engine-console.txt`);
console.log(lines.filter(l => /error|abort|PAGEERROR|exception|fail/i.test(l)).slice(0, 30).join('\n'));
await browser.close(); srv.close();
