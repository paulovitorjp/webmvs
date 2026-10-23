#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// static-serve.mjs -- tiny static server for the dev bundle (web/dist-dev). 127.0.0.1 only.
// Usage: node static-serve.mjs --root <dir> --port <n> [--headers coi|none] [--host 127.0.0.1]
//   --headers coi  : COOP same-origin, COEP require-corp, CORP same-origin on every response
//                    (like Cloudflare Pages with the bundle's _headers file).
//   --headers none : no custom headers at all (like GitHub Pages); the page then relies on
//                    coi-serviceworker.js for cross-origin isolation.
// Both modes: correct MIME types (application/wasm), ETag/Last-Modified with 304 replies, so a
// reload through a port forward does not download the 83 MB of DASD chunks again, and a
// precompressed "<file>.br" is sent with Content-Encoding: br when the client accepts it.
//   --encoding br (default): as above. --encoding gzip: the .br files are ignored and text/JS/JSON/CSS/wasm responses are gzipped on the
//   fly when the client accepts gzip (DASD chunks and other octet-stream files are sent as they are).
//   --encoding identity: no compression at all.
// Env SERVE_LOG=1 prints one line per request.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('root', '.'));
const PORT = Number(arg('port', 8231));
const HOST = arg('host', '127.0.0.1');
const MODE = arg('headers', 'coi');
if (!['coi', 'none'].includes(MODE)) { console.error('--headers must be coi or none'); process.exit(2); }
const ENC = arg('encoding', 'br');
if (!['br', 'gzip', 'identity'].includes(ENC)) { console.error('--encoding must be br, gzip or identity'); process.exit(2); }
const GZ_TYPES = /^(text\/|application\/(json|wasm|javascript))/;
const gzCache = new Map();   // path -> { mtimeMs, buf }
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.rc': 'text/plain', '.cnf': 'text/plain',
  '.bdf': 'text/plain', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const ISO = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin' };

function send(req, res, code, headers, body) {
  if (MODE === 'coi') Object.assign(headers, ISO);
  res.writeHead(code, headers);
  res.end(body);
  log(req, code, 0);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { send(req, res, 405, { Allow: 'GET, HEAD' }); return; }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { send(req, res, 400, {}); return; }
  let p = path.join(ROOT, path.normalize(rel));
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) { send(req, res, 403, {}); return; }
  let st;
  try { st = fs.statSync(p); if (st.isDirectory()) { p = path.join(p, 'index.html'); st = fs.statSync(p); } } catch { st = null; }
  if (!st || !st.isFile()) { send(req, res, 404, { 'Content-Type': 'text/plain' }, 'not found\n'); return; }
  const h = { 'Content-Type': TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache',
    'Last-Modified': st.mtime.toUTCString(), Vary: 'Accept-Encoding' };
  let file = p, size = st.size, tag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  let gz = null;
  if (ENC === 'gzip' && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && GZ_TYPES.test(h['Content-Type'])) {
    let c = gzCache.get(p);
    if (!c || c.mtimeMs !== st.mtimeMs) { c = { mtimeMs: st.mtimeMs, buf: zlib.gzipSync(fs.readFileSync(p), { level: 6 }) }; gzCache.set(p, c); }
    gz = c.buf; size = gz.length; h['Content-Encoding'] = 'gzip'; tag = `W/"${tag.slice(1, -1)}-gz"`;
  }
  if (ENC === 'br' && /\bbr\b/.test(req.headers['accept-encoding'] || '')) {
    try { const b = fs.statSync(`${p}.br`); if (b.isFile() && b.mtimeMs >= st.mtimeMs) { file = `${p}.br`; size = b.size; h['Content-Encoding'] = 'br'; tag = `"${tag.slice(1, -1)}-br"`; } } catch { /* no .br */ }
  }
  h.ETag = tag;
  if (req.headers['if-none-match'] === tag) { send(req, res, 304, { ETag: tag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' }); return; }
  h['Content-Length'] = size;
  if (MODE === 'coi') Object.assign(h, ISO);
  res.writeHead(200, h);
  if (req.method === 'HEAD') { res.end(); log(req, 200, 0); return; }
  if (gz) res.end(gz);
  else fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  log(req, 200, size);
});
function log(req, code, n) { if (process.env.SERVE_LOG) console.log(`${new Date().toISOString()} ${code} ${n} ${req.url}`); }
server.listen(PORT, HOST, () => console.log(`static-serve: http://${HOST}:${PORT}/ root=${ROOT} headers=${MODE} encoding=${ENC}`));
