#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// node-harness.mjs: run the Emscripten Hercules under Node and serve its 3270 port over real TCP.
// A node:net server on 127.0.0.1:3270 (main Node thread) gives each
// TCP client a wasmsock connection: hw_term_open("") on connect, hw_term_input for client bytes,
// hw_term_read drained on a timer, hw_term_close on disconnect. TN3270 negotiation (TTYPE, @devnum)
// is done by the TCP client itself, so s3270 / tso-smoke.sh / websockify work unchanged.
//
// Usage:  node scripts/node-harness.mjs <hercules.js|hercules.mjs> [hercules args...]
//   e.g.  cd <run dir> && node ~/webmvs/scripts/node-harness.mjs ~/build/wasm/hercules.js \
//             -f ~/webmvs/conf/web.cnf -r ~/webmvs/conf/web.rc
// Env:    HARNESS_HOST (127.0.0.1; loopback only), HARNESS_PORT (3270), HARNESS_POLL_MS (4),
//         HARNESS_TTYPE (string passed to hw_term_open, informational), HARNESS_DEBUG=1
//
// Module requirements (link flags for wasm-core):
//   -sEXPORTED_FUNCTIONS=_main,_hw_term_open,_hw_term_input,_hw_term_read,_hw_term_close,
//                        _hw_term_state,_hw_term_out_seq,_hw_term_buf,_hw_term_buf_size
//   -sEXPORTED_RUNTIME_METHODS=HEAPU8   (the harness reads/writes the heap directly)
// Works with a plain build (callbacks attached to the object that require() returns) and with -sMODULARIZE
// (CommonJS factory or -sEXPORT_ES6 default export).
// The harness never calls malloc: all transfers go through the static hw_term_buf() buffer.
// Every call into C here is lock-free (wasmsock.c), as required on the main thread.

import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [, , modPath, ...hercArgs] = process.argv;
if (!modPath) {
  console.error('usage: node node-harness.mjs <hercules.js> [hercules args...]');
  process.exit(2);
}
const HOST = process.env.HARNESS_HOST || '127.0.0.1';
const PORT = Number(process.env.HARNESS_PORT || 3270);
const POLL_MS = Number(process.env.HARNESS_POLL_MS || 4);
const TTYPE = process.env.HARNESS_TTYPE || '';
const DEBUG = !!process.env.HARNESS_DEBUG;
if (!/^127\./.test(HOST) && HOST !== 'localhost') {
  console.error(`node-harness: refusing non-loopback HARNESS_HOST=${HOST}`);
  process.exit(2);
}
const log = (...a) => console.error('node-harness:', ...a);
const dbg = (...a) => { if (DEBUG) log(...a); };

let M;                       // the Emscripten Module, once the runtime is ready
let BUF = 0, BUFSZ = 0;      // static exchange buffer in the wasm heap
const conns = new Map();     // id -> { sock, pending: Buffer[], paused, closing }
let lastSeq = -1;
let server;

const heap = () => M.HEAPU8;

function termOpen(ttype) {
  const b = Buffer.from(ttype, 'latin1').subarray(0, 47);
  heap().set(b, BUF);
  heap()[BUF + b.length] = 0;
  return M._hw_term_open(BUF);
}

// Push queued client bytes into the input ring. Returns false if Hercules closed.
function pushInput(id, c) {
  while (c.pending.length) {
    const chunk = c.pending[0];
    const n = Math.min(chunk.length, BUFSZ);
    heap().set(chunk.subarray(0, n), BUF);
    const k = M._hw_term_input(id, BUF, n);
    if (k < 0) return false;
    if (k === 0) break;                    // ring full: retry on the next tick
    if (k === chunk.length) c.pending.shift();
    else c.pending[0] = chunk.subarray(k);
  }
  if (c.paused && c.pending.length === 0) { c.paused = false; c.sock.resume(); }
  return true;
}

// Drain Hercules output to the TCP client. Returns false at Hercules EOF.
function drainOutput(id, c) {
  for (;;) {
    if (c.sock.writableNeedDrain) return true;   // TCP backpressure: wait for 'drain'
    const n = M._hw_term_read(id, BUF, BUFSZ);
    if (n === -2 || n === -1) return false;
    if (n === 0) return true;
    c.sock.write(Buffer.from(heap().subarray(BUF, BUF + n)));   // copy out of the SAB
  }
}

function finish(id, c, why) {
  if (c.closing) return;
  c.closing = true;
  dbg(`id ${id}: ${why}`);
  M._hw_term_close(id);
  conns.delete(id);
  c.sock.end();
}

function tick() {
  const seq = M._hw_term_out_seq() >>> 0;
  const seqChanged = seq !== lastSeq;
  lastSeq = seq;
  for (const [id, c] of conns) {
    if (c.pending.length && !pushInput(id, c)) { finish(id, c, 'Hercules closed (input)'); continue; }
    if ((seqChanged || c.wantDrain) && !drainOutput(id, c)) { finish(id, c, 'Hercules closed'); continue; }
    c.wantDrain = false;
  }
}

function startServer() {
  server = net.createServer({ noDelay: true }, (sock) => {
    sock.setNoDelay(true);
    const id = termOpen(TTYPE);
    const peer = `${sock.remoteAddress}:${sock.remotePort}`;
    if (id < 0) { log(`no free wasmsock slot for ${peer}`); sock.destroy(); return; }
    log(`client ${peer} -> id ${id}`);
    const c = { sock, pending: [], paused: false, closing: false, wantDrain: false };
    conns.set(id, c);
    sock.on('data', (d) => {
      c.pending.push(d);
      if (!pushInput(id, c)) { finish(id, c, 'Hercules closed (input)'); return; }
      if (c.pending.length && !c.paused) { c.paused = true; sock.pause(); }   // input ring full
    });
    sock.on('drain', () => { c.wantDrain = true; });
    sock.on('end', () => { if (!c.closing) { pushInput(id, c); finish(id, c, 'client closed'); } });
    sock.on('close', () => { if (!c.closing) finish(id, c, 'client socket closed'); });
    sock.on('error', (e) => dbg(`id ${id}: socket error ${e.code}`));
  });
  server.on('error', (e) => { log(`listen ${HOST}:${PORT} failed: ${e.message}`); process.exit(3); });
  server.listen(PORT, HOST, () => log(`listening on ${HOST}:${PORT} (poll ${POLL_MS} ms)`));
  setInterval(tick, POLL_MS).unref();
}

function onReady(mod) {
  M = mod;
  for (const f of ['_hw_term_open', '_hw_term_input', '_hw_term_read', '_hw_term_close', '_hw_term_out_seq', '_hw_term_buf']) {
    if (typeof M[f] !== 'function') { log(`module does not export ${f} (see EXPORTED_FUNCTIONS)`); process.exit(4); }
  }
  if (!M.HEAPU8) { log('module does not export HEAPU8 (add -sEXPORTED_RUNTIME_METHODS=HEAPU8)'); process.exit(4); }
  BUF = M._hw_term_buf();
  BUFSZ = M._hw_term_buf_size ? M._hw_term_buf_size() : 65536;
  startServer();
}

const moduleOpts = {
  arguments: hercArgs,
  print: (s) => process.stdout.write(s + '\n'),
  printErr: (s) => process.stderr.write(s + '\n'),
  onExit: (code) => { log(`hercules exited rc=${code}`); if (server) server.close(); process.exit(code); },
};

const abs = path.resolve(modPath);
if (abs.endsWith('.mjs')) {
  const factory = (await import(pathToFileURL(abs).href)).default;
  onReady(await factory(moduleOpts));
} else {
  // Plain (non-MODULARIZE) build: the glue starts with "var Module = typeof Module != 'undefined' ?
  // Module : {}", which under require() is the module-local var, so a globalThis.Module is NOT seen.
  // Instead: the glue reads its argv from process.argv.slice(2) under Node, and require() returns the
  // Module object synchronously, before the async wasm instantiation finishes, so the callbacks can
  // be attached right after require().
  process.argv = [process.argv[0], abs, ...hercArgs];
  let readyCalled = false;
  const ready = (m) => { if (!readyCalled) { readyCalled = true; onReady(m); } };
  const exp = createRequire(import.meta.url)(abs);
  if (typeof exp === 'function') {                      // -sMODULARIZE (CommonJS factory)
    ready(await exp(moduleOpts));
  } else {
    const prevInit = exp.onRuntimeInitialized;
    exp.onRuntimeInitialized = () => { prevInit?.(); ready(exp); };
    exp.onExit = moduleOpts.onExit;
    const t = setInterval(() => { if (exp.calledRun || readyCalled) { clearInterval(t); ready(exp); } }, 50);
  }
}
