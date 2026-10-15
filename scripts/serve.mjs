#!/usr/bin/env node
// Static server for web/ with the cross-origin isolation headers that
// SharedArrayBuffer / Emscripten pthreads / the audio ring need.
//
//   node scripts/serve.mjs            # http://localhost:8790
//   PORT=9000 node scripts/serve.mjs
//
// Node stdlib only. No caching: every response is `no-store` so a rebuilt
// engine (web/engine/*) is picked up on reload.

import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import { join, normalize, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../web/', import.meta.url)));
const PORT = Number(process.env.PORT) || 8790;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
};

async function resolveFile(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); } catch { return null; }
  const abs = normalize(join(ROOT, p));
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;   // traversal
  try {
    const s = await stat(abs);
    if (s.isDirectory()) {
      const idx = join(abs, 'index.html');
      const si = await stat(idx).catch(() => null);
      return si?.isFile() ? { path: idx, size: si.size } : null;
    }
    return s.isFile() ? { path: abs, size: s.size } : null;
  } catch { return null; }
}

const server = createServer(async (req, res) => {
  const t0 = Date.now();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...ISOLATION, Allow: 'GET, HEAD' }).end();
    return;
  }
  const f = await resolveFile(req.url || '/');
  if (!f) {
    res.writeHead(404, { ...ISOLATION, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : 'not found\n');
    if (!process.env.QUIET) console.log(`404 ${req.method} ${req.url}`);
    return;
  }
  const type = MIME[extname(f.path).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { ...ISOLATION, 'Content-Type': type, 'Content-Length': f.size });
  if (req.method === 'HEAD') { res.end(); return; }
  try { res.end(await readFile(f.path)); }
  catch (e) { res.destroy(e); }
  if (process.env.VERBOSE) console.log(`200 ${req.url} ${Date.now() - t0}ms`);
});

server.listen(PORT, HOST, () => {
  console.log(`schwung-wasm: serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}/  (COOP/COEP isolated, no-store)`);
});
