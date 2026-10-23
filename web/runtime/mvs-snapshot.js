// SPDX-License-Identifier: Apache-2.0
// mvs-snapshot.js -- keep the RUNNING machine in this browser and continue it on
// the next visit, without a new IPL. Used by mvs-runtime.js (option `snapshot`); see web/runtime/README.md
// "Snapshot".
//
// Contract with the C side:
//   checkpoint <dir> screens=0   hidden Hercules command: stops the CPUs, drains I/O, writes <dir>/machine.srf and a
//                      copy of every CCKD shadow file at the same point (cache flushed, files hardened, copied under
//                      the device locks) into <dir>/ (0015) or <dir>/shadow/ (stub), writes <dir>/checkpoint.json
//                      ("end":true; 0015) or <dir>/checkpoint.done (stub) LAST, restarts the CPUs. screens=0: the C
//                      side does not ask the terminals for their screens (a Read Buffer round trip through this page;
//                      the page keeps the screens itself, page.json).
//                      Log: 'HHC02030I CKPT: <dir> complete: pause <n> ms ...' / 'HHC02031E CKPT: <dir> failed: ...'
//   srbuildid <id>     (0015) build id written into every .srf and checked by resume; the runtime sends the wasm id.
//   resume <file>      only while all CPUs are stopped (the rc file has no IPL). Terminals that are connected BEFORE
//                      it (0010, 0400, ...) continue their sessions. 'HHC02026I SR: resume complete; ...'
//
// OPFS layout (all under the origin's OPFS root; WasmFS mounts the root at /opfs):
//   shadow/                 the live CCKD shadow files (persistence)
//   snap/current            {"gen":"s12","seq":12,"at":<ms>}   the commit point: written LAST
//   snap/s<seq>/            one checkpoint ("slot"); the newest two are kept (current + the one before)
//       machine.srf         (C) sr.c suspend file (gzip)
//       <vol>_1.cckd        (C) the shadow files at the checkpoint (stub: in shadow/)
//       checkpoint.json     (C) its own manifest (sizes, crc32, build, times), written after everything else
//       page.json           (JS) console history, screens of the terminals, tabs
//       manifest.json       (JS) fingerprint, sizes + sha256 of every file, terminals, times
// A slot is never changed after its manifest exists. A new checkpoint always goes into a NEW directory
// (s<seq+1>): WasmFS caches directory entries, so a directory that Hercules wrote must not be changed behind its back.
//
// localStorage 'mvs-snap-intent' (synchronous, also works in pagehide): the checkpoint that was started last
// (gen, fingerprint, page data, activity). A checkpoint whose page was closed before JS saw it complete is
// committed on the next load if its checkpoint.done exists.

export const SNAP_FORMAT = 1;
export const INTENT_KEY = 'mvs-snap-intent';

export const SNAP_DEFAULTS = {
  dir: 'snap',                // OPFS directory of the slots
  mount: '/opfs',             // WasmFS OPFS mount (persist.mount)
  resume: true,               // false: never resume (still checkpoint if auto)
  auto: true,                 // automatic checkpoints (scheduler); false = only rt.checkpoint()
  keep: 2,                    // slots kept (current + previous)
  pruneCmd: 'snaprm',         // hidden command that removes an old slot through WasmFS (wasm_main.c); '' = OPFS worker
  pruneWaitMs: 5000,          // first prune: wait this long for the reply, else the OPFS worker removes it
  afterReadyMs: 10000,        // no automatic checkpoint in the first 10 s after TSO ready / resume
  minGapMs: 5000,             // at least this long between two automatic checkpoints (not for hidden/pagehide);
                              // 5 s is enough because a delta checkpoint costs 30-80 ms (Chromium) / 0.3 s (Playwright Firefox))
  settleMs: 1500,             // "quiet" = no terminal I/O and no disk write for this long ...
  idleFrac: 0.6,              // ... and CP00 in a wait state in at least this part of the last 2 s
  intervalMs: 60000,          // periodic checkpoint while MVS is idle, if anything changed
  backgroundMs: 300000,       // only MVS's own disk writes changed (no terminal I/O): at most every 5 min
  onHidden: true,             // checkpoint at visibilitychange -> hidden
  onPagehide: true,           // checkpoint at pagehide (may not finish; committed at the next load if it did)
  ckptTimeoutMs: 120000,      // no completion message this long -> failed (hidden tabs drain the log slowly)
  // resume
  resumeTimeoutMs: 30000,     // 'resume' must end (HHC02097I / no SR error) within this time
  cpuMs: 10000,               // ... then CP00 must be started and execute instructions within this time
  probe: '/D T',              // MVS liveness probe on the hidden 3215 console 009 (reply in the Hercules log)
  probeRe: 'IEE136I',
  probeMs: 30000,
  // stale protection: the visitor pressed a key after the newest committed checkpoint and the disks were written
  // after that key: resuming would lose those writes (a TSO SAVE). 'ipl' = IPL on the newer disks instead.
  stale: 'ipl',               // 'ipl' | 'resume'
  // devices whose writes do not count as "changed" (scheduler) or "disks written" (stale protection): PAGE00
  // (paging) and MVS000 (MVS writes there about every 10 s when idle, measured: the JES2 checkpoint)
  quietDevs: ['0151', '0152'],
  historyMax: 1000,           // console lines kept in page.json
  // log patterns of the C side (strings, RegExp source)
  ckptArgs: 'screens=0',       // extra arguments of the checkpoint command (0015: level=, wait=, screens=, sync=)
  // incremental checkpoints. incr: 'checkpoint ... incr=1 base=<full slot>' writes
  // a delta (changed storage pages + changed shadow blocks, shadows.dlt) against the newest full slot ("base");
  // the C side writes a full one when it has no such base or the delta is too large (maxDelta % of the pages,
  // maxShadow % of the shadow bytes). fullEvery: at most this many deltas per base, then a full one. track: resume
  // with 'track=1' (the C side adopts the resumed slot's base, so the first checkpoint after a resume is a delta).
  incr: true,
  fullEvery: 40,
  maxDelta: 50,
  maxShadow: 90,
  track: true,
  // pagehide: wait at most this long for a running checkpoint to end (0 = do not wait). 'auto' = 2000, but 0 in
  // Firefox: there the checkpoint does not move on while the page's thread waits (measured: stuck in the pause for
  // the whole 2 s), so the wait would only delay the next page.
  unloadWaitMs: 'auto',
  buildCmd: 'srbuildid',      // command that sets the C build id ('' = none)
  doneRe: '(?:checkpoint|CKPT:) (\\S+) complete(?:: (.*))?',
  failRe: '(?:checkpoint|CKPT:) (\\S+) failed(?:: (.*))?',
  resumeOkRe: 'resume complete',
  resumeErrRe: '^HHC020(0[1-9]|[1-4]\\d)E |^HHC02027W ',
};

// ---------------------------------------------------------------- OPFS helper worker
// OPFS writes from the page thread need createWritable(), which WebKit does not have in every version; sync access
// handles work in a dedicated worker in Chromium, Firefox and WebKit. All slot I/O and hashing runs here.
const WORKER_SRC = String.raw`'use strict';
const BUSY = new Set(['NoModificationAllowedError', 'InvalidStateError']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rootP = null;
const root = () => (rootP = rootP || navigator.storage.getDirectory());
const parts = (p) => String(p).split('/').filter(Boolean);
async function dirAt(path, create) { let d = await root(); for (const x of parts(path)) d = await d.getDirectoryHandle(x, { create: !!create }); return d; }
async function parentOf(path, create) { const a = parts(path); const name = a.pop(); return [await dirAt(a.join('/'), create), name]; }
async function retry(f, ms) { const t0 = Date.now(); for (;;) { try { return await f(); } catch (e) { if (e && BUSY.has(e.name) && Date.now() - t0 < (ms || 5000)) { await sleep(50); continue; } throw e; } } }
const notFound = (e) => e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
async function sha(bytes) { return hex(await crypto.subtle.digest('SHA-256', bytes)); }
async function readFile(path) {
  try { const [d, n] = await parentOf(path, false); const fh = await d.getFileHandle(n); const f = await retry(() => fh.getFile()); return new Uint8Array(await f.arrayBuffer()); }
  catch (e) { if (notFound(e)) return null; throw e; }
}
async function writeFile(path, bytes) {
  const [d, n] = await parentOf(path, true);
  const fh = await d.getFileHandle(n, { create: true });
  const ah = await retry(() => fh.createSyncAccessHandle());
  try { ah.truncate(0); const k = ah.write(bytes, { at: 0 }); if (k !== bytes.length) throw new Error('short write ' + k + ' of ' + bytes.length); ah.flush(); } finally { ah.close(); }
  return bytes.length;
}
async function remove(path, recursive) {
  try { const [d, n] = await parentOf(path, false); await retry(() => d.removeEntry(n, { recursive: !!recursive })); return true; }
  catch (e) { if (notFound(e)) return false; throw e; }
}
async function list(path) {
  const out = [];
  let d; try { d = await dirAt(path, false); } catch (e) { if (notFound(e)) return null; throw e; }
  for await (const [name, h] of d.entries()) {
    const o = { name, kind: h.kind };
    if (h.kind === 'file') { try { o.size = (await h.getFile()).size; } catch (e) { o.size = null; o.busy = e && e.name; } }
    out.push(o);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
// Memory: hashing (Chromium renderer +120-150 MiB/h with checkpoints, +21 without, in a soak test) read
// every slot file (about 2.7 MB per checkpoint) into a NEW ArrayBuffer (File.arrayBuffer()). Those buffers are
// external memory of this worker, freed only by its GC, which a small worker heap rarely runs: the dead buffers piled
// up between GCs. Now the files are read with a sync access handle into one buffer that is kept and reused (it grows
// to the largest file, about 2.2 MB); crypto.subtle.digest copies its input, so the view may be reused at once. A
// file that is still open elsewhere (NoModificationAllowedError) falls back to getFile() (counted: readStats).
let scratch = new Uint8Array(4 << 20);
const readStats = { reused: 0, fallback: 0, grows: 0 };
async function readReuse(d, n) {
  const fh = await d.getFileHandle(n);
  let ah;
  try { ah = await fh.createSyncAccessHandle(); }
  catch (e) {
    if (!e || !BUSY.has(e.name)) throw e;
    readStats.fallback++;
    const f = await retry(() => fh.getFile());
    return new Uint8Array(await f.arrayBuffer());
  }
  try {
    const size = ah.getSize();
    if (scratch.length < size) { scratch = new Uint8Array(Math.max(size, 2 * scratch.length)); readStats.grows++; }
    let off = 0;
    while (off < size) { const k = ah.read(scratch.subarray(off, size), { at: off }); if (!(k > 0)) break; off += k; }
    readStats.reused++;
    return scratch.subarray(0, off);
  } finally { ah.close(); }
}
// hashFiles calls run one at a time: they share the scratch buffer (readReuse returns a view of it), and the
// worker's onmessage is async, so two calls could otherwise interleave between a read and its digest.
let hashChain = Promise.resolve();
function hashFiles(path, names) {
  const run = hashChain.then(() => hashFiles1(path, names));
  hashChain = run.catch(() => {});
  return run;
}
async function hashFiles1(path, names) {
  const d = await dirAt(path, false);
  const out = [];
  if (!names) { names = []; for await (const [n, h] of d.entries()) if (h.kind === 'file') names.push(n); names.sort(); }
  for (const n of names) { const b = await readReuse(d, n); out.push({ name: n, size: b.byteLength, sha256: await sha(b) }); }
  return out;
}
async function fetchHash(url, wantText) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('GET ' + url + ': HTTP ' + r.status);
  const b = await r.arrayBuffer();
  return { size: b.byteLength, sha256: await sha(b), text: wantText ? new TextDecoder().decode(b) : undefined };
}
// OPFS write/read/hash timings (sync access handle in this worker; createWritable if the engine has it)
async function bench(sizesMiB, reps) {
  const res = [];
  const d = await dirAt('m6bench', true);
  for (const mib of sizesMiB) {
    const n = Math.round(mib * 1048576), buf = new Uint8Array(n);
    for (let i = 0; i < n; i += 4096) buf[i] = (i * 2654435761) >>> 24;     // not all zeros
    for (let k = 0; k < reps; k++) {
      const r = { mib, rep: k };
      let t = performance.now();
      const fh = await d.getFileHandle('f' + mib, { create: true });
      const ah = await fh.createSyncAccessHandle();
      r.openMs = performance.now() - t; t = performance.now();
      ah.truncate(0); let w = 0; const CH = 1 << 20;
      for (let o = 0; o < n; o += CH) w += ah.write(buf.subarray(o, Math.min(n, o + CH)), { at: o });
      r.writeMs = performance.now() - t; t = performance.now();
      ah.flush(); r.flushMs = performance.now() - t; t = performance.now();
      ah.close(); r.closeMs = performance.now() - t;
      r.syncTotalMs = r.openMs + r.writeMs + r.flushMs + r.closeMs;
      t = performance.now(); const rd = new Uint8Array(await (await fh.getFile()).arrayBuffer()); r.readMs = performance.now() - t;
      t = performance.now(); await sha(rd); r.sha256Ms = performance.now() - t;
      // copy to a second file (= restoring one slot file into shadow/)
      t = performance.now();
      const fh2 = await d.getFileHandle('c' + mib, { create: true }); const ah2 = await fh2.createSyncAccessHandle();
      ah2.truncate(0); ah2.write(rd, { at: 0 }); ah2.flush(); ah2.close(); r.copyMs = performance.now() - t;
      if (fh.createWritable) {
        try { t = performance.now(); const ws = await fh.createWritable(); await ws.write(buf); await ws.close(); r.writableMs = performance.now() - t; }
        catch (e) { r.writableErr = String(e && e.name); }
      } else r.writableMs = null;
      r.written = w;
      res.push(r);
    }
  }
  await (await root()).removeEntry('m6bench', { recursive: true });
  return res;
}
const OPS = { readFile, writeFile, remove, list, hashFiles, fetchHash, bench, readStats: async () => ({ ...readStats, scratch: scratch.length }),
  readText: async (p) => { const b = await readFile(p); return b == null ? null : new TextDecoder().decode(b); },
  writeText: (p, s) => writeFile(p, new TextEncoder().encode(s)),
  mkdir: async (p) => { await dirAt(p, true); return true; } };
// Only own OPS entries are operations. A test once got 'TypeError: OPS[op] is not a function': its memory probe asked
// a bundle without 'readStats' for it (an unknown op); now an unknown op is a clear error, never a lookup on
// the object prototype ('constructor', 'toString', ...).
onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(OPS, op) || typeof OPS[op] !== 'function') throw new Error('unknown snapshot worker op: ' + String(op));
    const result = await OPS[op](...(args || [])); const tr = result instanceof Uint8Array ? [result.buffer] : []; postMessage({ id, ok: true, result }, tr); }
  catch (err) { postMessage({ id, ok: false, error: (err && err.name ? err.name + ': ' : '') + (err && err.message ? err.message : String(err)) }); }
};`;

export class SnapIO {
  constructor() {
    this.w = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })), { name: 'mvs-snapshot-io' });
    this.n = 0; this.wait = new Map();
    this.w.onmessage = (e) => { const p = this.wait.get(e.data.id); if (!p) return; this.wait.delete(e.data.id); if (e.data.ok) p.ok(e.data.result); else p.fail(new Error(e.data.error)); };
    this.w.onerror = (e) => { for (const p of this.wait.values()) p.fail(new Error(`snapshot worker: ${e.message || 'error'}`)); this.wait.clear(); };
  }
  call(op, ...args) { return new Promise((ok, fail) => { const id = ++this.n; this.wait.set(id, { ok, fail }); this.w.postMessage({ id, op, args }); }); }
  async readJson(path) { const t = await this.call('readText', path); if (t == null) return null; try { return JSON.parse(t); } catch { return { __bad: true }; } }
  writeJson(path, obj) { return this.call('writeText', path, JSON.stringify(obj)); }
  terminate() { this.w.terminate(); }
}

// ---------------------------------------------------------------- helpers
export async function sha256Hex(data) {
  const b = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) => x.toString(16).padStart(2, '0')).join('');
}
// A Read Buffer image (AID, cursor address (2 bytes), buffer with SF orders) -> the outbound record that puts the
// same screen on a terminal: EW, WCC (reset, keyboard restore), buffer, SBA cursor, IC; framed for the wire.
// The same record as sr.c loc3270_hresume() builds from SR_DEV_3270_BUF.
export function screenRecord(rb, ewa = false) {
  if (!rb || rb.length < 4) return null;
  const rec = [ewa ? 0x7e : 0xf5, 0xc2, ...rb.subarray(3), 0x11, rb[1], rb[2], 0x13];
  const out = [];
  for (const b of rec) { out.push(b); if (b === 255) out.push(255); }
  out.push(255, 239);
  return Uint8Array.from(out);
}
export const b64 = {
  enc: (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); },
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
// Count 3270 records (IAC EOR) in a telnet byte stream, with the IAC state carried between calls.
export function countRecords(bytes, st) {
  let n = 0;
  for (const b of bytes) {
    if (st.iac) { st.iac = false; if (b === 239) n++; }
    else if (b === 255) st.iac = true;
  }
  return n;
}

// ---------------------------------------------------------------- scheduler (pure: unit-tested)
// s = { now, ready, busy, readyAt, lastAt, last: {io, ckw, out}, cur: {io, ckw, out}, quietSince, idle (0..1),
//       userSince (a key was pressed since the last checkpoint), event: null | 'hidden' | 'pagehide' }
// Returns the reason for a checkpoint now, or null.
export function schedDecision(s, o) {
  if (!s.ready || s.busy) return null;
  const io = s.cur.io !== s.last.io || s.cur.out !== s.last.out;          // terminals or printer/punch output
  const bg = s.cur.ckw !== s.last.ckw;                                     // disk writes only
  if (s.event) return io || bg || !s.lastAt ? s.event : null;
  if (s.now - s.readyAt < o.afterReadyMs) return null;
  if (s.lastAt && s.now - s.lastAt < o.minGapMs) return null;
  const quiet = s.now - s.quietSince >= o.settleMs && s.idle >= o.idleFrac;
  if (!quiet) return null;
  if (!s.lastAt) return 'first';
  if (io && s.userSince) return 'settle';
  if (s.now - s.lastAt >= o.intervalMs && io) return 'interval';
  if (s.now - s.lastAt >= o.backgroundMs && bg) return 'background';
  return null;
}

// ---------------------------------------------------------------- slot selection (at load)
// fp: the fingerprint of this load. Returns { resume, why, gen, seq, manifest, page, commit, nextSeq, stale }.
export async function planResume(io, o, fp, { intent, activity } = {}) {
  const top = await io.call('list', o.dir);
  const gens = (top || []).filter((e) => e.kind === 'directory' && /^s\d+$/.test(e.name)).map((e) => ({ gen: e.name, seq: Number(e.name.slice(1)) }))
    .sort((a, b) => b.seq - a.seq);
  const nextSeq = (gens[0]?.seq ?? 0) + 1;
  const plan = { resume: false, why: '', nextSeq, gens: gens.map((g) => g.gen), tried: [] };
  if (!gens.length) { plan.why = 'no saved machine'; return plan; }
  const cur = await io.readJson(`${o.dir}/current`);
  if (cur && cur.discarded) { plan.why = `discarded (${cur.why || 'no reason'})`; return plan; }
  // a checkpoint started by the last page whose completion that page did not see (closed / reloaded): commit it now
  let commit = null;
  if (intent && intent.gen && /^s\d+$/.test(intent.gen) && (!cur || intent.seq > cur.seq) && gens.some((g) => g.gen === intent.gen)) {
    const done = await slotDone(io, `${o.dir}/${intent.gen}`);
    const man = await io.readJson(`${o.dir}/${intent.gen}/manifest.json`);
    if (done && !man) commit = { ...intent, done };
    plan.tried.push({ gen: intent.gen, what: 'intent', done: !!done, manifest: !!man,
      why: man ? 'committed already' : done ? 'finished after the page was gone: committed now' : 'started at the close, not finished' });
  }
  const order = [];
  if (commit) order.push(commit.gen);
  if (cur?.gen) order.push(cur.gen);
  for (const g of gens) if (!order.includes(g.gen)) order.push(g.gen);
  for (const gen of order.slice(0, o.keep + 1)) {
    const d = `${o.dir}/${gen}`;
    let man = await io.readJson(`${d}/manifest.json`);
    if (!man && commit && gen === commit.gen) {
      if (commit.fp !== fp.id) { plan.tried.push({ gen, why: 'intent fingerprint differs' }); continue; }
      man = { pending: true, format: SNAP_FORMAT, fp: commit.fpFields, fpId: commit.fp, seq: commit.seq, gen, savedAt: commit.at, terminals: commit.terminals || [],
        shadowDir: commit.done.shadowDir, shadowNames: commit.done.names, c: commit.done.c, kind: commit.done.kind };
      if (commit.done.kind === 'delta') {
        // a delta whose page was gone: its base must be the one the intent named
        if (!commit.base || commit.done.basePath !== `${o.mount}/${o.dir}/${commit.base.gen}`) { plan.tried.push({ gen, why: 'intent: delta base unknown' }); continue; }
        man.base = commit.base;
      }
    }
    if (!man || man.__bad) { plan.tried.push({ gen, why: man ? 'manifest unreadable' : 'no manifest' }); continue; }
    if (man.format !== SNAP_FORMAT) { plan.tried.push({ gen, why: `format ${man.format}` }); continue; }
    if (man.fpId !== fp.id) {
      const diff = Object.keys({ ...fp.fields, ...(man.fp || {}) }).filter((k) => (man.fp || {})[k] !== fp.fields[k]);
      plan.tried.push({ gen, why: `changed: ${diff.join(', ') || 'fingerprint'}` });
      continue;
    }
    // files: sizes now (cheap); sha256 in the loader worker before the copy (spec.opfs.restore)
    const sd = man.shadowDir ? `${d}/${man.shadowDir}` : d;
    const all = await io.call('list', d);
    const sh = man.shadowDir ? await io.call('list', sd) : all;
    const srf = all?.find((e) => e.name === 'machine.srf');
    if (!sh || !srf) { plan.tried.push({ gen, why: 'files missing' }); continue; }
    if (man.kind === 'delta') {
      // the base slot must still be there with the sizes its manifest named
      const bd = `${o.dir}/${man.base?.gen}`;
      const bl = man.base?.gen ? await io.call('list', bd) : null;
      const bbad = !bl ? ['(base missing)'] : [...(man.base.files || []), { name: 'machine.srf', size: man.base.srf?.size }]
        .filter((f) => bl.find((x) => x.name === f.name)?.size !== f.size).map((f) => f.name);
      if (bbad.length) { plan.tried.push({ gen, why: `base ${man.base?.gen}: ${bbad.join(', ')}` }); continue; }
    }
    if (man.pending) {
      try {
        man.files = await io.call('hashFiles', sd, man.shadowNames);
        man.srf = (await io.call('hashFiles', d, ['machine.srf']))[0];
        if (man.kind === 'delta') man.delta = (await io.call('hashFiles', d, ['shadows.dlt']))[0];
      } catch (e) { plan.tried.push({ gen, why: `hash: ${e.message}` }); continue; }
    } else {
      const bad = [...(man.files || []), ...(man.delta ? [man.delta] : [])].filter((f) => sh.find((x) => x.name === f.name)?.size !== f.size);
      if (bad.length || srf.size !== man.srf?.size) {
        plan.tried.push({ gen, why: `size mismatch: ${bad.map((f) => f.name).join(', ') || 'machine.srf / file count'}` }); continue;
      }
    }
    plan.resume = true; plan.gen = gen; plan.seq = man.seq; plan.manifest = man; plan.commit = !!man.pending;
    plan.page = (await io.readJson(`${d}/page.json`)) || (man.pending ? commit.page || null : null);
    // stale protection: keys pressed and disks written after this checkpoint (activity is from the last page)
    if (activity && activity.seq === man.seq && activity.userWrites) plan.stale = activity;
    break;
  }
  if (!plan.resume) plan.why = plan.tried.map((t) => `${t.gen}: ${t.why || 'not usable'}`).join('; ') || 'no usable checkpoint';
  if (plan.resume && plan.stale && o.stale === 'ipl') {
    plan.resume = false;
    plan.why = `disks were written after the last snapshot (${plan.gen}, keys pressed at ${new Date(plan.stale.userAt).toISOString()}): IPL keeps those writes`;
  }
  return plan;
}

// Did the C side finish this slot? -> { shadowDir, names, c } or null. 0015: checkpoint.json with "end":true and
// its shadow list; the stub: checkpoint.done ("ok ...") and the files in shadow/.
export async function slotDone(io, d) {
  const cj = await io.readJson(`${d}/checkpoint.json`);
  if (cj && !cj.__bad && cj.end === true) {
    const delta = cj.kind === 'delta';
    const names = delta ? [] : (cj.shadows || []).map((x) => x.file);
    return { shadowDir: '', names, kind: delta ? 'delta' : 'full', basePath: delta ? cj.base : null, delta: delta ? cj.delta : null,
      c: { build: cj.build, pauseMs: cj.pauseMs, created: cj.created, srf: cj.srf, shadows: cj.shadows, kind: cj.kind || 'full', kindWhy: cj.kindWhy,
        msPages: cj.msPages, hashMs: cj.hashMs, cckdMs: cj.cckdMs, srfMs: cj.srfMs, crcMs: cj.crcMs } };
  }
  const done = await io.call('readText', `${d}/checkpoint.done`);
  if (done && /^ok/.test(done)) return { shadowDir: 'shadow', names: undefined, c: { done: done.trim() } };
  return null;
}

export function readIntent(storage = globalThis.localStorage) {
  try { return JSON.parse(storage.getItem(INTENT_KEY) || 'null'); } catch { return null; }
}
export function writeIntent(v, storage = globalThis.localStorage) {
  try { if (v == null) storage.removeItem(INTENT_KEY); else storage.setItem(INTENT_KEY, JSON.stringify(v)); return true; } catch { return false; }
}
