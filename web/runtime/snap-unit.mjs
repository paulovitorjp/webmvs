#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Unit tests for the pure parts of mvs-snapshot.js: scheduler decisions, the screen
// record, record counting, slot selection (planResume) on an in-memory OPFS with both C layouts (0015 and the stub),
// the intent commit, stale protection, discard. Run: node web/runtime/snap-unit.mjs   (Node >= 18; no browser)
import { schedDecision, screenRecord, countRecords, planResume, slotDone, SNAP_DEFAULTS, SNAP_FORMAT } from './mvs-snapshot.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let n = 0, failed = 0;
const t = async (name, f) => { n++; try { await f(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); } };
const O = { ...SNAP_DEFAULTS };

// ---------------------------------------------------------------- scheduler
const base = (x = {}) => ({ now: 100000, ready: true, busy: false, readyAt: 1000, lastAt: 50000, last: { io: 10, ckw: 5, out: 0 },
  cur: { io: 10, ckw: 5, out: 0 }, quietSince: 0, idle: 1, userSince: false, event: null, ...x });
await t('no checkpoint while not ready / busy', () => {
  assert.equal(schedDecision(base({ ready: false, cur: { io: 99, ckw: 5, out: 0 }, userSince: true }), O), null);
  assert.equal(schedDecision(base({ busy: true, event: 'hidden', cur: { io: 99, ckw: 5, out: 0 } }), O), null);
});
await t('nothing changed -> no checkpoint, also not at hidden', () => {
  assert.equal(schedDecision(base({ lastAt: 1000 }), O), null);
  assert.equal(schedDecision(base({ event: 'hidden' }), O), null);
});
await t('hidden / pagehide with a change -> checkpoint at once (no gap, no idle rule)', () => {
  assert.equal(schedDecision(base({ event: 'hidden', lastAt: 99999, idle: 0, quietSince: 99999, cur: { io: 11, ckw: 5, out: 0 } }), O), 'hidden');
  assert.equal(schedDecision(base({ event: 'pagehide', cur: { io: 10, ckw: 6, out: 0 } }), O), 'pagehide');
  assert.equal(schedDecision(base({ event: 'hidden', lastAt: 0, last: { io: -1, ckw: -1, out: -1 } }), O), 'hidden');
});
await t('first checkpoint after ready only after afterReadyMs and when quiet', () => {
  const s = base({ lastAt: 0, last: { io: -1, ckw: -1, out: -1 }, readyAt: 95000 });
  assert.equal(schedDecision(s, O), null);                                    // 5 s after ready
  assert.equal(schedDecision({ ...s, readyAt: 80000, quietSince: 99000 }, O), null);   // not quiet (1 s)
  assert.equal(schedDecision({ ...s, readyAt: 80000, idle: 0.2 }, O), null);  // CPU busy
  assert.equal(schedDecision({ ...s, readyAt: 80000 }, O), 'first');
});
await t('settle: keys pressed + terminal I/O, quiet -> checkpoint after minGap', () => {
  const s = base({ cur: { io: 50, ckw: 9, out: 0 }, userSince: true });
  assert.equal(schedDecision({ ...s, lastAt: 97000 }, O), null);             // 3 s < minGap 5 s
  assert.equal(schedDecision({ ...s, quietSince: 99000 }, O), null);          // 1 s < settle 1.5 s
  assert.equal(schedDecision(s, O), 'settle');
});
await t('interval: output without keys -> every intervalMs; disk only -> every backgroundMs', () => {
  const io = base({ cur: { io: 10, ckw: 5, out: 77 } });
  assert.equal(schedDecision({ ...io, lastAt: 50000 }, O), null);             // 50 s
  assert.equal(schedDecision({ ...io, lastAt: 39000 }, O), 'interval');       // 61 s
  const bg = base({ cur: { io: 10, ckw: 99, out: 0 } });
  assert.equal(schedDecision({ ...bg, lastAt: 39000 }, O), null);             // 61 s, disk only
  assert.equal(schedDecision({ ...bg, now: 400000, lastAt: 99000 }, O), 'background');
});

// ---------------------------------------------------------------- screen record, records
await t('screenRecord = EW, WCC C2, buffer, SBA cursor, IC, IAC EOR; 0xFF doubled', () => {
  const rb = Uint8Array.from([0x60, 0x40, 0xc5, 0x1d, 0x60, 0xc1, 0xff, 0x00]);
  assert.deepEqual([...screenRecord(rb)], [0xf5, 0xc2, 0x1d, 0x60, 0xc1, 0xff, 0xff, 0x00, 0x11, 0x40, 0xc5, 0x13, 255, 239]);
  assert.equal(screenRecord(Uint8Array.from([1, 2])), null);
});
await t('countRecords counts IAC EOR across calls, not IAC IAC EOR', () => {
  const st = {};
  assert.equal(countRecords(Uint8Array.from([1, 2, 255]), st), 0);
  assert.equal(countRecords(Uint8Array.from([239, 255, 255, 239, 7, 255, 239]), st), 2);
});

// ---------------------------------------------------------------- planResume on a fake OPFS
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
class FakeIO {
  constructor() { this.files = new Map(); this.dirs = new Set(['']); }
  mkdirs(p) { const a = p.split('/'); for (let i = 1; i <= a.length; i++) this.dirs.add(a.slice(0, i).join('/')); }
  put(p, data) { const b = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data); this.mkdirs(p.split('/').slice(0, -1).join('/')); this.files.set(p, b); }
  async call(op, ...a) {
    if (op === 'list') {
      const d = a[0]; if (!this.dirs.has(d)) return null;
      const out = new Map();
      for (const [p, b] of this.files) if (p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes('/')) out.set(p.slice(d.length + 1), { name: p.slice(d.length + 1), kind: 'file', size: b.length });
      for (const x of this.dirs) if (x.startsWith(`${d}/`) && !x.slice(d.length + 1).includes('/')) out.set(x.slice(d.length + 1), { name: x.slice(d.length + 1), kind: 'directory' });
      return [...out.values()].sort((x, y) => (x.name < y.name ? -1 : 1));
    }
    if (op === 'readText') { const b = this.files.get(a[0]); return b ? b.toString() : null; }
    if (op === 'hashFiles') {
      const [d, names] = a;
      const ns = names || (await this.call('list', d)).filter((e) => e.kind === 'file').map((e) => e.name);
      return ns.map((name) => { const b = this.files.get(`${d}/${name}`); if (!b) throw new Error(`NotFoundError: ${name}`); return { name, size: b.length, sha256: sha(b) }; });
    }
    throw new Error(`op ${op}`);
  }
  async readJson(p) { const t = await this.call('readText', p); if (t == null) return null; try { return JSON.parse(t); } catch { return { __bad: true }; } }
}
const FP = { fields: { format: SNAP_FORMAT, wasm: 'name:aaaaaaaaaaaa', glue: 'g', image: 'i', seed: 's', cnf: 'c', rc: 'r' } };
FP.id = sha(JSON.stringify(FP.fields));
function slot(io, gen, { layout = '0015', fp = FP, at = 1000, commit = true, shadows = { 'mvsres_1.cckd': 'AAAA', 'pub001_1.cckd': 'BBBBBB' } } = {}) {
  const d = `snap/${gen}`, sd = layout === '0015' ? d : `${d}/shadow`;
  io.mkdirs(sd);
  io.put(`${d}/machine.srf`, 'SRF-' + gen);
  for (const [k, v] of Object.entries(shadows)) io.put(`${sd}/${k}`, v);
  if (layout === '0015') io.put(`${d}/checkpoint.json`, JSON.stringify({ format: 'hercules-checkpoint', end: true, build: 'b', pauseMs: 300, shadows: Object.keys(shadows).map((f) => ({ file: f })) }));
  else io.put(`${d}/checkpoint.done`, 'ok srf=8 shadows=2');
  if (!commit) return;
  const files = Object.entries(shadows).map(([name, v]) => ({ name, size: v.length, sha256: sha(Buffer.from(v)) }));
  io.put(`${d}/manifest.json`, JSON.stringify({ format: SNAP_FORMAT, gen, seq: Number(gen.slice(1)), savedAt: at, fp: fp.fields, fpId: fp.id,
    shadowDir: layout === '0015' ? '' : 'shadow', files, srf: { size: ('SRF-' + gen).length, sha256: sha(Buffer.from('SRF-' + gen)) }, terminals: [{ devnum: '0010' }, { devnum: '0400' }] }));
  io.put(`${d}/page.json`, JSON.stringify({ screens: {}, extra: { history: ['L1'] } }));
}
await t('no snapshot dir -> no resume, nextSeq 1', async () => {
  const p = await planResume(new FakeIO(), O, FP);
  assert.equal(p.resume, false); assert.equal(p.nextSeq, 1);
});
await t('current slot valid -> resume it (0015 layout); nextSeq = newest + 1', async () => {
  const io = new FakeIO(); slot(io, 's3'); slot(io, 's4'); io.put('snap/current', JSON.stringify({ gen: 's4', seq: 4 }));
  const p = await planResume(io, O, FP);
  assert.equal(p.resume, true); assert.equal(p.gen, 's4'); assert.equal(p.nextSeq, 5); assert.deepEqual(p.page.extra.history, ['L1']);
});
await t('stub layout (shadow/ + checkpoint.done) works too', async () => {
  const io = new FakeIO(); slot(io, 's2', { layout: 'stub' }); io.put('snap/current', JSON.stringify({ gen: 's2', seq: 2 }));
  const p = await planResume(io, O, FP);
  assert.equal(p.resume, true); assert.equal(p.manifest.shadowDir, 'shadow');
});
await t('fingerprint change (new wasm) -> no resume, reason names the field', async () => {
  const io = new FakeIO(); slot(io, 's4'); io.put('snap/current', JSON.stringify({ gen: 's4', seq: 4 }));
  const fp2 = { fields: { ...FP.fields, wasm: 'name:bbbbbbbbbbbb' } }; fp2.id = sha(JSON.stringify(fp2.fields));
  const p = await planResume(io, O, fp2);
  assert.equal(p.resume, false); assert.match(p.why, /changed: wasm/);
});
await t('damaged current slot (size) -> the previous slot is used', async () => {
  const io = new FakeIO(); slot(io, 's3'); slot(io, 's4'); io.put('snap/current', JSON.stringify({ gen: 's4', seq: 4 }));
  io.put('snap/s4/pub001_1.cckd', 'BBB');
  const p = await planResume(io, O, FP);
  assert.equal(p.gen, 's3'); assert.match(p.tried[0].why, /size mismatch: pub001_1.cckd/);
});
await t('slot without manifest (C finished, JS did not commit) is not used without an intent', async () => {
  const io = new FakeIO(); slot(io, 's3'); slot(io, 's4', { commit: false }); io.put('snap/current', JSON.stringify({ gen: 's3', seq: 3 }));
  const p = await planResume(io, O, FP);
  assert.equal(p.gen, 's3');
});
await t('intent of a closed page + checkpoint.json end:true -> committed at load (hashes computed)', async () => {
  const io = new FakeIO(); slot(io, 's3'); slot(io, 's4', { commit: false }); io.put('snap/current', JSON.stringify({ gen: 's3', seq: 3 }));
  const intent = { gen: 's4', seq: 4, fp: FP.id, fpFields: FP.fields, at: 2000, terminals: [{ devnum: '0010' }], page: { screens: {}, extra: { history: ['X'] } } };
  const p = await planResume(io, O, FP, { intent });
  assert.equal(p.resume, true); assert.equal(p.gen, 's4'); assert.equal(p.commit, true);
  assert.equal(p.manifest.files.length, 2); assert.equal(p.manifest.srf.size, 6); assert.deepEqual(p.page.extra.history, ['X']);
});
await t('intent whose C part did not finish (no checkpoint.json) -> previous slot', async () => {
  const io = new FakeIO(); slot(io, 's3'); slot(io, 's4', { commit: false }); io.put('snap/current', JSON.stringify({ gen: 's3', seq: 3 }));
  io.files.delete('snap/s4/checkpoint.json');
  const intent = { gen: 's4', seq: 4, fp: FP.id, fpFields: FP.fields, at: 2000 };
  const p = await planResume(io, O, FP, { intent });
  assert.equal(p.gen, 's3');
});
await t('stale protection: keys + disk writes after the newest slot -> IPL (stale=ipl), resume with stale=resume', async () => {
  const io = new FakeIO(); slot(io, 's4'); io.put('snap/current', JSON.stringify({ gen: 's4', seq: 4 }));
  const activity = { seq: 4, userAt: 12345, userWrites: true };
  const p = await planResume(io, O, FP, { activity });
  assert.equal(p.resume, false); assert.match(p.why, /disks were written after the last snapshot/);
  const p2 = await planResume(io, { ...O, stale: 'resume' }, FP, { activity });
  assert.equal(p2.resume, true);
  const p3 = await planResume(io, O, FP, { activity: { seq: 4, userAt: 1, userWrites: false } });
  assert.equal(p3.resume, true);
});
await t('discarded current (Start fresh, Shut down, failed resume) -> no resume even with other slots', async () => {
  const io = new FakeIO(); slot(io, 's3'); slot(io, 's4'); io.put('snap/current', JSON.stringify({ gen: null, discarded: true, why: 'user: start fresh' }));
  const p = await planResume(io, O, FP);
  assert.equal(p.resume, false); assert.match(p.why, /discarded \(user: start fresh\)/);
});
// delta slots = the base slot's shadow copies + shadows.dlt
function dslot(io, gen, base, { commit = true, at = 3000 } = {}) {
  const d = `snap/${gen}`; io.mkdirs(d);
  io.put(`${d}/machine.srf`, 'DSRF-' + gen); io.put(`${d}/shadows.dlt`, 'MVSCKDL1-' + gen);
  io.put(`${d}/checkpoint.json`, JSON.stringify({ format: 'hercules-checkpoint', end: true, kind: 'delta', base: `${O.mount}/snap/${base}`,
    delta: { file: 'shadows.dlt' }, shadows: [{ file: 'mvsres_1.cckd', delta: true }, { file: 'pub001_1.cckd', delta: true }] }));
  const bm = JSON.parse(io.files.get(`snap/${base}/manifest.json`).toString());
  const b = { gen: base, files: bm.files, srf: bm.srf };
  if (!commit) return b;
  const dl = io.files.get(`${d}/shadows.dlt`);
  io.put(`${d}/manifest.json`, JSON.stringify({ format: SNAP_FORMAT, gen, seq: Number(gen.slice(1)), savedAt: at, fp: FP.fields, fpId: FP.id, shadowDir: '',
    files: [], kind: 'delta', delta: { name: 'shadows.dlt', size: dl.length, sha256: sha(dl) }, base: b,
    srf: { size: ('DSRF-' + gen).length, sha256: sha(Buffer.from('DSRF-' + gen)) }, terminals: [{ devnum: '0010' }] }));
  return b;
}
await t('delta slot with its base -> resume it (manifest names the base)', async () => {
  const io = new FakeIO(); slot(io, 's3'); dslot(io, 's5', 's3'); io.put('snap/current', JSON.stringify({ gen: 's5', seq: 5 }));
  const p = await planResume(io, O, FP);
  assert.equal(p.resume, true); assert.equal(p.gen, 's5'); assert.equal(p.manifest.kind, 'delta'); assert.equal(p.manifest.base.gen, 's3');
});
await t('delta slot whose base is gone or damaged -> not used (previous slot)', async () => {
  const io = new FakeIO(); slot(io, 's3'); dslot(io, 's4', 's3'); dslot(io, 's5', 's3'); io.put('snap/current', JSON.stringify({ gen: 's5', seq: 5 }));
  io.put('snap/s3/mvsres_1.cckd', 'AA');
  const p = await planResume(io, O, FP);
  assert.equal(p.resume, false); assert.match(p.why, /base s3: mvsres_1.cckd/);
  const io2 = new FakeIO(); slot(io2, 's2'); slot(io2, 's3'); dslot(io2, 's5', 's3'); io2.put('snap/current', JSON.stringify({ gen: 's5', seq: 5 }));
  for (const k of [...io2.files.keys()]) if (k.startsWith('snap/s3/')) io2.files.delete(k);
  io2.dirs.delete('snap/s3');
  const p2 = await planResume(io2, O, FP);
  assert.equal(p2.gen, 's2'); assert.match(p2.tried[0].why, /base s3/);
});
await t('delta slot damaged (shadows.dlt size) -> not used', async () => {
  const io = new FakeIO(); slot(io, 's3'); dslot(io, 's5', 's3'); io.put('snap/current', JSON.stringify({ gen: 's5', seq: 5 }));
  io.put('snap/s5/shadows.dlt', 'X');
  const p = await planResume(io, O, FP);
  assert.equal(p.gen, 's3'); assert.match(p.tried[0].why, /size mismatch: shadows.dlt/);
});
await t('intent of a closed page whose checkpoint was a delta -> committed at load with the intent base', async () => {
  const io = new FakeIO(); slot(io, 's3'); io.put('snap/current', JSON.stringify({ gen: 's3', seq: 3 }));
  const base = dslot(io, 's4', 's3', { commit: false });
  const intent = { gen: 's4', seq: 4, fp: FP.id, fpFields: FP.fields, at: 2000, terminals: [{ devnum: '0010' }], page: { screens: {} }, base };
  const p = await planResume(io, O, FP, { intent });
  assert.equal(p.resume, true); assert.equal(p.gen, 's4'); assert.equal(p.commit, true); assert.equal(p.manifest.kind, 'delta');
  assert.equal(p.manifest.delta.name, 'shadows.dlt'); assert.equal(p.manifest.base.gen, 's3'); assert.deepEqual(p.manifest.files, []);
  const p2 = await planResume(io, O, FP, { intent: { ...intent, base: { ...base, gen: 's2' } } });
  assert.equal(p2.gen, 's3'); assert.match(p2.tried.map((x) => x.why).join(';'), /delta base unknown/);
});
await t('slotDone: 0015 manifest needs "end":true', async () => {
  const io = new FakeIO(); io.mkdirs('snap/s1'); io.put('snap/s1/checkpoint.json', '{"format":"hercules-checkpoint","shadows":[]');
  assert.equal(await slotDone(io, 'snap/s1'), null);
  io.put('snap/s1/checkpoint.json', '{"end":true,"shadows":[{"file":"a_1.cckd"}]}');
  assert.deepEqual((await slotDone(io, 'snap/s1')).names, ['a_1.cckd']);
});
// ---------------------------------------------------------------- worker
// The OPFS worker source, run in a vm context with an in-memory fake of navigator.storage (sync access handles that
// resolve after a random delay, so concurrent calls interleave): unknown ops are errors, and concurrent hashFiles
// calls (which share the scratch read buffer) still give the right sha256 for every file.
{
  const vm = await import('node:vm');
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./mvs-snapshot.js', import.meta.url), 'utf8');
  const i = src.indexOf('String.raw`') + 11, wsrc = src.slice(i, src.indexOf('`;', i));
  const delay = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4)));
  const mkFile = (bytes) => ({ kind: 'file', bytes,
    async createSyncAccessHandle() { await delay(); const f = this; return { getSize: () => f.bytes.length, read: (v, { at }) => { const k = Math.min(v.length, f.bytes.length - at); v.set(f.bytes.subarray(at, at + k)); return k; }, close() {} }; },
    async getFile() { await delay(); const b = this.bytes; return { size: b.length, arrayBuffer: async () => b.slice().buffer }; } });
  const mkDir = (entries) => ({ kind: 'directory', entries,
    async getDirectoryHandle(n) { await delay(); const d = this.entries.get(n); if (!d || d.kind !== 'directory') { const e = new Error('nf'); e.name = 'NotFoundError'; throw e; } return d; },
    async getFileHandle(n) { await delay(); const f = this.entries.get(n); if (!f || f.kind !== 'file') { const e = new Error('nf'); e.name = 'NotFoundError'; throw e; } return f; } });
  const files = new Map(); const want = {};
  for (let k = 0; k < 6; k++) { const b = crypto.randomBytes(1000 + 300000 * k); files.set(`f${k}.cckd`, mkFile(new Uint8Array(b))); want[`f${k}.cckd`] = crypto.createHash('sha256').update(b).digest('hex'); }
  const top = mkDir(new Map([['snap', mkDir(new Map([['s1', mkDir(files)]]))]]));
  const out = [];
  const ctx = { navigator: { storage: { getDirectory: async () => top } }, crypto: globalThis.crypto, setTimeout, TextEncoder, TextDecoder, performance, fetch: undefined,
    postMessage: (m) => out.push(m), onmessage: null };
  vm.createContext(ctx); vm.runInContext(wsrc, ctx);
  const call = async (id, op, args = []) => { await ctx.onmessage({ data: { id, op, args } }); return out.find((m) => m.id === id); };
  await t('worker: unknown op -> clear error (no OPS[op] TypeError), also for prototype names', async () => {
    for (const op of ['nope', 'constructor', 'toString', '__proto__', 42]) {
      const r = await call(`u-${op}`, op);
      assert.equal(r.ok, false); assert.match(r.error, /unknown snapshot worker op/);
    }
    assert.equal((await call('rs', 'readStats')).ok, true);
  });
  await t('worker: concurrent hashFiles share the scratch buffer safely (6 files x 8 calls)', async () => {
    const names = [...files.keys()];
    const rs = await Promise.all(Array.from({ length: 8 }, (_, k) => call(`h${k}`, 'hashFiles', ['snap/s1', k % 2 ? names : names.slice().reverse()])));
    for (const r of rs) { assert.equal(r.ok, true, r.error); for (const f of r.result) assert.equal(f.sha256, want[f.name], f.name); }
    const st = (await call('rs2', 'readStats')).result;
    assert.ok(st.reused >= 48, JSON.stringify(st));
  });
}
console.log(`\n${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
