// The page's extras against the real engine: metronome, mic → line-in, WAV
// recording. Usage: node tests/page-features.mjs [url]
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(ROOT, 'build/tools/package.json'))('playwright');
function shell() {
  const c = join(homedir(), 'Library/Caches/ms-playwright');
  for (const d of readdirSync(c).filter(d => d.startsWith('chromium_headless_shell')).sort().reverse())
    for (const sub of readdirSync(join(c, d))) { const e = join(c, d, sub, sub.startsWith('chrome-headless-shell') ? 'chrome-headless-shell' : 'headless_shell'); if (existsSync(e)) return e; }
}
const url = process.argv[2] || 'http://localhost:8790/';
const browser = await chromium.launch({ executablePath: process.env.CHROME || shell(), args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const ctx = await browser.newContext({ acceptDownloads: true, permissions: ['microphone'] });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(url + '?engine=real');
await page.click('#powerBtn');
await page.waitForFunction(() => window.swDebug?.started, null, { timeout: 60000 });
const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(6000);
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
const peak = async ms => { await page.evaluate(() => window.swDebug.stat(8)); await wait(ms); return page.evaluate(() => window.swDebug.stat(8)); };
// metronome: click on, play, hear it
await page.click('#clickBtn'); await page.keyboard.press('Space');
const p1 = await peak(1500); ok('metronome audible while playing', p1 > 1000, 'peak ' + p1);
await page.keyboard.press('Space'); await page.click('#clickBtn');
// mic: fake device sends a tone into line-in; load linein into slot 1 via the UI eval door
await page.click('#micBtn'); await wait(500);
const in0 = await page.evaluate(() => window.swDebug.inBlocks()); await wait(1000);
const in1 = await page.evaluate(() => window.swDebug.inBlocks());
ok('mic audio reaches the engine line-in', in1 - in0 > 200, `${in1 - in0} blocks/s`);
ok('mic button turned on', await page.evaluate(() => document.getElementById('micBtn').classList.contains('on')));
// WAV recording
const dl = page.waitForEvent('download', { timeout: 20000 });
await page.click('#recBtn'); await wait(1500); await page.click('#recBtn');
const d = await dl; const path = await d.path(); const { statSync } = await import('node:fs');
const size = statSync(path).size;
ok('Record WAV downloads a file', size > 44 + 44100 * 2, `${d.suggestedFilename()} ${size} bytes`);
ok('no page errors', errs.length === 0, errs.join(' | '));
await browser.close();
