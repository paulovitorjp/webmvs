#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// pages-emu.mjs -- static test server that behaves like GitHub Pages or Cloudflare Pages
// for the things that matter to this site. 127.0.0.1 only, HTTP/1.1, no TLS.
//
// Usage: node scripts/pages-emu.mjs --root <dist> --port <n> --profile github|cloudflare
//          [--throttle <down kbit/s>,<latency ms>] [--log <file.jsonl>] [--br-quality <0-11>]
//
// --profile github (measured on pages.github.com and mdn.github.io, 2026-10-20, see docs/DEPLOY.md):
//   * no custom headers: no COOP/COEP/CORP (the page needs coi-serviceworker.js), _headers is a plain file
//   * Cache-Control: max-age=600 (+ Expires) on every file, weak ETag + Last-Modified, 304 on revalidation
//   * Content-Encoding: gzip only (level 5, like GitHub's output sizes), never br; also for application/wasm
//     and application/octet-stream (GitHub gzips both, so the DASD chunks are gzipped too); files < 1 KiB plain
//   * Access-Control-Allow-Origin: *, Vary: Accept-Encoding; 404 -> 404.html with status 404
//   * Range is ignored (200 + whole file). (Real GitHub Pages answers Range with 206 on the gzip body; this
//     site never sends Range, so it does not matter.)
// --profile cloudflare (Cloudflare Pages docs + developers.cloudflare.com responses):
//   * headers from <root>/_headers (path rules with one splat '*'; all matching rules apply, the same
//     header from 2 rules is joined with ", ")
//   * default Cache-Control: public, max-age=0, must-revalidate; strong ETag; 304 on revalidation
//   * Content-Encoding: br (else gzip) for text/*, JS, JSON, wasm, SVG, XML; octet-stream is sent as is
//   * /index.html -> 308 to /; unknown path -> 404.html (404) if it exists, else /index.html (200, SPA mode)
// --throttle 9000,60: all responses of this server share one 9000 kbit/s token bucket, and each response
//   starts 60 ms after the request (latency; HTTP/1.1, so the browser uses at most 6 connections).
// --base /webmvs/: serve the site under this path, like a GitHub Pages project site
//   (https://<user>.github.io/<repo>/); /webmvs -> 301 /webmvs/, other paths 404.
// --log: one JSON line per response: { t0, t1 (epoch ms), status, path, enc, wire (body bytes sent), size }.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('root', '.'));
const PORT = Number(arg('port', 8401));
const HOST = '127.0.0.1';
const PROFILE = arg('profile', 'github');
if (!['github', 'cloudflare'].includes(PROFILE)) { console.error('--profile github|cloudflare'); process.exit(2); }
const BRQ = Number(arg('br-quality', 4));   // 4: like on-the-fly edge compression (conservative); 11 = the best case
const [TKBIT, TLAT] = (arg('throttle', '') || '0,0').split(',').map(Number);
const LOG = arg('log', null);
const BASE = arg('base', '/');
if (!BASE.startsWith('/') || !BASE.endsWith('/')) { console.error('--base must start and end with /'); process.exit(2); }
const logf = LOG ? fs.createWriteStream(LOG, { flags: 'a' }) : null;

const TYPES = {   // GitHub Pages and Cloudflare Pages types for the files of this site
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.patch': 'text/x-diff; charset=utf-8', '.c': 'text/x-c; charset=utf-8', '.h': 'text/x-c; charset=utf-8', '.sh': 'application/x-sh',
};
const typeOf = (p) => TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream';
const ghCompress = (type, size) => size >= 1024 && !/^image\/(png|jpeg|gif|webp)/.test(type);
const cfCompress = (type) => /^(text\/|application\/(javascript|json|wasm|xml|x-sh)|image\/svg)/.test(type);

// _headers (Cloudflare Pages format)
let rules = [];
function loadHeaders() {
  rules = [];
  let cur = null;
  let txt = ''; try { txt = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8'); } catch { return; }
  for (const line of txt.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { cur = { pat: line.trim(), h: [] }; rules.push(cur); continue; }
    const m = /^\s+([^:]+):\s*(.*)$/.exec(line); if (m && cur) cur.h.push([m[1].trim(), m[2].trim()]);
  }
  for (const r of rules) {
    const esc = r.pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('*', '.*');
    r.re = new RegExp(`^${esc}$`);
  }
}
function cfHeaders(urlPath) {
  const out = {};
  for (const r of rules) if (r.re.test(urlPath)) for (const [k, v] of r.h) out[k] = out[k] ? `${out[k]}, ${v}` : v;
  return out;
}
if (PROFILE === 'cloudflare') loadHeaders();

// compressed representations, cached per file + mtime
const zcache = new Map();
function encoded(p, st, enc) {
  const k = `${p}|${enc}`; let c = zcache.get(k);
  if (!c || c.mtimeMs !== st.mtimeMs) {
    const raw = fs.readFileSync(p);
    const buf = enc === 'gzip' ? zlib.gzipSync(raw, { level: 5 })
      : zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BRQ, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    c = { mtimeMs: st.mtimeMs, buf }; zcache.set(k, c);
  }
  return c.buf;
}
const etags = new Map();
function strongTag(p, st) {
  const k = p; let c = etags.get(k);
  if (!c || c.mtimeMs !== st.mtimeMs) { c = { mtimeMs: st.mtimeMs, tag: `"${crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex')}"` }; etags.set(k, c); }
  return c.tag;
}

// throttle: one token bucket for the whole server
let tokens = 0, lastFill = Date.now();
const rate = TKBIT * 1000 / 8;     // bytes per second
const waiters = [];
function fill() { const n = Date.now(); tokens = Math.min(tokens + (n - lastFill) / 1000 * rate, rate * 0.05); lastFill = n; }
async function take(n) {
  if (!rate) return;
  for (;;) { fill(); if (tokens >= Math.min(n, rate * 0.05)) { tokens -= n; return; } await new Promise((r) => setTimeout(r, 5)); }
}
async function sendBody(res, buf) {
  if (!rate) { res.end(buf); return; }
  const CH = 16384;
  for (let o = 0; o < buf.length; o += CH) {
    const part = buf.subarray(o, Math.min(o + CH, buf.length));
    await take(part.length);
    if (!res.write(part)) await new Promise((r) => res.once('drain', r));
    if (res.destroyed) return;
  }
  res.end();
}

function log(e) { if (logf) logf.write(`${JSON.stringify(e)}\n`); }

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const done = (status, enc, wire, size, p) => log({ t0, t1: Date.now(), status, path: p, enc, wire, size, ae: req.headers['accept-encoding'] || '' });
  if (TLAT) await new Promise((r) => setTimeout(r, TLAT));
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return done(400, '', 0, 0, req.url); }
  if (BASE !== '/') {
    if (`${urlPath}/` === BASE) { res.writeHead(301, { Location: BASE }).end(); return done(301, '', 0, 0, urlPath); }
    if (!urlPath.startsWith(BASE)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found\n'); return done(404, '', 0, 0, urlPath); }
    urlPath = urlPath.slice(BASE.length - 1);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return done(405, '', 0, 0, urlPath); }
  let p = path.join(ROOT, path.normalize(urlPath));
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return done(403, '', 0, 0, urlPath); }
  if (PROFILE === 'cloudflare' && /\/index\.html$/.test(urlPath)) {
    res.writeHead(308, { Location: urlPath.replace(/index\.html$/, '') }).end(); return done(308, '', 0, 0, urlPath);
  }
  let st = null, status = 200;
  try {
    st = fs.statSync(p);
    if (st.isDirectory()) {
      if (!urlPath.endsWith('/')) { res.writeHead(301, { Location: `${urlPath}/` }).end(); return done(301, '', 0, 0, urlPath); }
      p = path.join(p, 'index.html'); st = fs.statSync(p);
    }
  } catch { st = null; }
  if (!st || !st.isFile()) {
    const nf = path.join(ROOT, '404.html');
    if (fs.existsSync(nf)) { p = nf; status = 404; }
    else if (PROFILE === 'cloudflare') { p = path.join(ROOT, 'index.html'); status = 200; }
    else { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found\n'); return done(404, '', 0, 0, urlPath); }
    st = fs.statSync(p);
  }
  const type = typeOf(p);
  const h = { 'Content-Type': type, 'Last-Modified': st.mtime.toUTCString(), Vary: 'Accept-Encoding' };
  const ae = req.headers['accept-encoding'] || '';
  let enc = '';
  if (PROFILE === 'github') {
    Object.assign(h, { 'Cache-Control': 'max-age=600', Expires: new Date(Date.now() + 600000).toUTCString(), 'Access-Control-Allow-Origin': '*' });
    if (/\bgzip\b/.test(ae) && ghCompress(type, st.size)) enc = 'gzip';
    h.ETag = `W/"${Math.floor(st.mtimeMs / 1000).toString(16)}-${st.size.toString(16)}"`;
  } else {
    Object.assign(h, cfHeaders(urlPath));
    h['Cache-Control'] ??= 'public, max-age=0, must-revalidate';
    if (cfCompress(type)) enc = /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : '';
    h.ETag = strongTag(p, st);
  }
  if (status === 200) {
    const inm = req.headers['if-none-match'], ims = req.headers['if-modified-since'];
    const hit = inm ? inm.split(/\s*,\s*/).some((t) => t.replace(/^W\//, '') === h.ETag.replace(/^W\//, ''))
      : ims ? Math.floor(st.mtimeMs / 1000) <= Math.floor(Date.parse(ims) / 1000) : false;
    if (hit) {
      const h304 = { ETag: h.ETag, 'Cache-Control': h['Cache-Control'], Vary: 'Accept-Encoding' };
      if (PROFILE === 'cloudflare') Object.assign(h304, cfHeaders(urlPath));
      res.writeHead(304, h304).end(); return done(304, '', 0, st.size, urlPath);
    }
  }
  const body = enc ? encoded(p, st, enc) : fs.readFileSync(p);
  if (enc) h['Content-Encoding'] = enc;
  h['Content-Length'] = body.length;
  res.writeHead(status, h);
  if (req.method === 'HEAD') { res.end(); return done(status, enc, 0, st.size, urlPath); }
  res.on('close', () => done(status, enc, res.writableFinished ? body.length : -1, st.size, urlPath));
  await sendBody(res, body);
});
server.keepAliveTimeout = 30000;
server.listen(PORT, HOST, () => console.log(`pages-emu: http://${HOST}:${PORT}/ root=${ROOT} profile=${PROFILE} base=${BASE}${rate ? ` throttle=${TKBIT}kbit/s+${TLAT}ms` : ''} br-quality=${BRQ}`));
