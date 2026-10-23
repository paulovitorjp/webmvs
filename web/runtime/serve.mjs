#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// serve.mjs -- static test server for web/runtime. Loopback only.
// Usage: node serve.mjs --root <dir> --port 8201 [--headers coi|none]
//   coi  (default): COOP same-origin, COEP require-corp, CORP same-origin (like Cloudflare _headers)
//   none: no isolation headers (like GitHub Pages; the page then needs coi-serviceworker.js)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('root', '.'));
const PORT = Number(arg('port', 8201));
const HEADERS = arg('headers', 'coi');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json', '.txt': 'text/plain', '.rc': 'text/plain',
  '.cnf': 'text/plain', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = path.normalize(path.join(ROOT, decodeURIComponent(u.pathname)));
  if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.stat(p, (err, st) => {
    if (!err && st.isDirectory()) { p = path.join(p, 'index.html'); try { st = fs.statSync(p); err = null; } catch (e) { err = e; } }
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); log(req, 404, 0); return; }
    const h = { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Content-Length': st.size,
      'Cache-Control': 'no-cache' };
    if (HEADERS === 'coi') Object.assign(h, { 'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' });
    res.writeHead(200, h);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(p).pipe(res);
    log(req, 200, st.size);
  });
});
function log(req, code, n) { if (process.env.SERVE_LOG) console.log(`${new Date().toISOString()} ${code} ${n} ${req.url}`); }
server.listen(PORT, '127.0.0.1', () => console.log(`serve.mjs: http://127.0.0.1:${PORT}/ root=${ROOT} headers=${HEADERS}`));
