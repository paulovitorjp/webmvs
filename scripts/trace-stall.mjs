#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Explain main-thread stalls and long tasks of an e2e run from its Chrome trace.
// Used by scripts/e2e.mjs --trace (in the run), and as a CLI for a kept trace:
//   node scripts/trace-stall.mjs <trace.json.gz> <e2e-<tag>.json> [--min-stall <ms>] [--min-task <ms>]
// For each window (heartbeat stall [last tick, gap] or long task [start, duration], page ms):
//   mainBusyMs = time inside top-level events of the page's main thread (CrRendererMain), mainCpuMs = their
//   thread CPU time (tdur) in the window; busy << gap = the thread was idle (a late timer), busy >> cpu = the
//   thread was runnable/blocked but did not get the CPU (or waited, e.g. on a page fault or a lock).
//   mainTop = the top-level main-thread events, biggest = the largest main-thread events (any depth),
//   threads = the longest event of each busy thread in all processes.
// The page time <-> trace time offset comes from the performance.mark('e2e-trace-sync') that e2e.mjs sets.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export function analyze(evs, { syncPageMs, minStall = 100, minTask = 50, stalls = [], tasks = [], max = 12 }) {
  const names = new Map(), pnames = new Map();
  for (const e of evs) if (e.ph === 'M') {
    if (e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args?.name);
    if (e.name === 'process_name') pnames.set(e.pid, e.args?.name);
  }
  const mark = evs.filter((e) => e.name === 'e2e-trace-sync').pop();
  if (!mark || syncPageMs == null) return { error: 'no sync mark', events: evs.length };
  const off = mark.ts / 1000 - syncPageMs;              // trace ms = page ms + off
  const mainKey = `${mark.pid}:${mark.tid}`;
  const wins = [];
  for (const [st, d] of stalls) if (d > minStall) wins.push({ kind: 'stall', page0: st, page1: st + 16 + d, ms: d });
  for (const [st, d] of tasks) if (d > minTask) wins.push({ kind: 'longtask', page0: st, page1: st + d, ms: d });
  const X = evs.filter((e) => e.ph === 'X' && e.dur > 0);
  const ov = (e, a, b) => Math.max(0, Math.min(e.ts + e.dur, b) - Math.max(e.ts, a));
  const r1 = (us) => (us == null ? null : Math.round(us / 100) / 10);
  const label = (e) => {
    const d = e.args?.data || {};
    const extra = d.functionName || d.url || d.type || e.args?.src_func || '';
    return `${e.name}${extra ? ` [${String(extra).slice(0, 80)}]` : ''}`;
  };
  const windows = [];
  for (const w of wins.slice(0, max)) {
    const a = (w.page0 + off) * 1000, b = (w.page1 + off) * 1000;
    const mainEv = X.filter((e) => `${e.pid}:${e.tid}` === mainKey && ov(e, a, b) > 0);
    const sorted = mainEv.slice().sort((x, y) => x.ts - y.ts || y.dur - x.dur);
    const top = []; let end = -1;
    for (const e of sorted) if (e.ts >= end) { top.push(e); end = e.ts + e.dur; }
    const busy = top.reduce((s, e) => s + ov(e, a, b), 0) / 1000;
    const cpu = top.reduce((s, e) => s + (e.tdur != null ? e.tdur * ov(e, a, b) / e.dur : 0), 0) / 1000;
    const biggest = mainEv.slice().sort((x, y) => y.dur - x.dur).slice(0, 15)
      .map((e) => [label(e), r1(e.dur), r1(e.tdur), Math.round(e.ts / 1000 - off)]);
    const per = new Map();
    for (const e of X) {
      const o = ov(e, a, b); if (o < 2000) continue;
      const k = `${e.pid}:${e.tid}`, p = per.get(k) || { max: 0 };
      if (o > p.max) Object.assign(p, { max: o, ev: label(e), dur: e.dur, tdur: e.tdur });
      per.set(k, p);
    }
    const threads = [...per.entries()].sort((x, y) => y[1].max - x[1].max).slice(0, 12)
      .map(([k, p]) => [`${pnames.get(Number(k.split(':')[0])) ?? '?'}/${names.get(k) ?? k}`, p.ev, r1(p.max), r1(p.tdur)]);
    windows.push({ ...w, mainBusyMs: Math.round(busy), mainCpuMs: Math.round(cpu),
      mainTop: top.filter((e) => ov(e, a, b) > 1000).slice(0, 12).map((e) => [label(e), r1(e.dur), r1(e.tdur), Math.round(e.ts / 1000 - off)]),
      biggest, threads });
  }
  // Google Chrome's Optimization Guide model install (browser process, new profile), page ms
  let mA = Infinity, mB = -Infinity, unz = 0, dl = 0;
  for (const e of evs) {
    if (!/prediction_model_download_manager|download_driver_impl/.test(e.args?.src_file || '')) continue;
    const t = e.ts / 1000 - off; mA = Math.min(mA, t); mB = Math.max(mB, t);
    if (/OnDownloadUnzipped/.test(e.args?.src_func || '')) unz++;
    if (/download_driver_impl/.test(e.args?.src_file || '')) dl++;
  }
  const modelInstall = unz || dl ? { page0: Math.round(mA), page1: Math.round(mB), unzipped: unz, downloadEvents: dl } : null;
  const short = windows.map((w) => ({ kind: w.kind, at: w.page0, ms: w.ms, busy: w.mainBusyMs, cpu: w.mainCpuMs, top: w.mainTop.slice(0, 3) }));
  return { events: evs.length, offsetMs: off, mainThread: names.get(mainKey), modelInstall, windows, short };
}

export function readTrace(file) {
  const buf = fs.readFileSync(file);
  const raw = (file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8');
  const j = JSON.parse(raw);
  return Array.isArray(j) ? j : j.traceEvents;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const o = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? Number(a[i + 1]) : d; };
  const [tf, jf] = a;
  const r = JSON.parse(fs.readFileSync(jf, 'utf8'));
  const out = analyze(readTrace(tf), { syncPageMs: r.traceSummary?.syncPageMs, minStall: o('min-stall', 100), minTask: o('min-task', 50),
    stalls: r.heartbeat?.stalls ?? [], tasks: r.longtasks?.tasks ?? [] });
  console.log(JSON.stringify(out, null, 1));
}
