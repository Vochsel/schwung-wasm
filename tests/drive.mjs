// Drive the real engine headless with a list of surface actions and save the
// OLED after each one. Usage: node tests/drive.mjs "shift+vol+track1" "wait 500" "jog +1" "click" ...
// Actions: press <cc>, note <n> [vel], release <cc>, jog <±n>, knob <1-9> <±n>, click, back,
//          shift+vol+track<N>, pad <row> <col> [ms], wait <ms>, shot <name>
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { oledPng } from './oled-png.mjs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(ROOT, 'build/tools/package.json'))('playwright');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
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
const browser = await chromium.launch({ executablePath: process.env.CHROME || shell() });
const page = await browser.newPage();
const lines = [];
page.on('console', m => lines.push(m.text()));
page.on('pageerror', e => lines.push('PAGEERROR ' + e.message));
await page.goto(`http://localhost:${srv.address().port}/tests/engine.html?log`);
const wait = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 80 && !(await page.evaluate(() => window.ready).catch(() => false)); i++) await wait(250);
await wait(+(process.env.BOOT_MS || 5000));
const midi = (a, b, c) => page.evaluate(([a, b, c]) => window.M._sw_midi_in(0, a, b, c), [a, b, c]);
const OUT = join(ROOT, 'build/smoke/drive'); await mkdir(OUT, { recursive: true });
let n = 0;
const shot = async name => {
  await wait(120);
  const f = await page.evaluate(() => window.oled());
  const file = join(OUT, `${String(n++).padStart(2, '0')}-${name.replace(/[^a-z0-9+-]+/gi, '_')}.png`);
  await writeFile(file, oledPng(f, 3));
  return file;
};
const rel = v => v >= 0 ? v : 128 + v;
for (const step of process.argv.slice(2)) {
  const [cmd, ...a] = step.split(' ');
  const m = cmd.match(/^shift\+vol\+track(\d)$/);
  if (m) { await midi(0xB0, 49, 127); await midi(0x90, 8, 127); await wait(60); await midi(0xB0, 44 - +m[1], 127); await wait(60); await midi(0xB0, 44 - +m[1], 0); await midi(0x90, 8, 0); await midi(0xB0, 49, 0); }
  else if (cmd === 'press') { await midi(0xB0, +a[0], 127); await wait(60); await midi(0xB0, +a[0], 0); }
  else if (cmd === 'hold') await midi(0xB0, +a[0], 127);
  else if (cmd === 'release') await midi(0xB0, +a[0], 0);
  else if (cmd === 'note') await midi(0x90, +a[0], +(a[1] || 100));
  else if (cmd === 'noteoff') await midi(0x80, +a[0], 0);
  else if (cmd === 'jog') { const d = +a[0]; for (let i = 0; i < Math.abs(d); i++) { await midi(0xB0, 14, d > 0 ? 1 : 127); await wait(40); } }
  else if (cmd === 'knob') { const k = +a[0], d = +a[1]; await midi(0x90, k - 1, 127); for (let i = 0; i < Math.abs(d); i++) { await midi(0xB0, 70 + k, d > 0 ? 1 : 127); await wait(15); } await midi(0x90, k - 1, 0); }
  else if (cmd === 'click') { await midi(0xB0, 3, 127); await wait(60); await midi(0xB0, 3, 0); }
  else if (cmd === 'back') { await midi(0xB0, 51, 127); await wait(60); await midi(0xB0, 51, 0); }
  else if (cmd === 'pad') { const p = 68 + (3 - +a[0]) * 8 + +a[1]; await page.evaluate(() => window.resetPeak()); await midi(0x90, p, 110); await wait(+(a[2] || 600)); const s = await page.evaluate(() => window.stats()); await midi(0x80, p, 0); console.log(`pad ${a[0]},${a[1]} peak=${s.peak}`); }
  else if (cmd === 'ext') { await page.evaluate(() => window.resetPeak()); await page.evaluate(([n]) => window.M._sw_midi_in(2, 0x90, n, 110), [+a[0]]); await wait(+(a[1] || 600)); const s = await page.evaluate(() => window.stats()); await page.evaluate(([n]) => window.M._sw_midi_in(2, 0x80, n, 0), [+a[0]]); console.log(`ext ${a[0]} peak=${s.peak} cpeak=${await page.evaluate(() => window.M._sw_stat(8))}`); }
  else if (cmd === 'wait') await wait(+a[0]);
  else if (cmd === 'stats') console.log(JSON.stringify(await page.evaluate(() => window.stats())));
  if (cmd !== 'wait' && cmd !== 'stats') console.log(step, '→', await shot(step));
}
await writeFile(join(ROOT, 'build/smoke/drive-console.txt'), lines.join('\n'));
await writeFile(join(ROOT, 'build/smoke/debug.log'), await page.evaluate(() => window.readLog()));
await writeFile(join(ROOT, 'build/smoke/midi_out.log'), await page.evaluate(() => window.readFile('/data/UserData/schwung/shadow_midi_out.log')));
const errs = lines.filter(l => /PAGEERROR|abort|exception|failed/i.test(l));
if (errs.length) console.log('errors:\n' + errs.slice(0, 20).join('\n'));
await browser.close(); srv.close();
