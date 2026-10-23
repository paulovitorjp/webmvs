#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// soak.mjs -- long soak harness for the page.
// Runs on the build host (Playwright 1.56.1 from web/app/node_modules, or PLAYWRIGHT_DIR).
//
// Usage: node scripts/soak.mjs <chromium|firefox> <page url> <out dir> <tag> [options]
//   --mode active|idle|busy  active: every --activity-s a TSO command and a console D T (default)
//                            idle:   no input at all during the soak
//                            busy:   CPU-bound batch job (MVSCE02.CLIST(CPULOOP), = bench/mips/cpuloop.jcl)
//                                    submitted again and again from TSO, TSO commands every --activity-s
//   --dur-s <s>        soak time after TSO logon (default 3600)
//   --sample-s <s>     sample interval (default 10)
//   --activity-s <s>   activity interval (default 120; busy: TSO command interval)
//   --sfd-s <s>        hidden Hercules 'sfd *' every <s> s (shadow sizes; 0 = off; default 60)
//   --count <n>        busy: COUNT of the CPU loop (default 1000000 = 1.2e9 instructions)
//   --reply-s <s>      wait this long for a reply (default 60); a reply slower than 10 s is flagged
//   --no-logon         do not log on to TSO
//   --channel <name>   Playwright channel (chrome = the installed Google Chrome)
//   --extra-cmd '<c>[;<c>]'  hidden Hercules command(s) at every --sfd-s interval (output in the herc log)
// Watches: Aborted / RuntimeError / OOM / worker error in the log or page, crash state, X SYSTEM in the OIA,
// a keyboard locked > 10 s while the harness is idle. Output: <out>/soak-<tag>.json (summary + samples),
// <out>/soak-<tag>.samples.jsonl, <out>/soak-<tag>.herc.log (whole Hercules log), <out>/soak-<tag>.console.txt
// (every distinct 0010 line), screenshot; stdout line "SOAK-RESULT <tag> ok|FAIL ...".
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.join(here, '..', 'web', 'app'), 'package.json'));
const { chromium, firefox } = require('playwright');

const argv = process.argv.slice(2);
const VALOPTS = ['--mode', '--dur-s', '--sample-s', '--activity-s', '--sfd-s', '--count', '--reply-s', '--timeout', '--extra-cmd', '--channel', '--profile', '--uamem-s'];
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const [B, URL0, OUT, TAG] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALOPTS.includes(argv[i - 1])));
if (!B || !URL0 || !OUT || !TAG) { console.error('usage: soak.mjs <chromium|firefox> <url> <out> <tag> [options]'); process.exit(2); }
const MODE = opt('mode', 'active'), DUR_S = Number(opt('dur-s', 3600)), SAMPLE_S = Number(opt('sample-s', 10));
const ACT_S = Number(opt('activity-s', 120)), SFD_S = Number(opt('sfd-s', 60)), COUNT = Number(opt('count', 1000000));
const REPLY_S = Number(opt('reply-s', 60)), LOGON = !flag('no-logon');
const EXTRA_CMDS = (opt('extra-cmd', '') || '').split(';').map((x) => x.trim()).filter(Boolean);
const TIMEOUT_S = Number(opt('timeout', DUR_S + 1200));
fs.mkdirSync(OUT, { recursive: true });
const F = (s) => path.join(OUT, `soak-${TAG}${s}`);

const t0 = Date.now();
const T = () => Math.round((Date.now() - t0) / 100) / 10;
const res = { tag: TAG, browser: B, url: URL0, opts: { MODE, DUR_S, SAMPLE_S, ACT_S, SFD_S, COUNT, REPLY_S, LOGON }, start: new Date().toISOString(),
  steps: [], cmds: [], jobs: [], problems: [], result: null };
const samples = [];
const step = (what, x) => { const s = { t: T(), what, ...(x ? { x } : {}) }; res.steps.push(s); console.log(`[${s.t}s] ${what}${x ? ' ' + JSON.stringify(x).slice(0, 300) : ''}`); };
const problem = (kind, x) => { const p = { t: T(), kind, ...(x ? { x } : {}) }; res.problems.push(p); console.log(`[${p.t}s] PROBLEM ${kind} ${x ? JSON.stringify(x).slice(0, 300) : ''}`); };
const save = () => fs.writeFileSync(F('.json'), JSON.stringify({ ...res, nSamples: samples.length, samples }, null, 1));
const killer = setTimeout(() => { res.result = 'FAIL timeout'; step('run timeout'); save(); console.log(`SOAK-RESULT ${TAG} FAIL timeout`); process.exit(3); }, TIMEOUT_S * 1000);

// env SOAK_FF_PREFS='{"pref": value}': more Firefox prefs
const launchOpts = B === 'firefox' ? { firefoxUserPrefs: { 'dom.max_script_run_time': 0, ...JSON.parse(process.env.SOAK_FF_PREFS || '{}') } } : {};
if (opt('channel')) launchOpts.channel = opt('channel');   // e.g. --channel chrome (an installed Google Chrome)
// --profile <dir> = a persistent profile (OPFS and the DASD cache on disk, as for a visitor).
// Without it the context is Playwright's default (Chromium: an off-the-record context, so OPFS and Cache Storage live
// in the browser's memory). --uamem-s <s> (Chromium, crossOriginIsolated):
// performance.measureUserAgentSpecificMemory() (JS memory per page/worker) into the samples.
let br, ctx;
if (opt('profile')) {
  fs.rmSync(opt('profile'), { recursive: true, force: true });
  ctx = await ({ chromium, firefox })[B].launchPersistentContext(opt('profile'), { ...launchOpts, headless: true, viewport: { width: 1280, height: 860 } });
  br = { close: () => ctx.close() };
} else {
  br = await ({ chromium, firefox })[B].launch(launchOpts);
  ctx = await br.newContext({ viewport: { width: 1280, height: 860 } });
}
const page = ctx.pages()[0] ?? await ctx.newPage();
const UAMEM_S = Number(opt('uamem-s', 0)); let uamemNext = 0;
res.opts.profile = opt('profile') || null; res.opts.query = new URL(URL0).search;
const pageErrors = [];
page.on('pageerror', (e) => { pageErrors.push(`${T()} ${String(e).slice(0, 300)}`); });
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`${T()} console: ${m.text().slice(0, 300)}`); });
page.on('crash', () => problem('page crash event'));
const ev = (fn, a) => page.evaluate(fn, a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFn(fn, a, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await ev(fn, a).catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(200);
  }
}
const text = (id) => ev((i) => window.mvs.text(i), id);
async function waitText(id, re, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const t = await text(id).catch(() => '');
    if (re.test(t)) return t;
    if (Date.now() > end) throw new Error(`timeout: ${what} (last: ${t.split('\n').filter((l) => l.trim()).slice(-2).join(' | ')})`);
    await sleep(200);
  }
}
// TSO at READY: the last line is READY, or the screen is full ('***') right after a READY line
function isReady(t) {
  const l = t.split('\n').map((x) => x.trim()).filter((x) => x);
  const a = l[l.length - 1] || '', b = l[l.length - 2] || '';
  return a === 'READY' || (a === '***' && b === 'READY');
}
const unlocked = (id, ms = 30000) => waitFn((i) => window.mvs.unlocked(i), id, ms, `${id} keyboard unlocked`);
async function tab(id) { await page.click(`button.tab[data-tab="${id}"]`); await sleep(150); }
async function typeLine(id, s) { await unlocked(id); await page.keyboard.type(s, { delay: 8 }); await page.keyboard.press('Enter'); }
async function key(id, k) { await unlocked(id); await page.keyboard.press(k); }

// ---- process RSS of the browser (all descendants of this node process) ----
function rssKiB() {
  try {
    const rows = execSync('ps -eo pid=,ppid=,rss=', { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map(); for (const [p, pp] of rows) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); }
    const rss = new Map(rows.map(([p, , r]) => [p, r]));
    const all = []; const q = [process.pid];
    while (q.length) { const p = q.pop(); for (const c of kids.get(p) || []) { all.push(c); q.push(c); } }
    let sum = 0, max = 0; for (const p of all) { const r = rss.get(p) || 0; sum += r; if (r > max) max = r; }
    return { sum, max, n: all.length };
  } catch { return null; }
}

// ---- incremental Hercules log + console lines ----
let lastLogT = -1, logCount = 0, seenIdx = 0;
// the page keeps only a window of the newest console lines (operator.ts SEEN_MAX); the harness
// reads them by absolute index (window.mvs.seenTotal / seenSince; older pages: seen()) and counts job ends here.
let jobEnds = 0; const jobLines = [];
const hercOut = fs.createWriteStream(F('.herc.log'));
const conOut = fs.createWriteStream(F('.console.txt'));
const BAD = /Aborted\(|RuntimeError|out of memory|\bOOM\b|worker sent an error|unreachable|HHC\d{5}[ES]\b/i;
let sfdPending = null; const sfdLast = {};
function scanLine(t, l) {
  if (BAD.test(l)) problem('bad log line', { t, l: l.slice(0, 200) });
  const m = /HHC003(?:39|41)I (\d):([0-9A-F]{4})\s+\[(\d+)\]\s+(\S+)\s+(\d+)\s+(\d+)%\s+(\d+)\s+(\S+)/.exec(l);
  if (m) sfdLast[`${m[2]}[${m[3]}]`] = { size: Number(m[5]), free: Number(m[6]), nbr: Number(m[7]), st: m[8] };
}
async function pullLog() {
  const r = await ev(([lt, si]) => {
    const h = window.mvs.herclog(); const out = [];
    for (let i = h.length - 1; i >= 0 && h[i][0] > lt; i--) out.push(h[i]);
    out.reverse();
    const m = window.mvs;
    if (m.seenSince) return { lines: out, seen: m.seenSince(si), seenLen: m.seenTotal(), hlen: h.length };
    const s = m.seen();
    return { lines: out, seen: s.slice(si), seenLen: s.length, hlen: h.length };
  }, [lastLogT, seenIdx]).catch(() => null);
  if (!r) return null;
  for (const [t, l] of r.lines) { hercOut.write(`${(t / 1000).toFixed(2)} ${l}\n`); scanLine(t, l); lastLogT = t; logCount++; }
  for (const l of r.seen) {
    conOut.write(`${T()} ${l}\n`);
    if (/MVSCE02A/.test(l)) { jobLines.push(l); if (jobLines.length > 6) jobLines.shift(); }
    if (/IEF404I MVSCE02A - ENDED - TIME=/.test(l)) jobEnds++;
  }
  seenIdx = r.seenLen;
  return r;
}

// ---- sampling ----
const lockSince = { console: null, tso1: null };
let busyCmd = false;   // the harness is waiting for a reply right now (a locked keyboard is expected)
let lastSfd = 0, lastShadows = null;
async function sample(label) {
  const now = Date.now();
  if (SFD_S > 0 && now - lastSfd >= SFD_S * 1000) {
    lastSfd = now;
    await ev(() => globalThis.__mvsRuntime?.command('sfd *')).catch(() => {});
    // --extra-cmd '<hercules cmd>[;<cmd>]' at the same interval (e.g. 'cache' for the CCKD cache sizes; output in the herc log)
    for (const c of EXTRA_CMDS) await ev((x) => globalThis.__mvsRuntime?.command(x), c).catch(() => {});
    lastShadows = await ev(async () => { try { return await window.mvs.shadows(); } catch (e) { return String(e); } }).catch(() => null);
  }
  const r = await pullLog();
  const s = await ev(() => {
    const m = window.mvs; let st = {}; try { st = m.stats() || {}; } catch (e) { st = { err: String(e) }; }
    const lz = st.lazy || {};
    const pm = performance.memory ? performance.memory.usedJSHeapSize : null;
    return {
      state: window.mvsState, crash: m.crash ? m.crash() : null, crashDialog: !!document.getElementById('crash-dialog')?.open,
      heapUsed: st.heapUsed, heapPeak: st.heapPeak, arena: st.arena, sbrk: st.sbrk, sbrkPeak: st.sbrkPeak, mem: st.memoryBytes,
      logDropped: st.logDropped, threads: st.threads, workers: st.workersCreated, poolExhausted: st.poolExhausted, errors: (st.errors || []).length,
      lru: lz.lruUsed, lruPeak: lz.lruPeak, evict: lz.evictions, netBytes: lz.netBytes, netReq: lz.netReq, cacheReq: lz.cacheReq,
      demandWaits: lz.demandWaits, lzErr: lz.errors, refetch: lz.refetch, tracks: lz.tracksRead,
      conU: m.unlocked('console'), tsoU: m.unlocked('tso1'), oiaCon: m.oia('console'), oiaTso: m.oia('tso1'),
      jsHeap: pm, seen: m.seen().length, seenTotal: m.seenTotal ? m.seenTotal() : null, events: m.events().length,
      output: st.output || null, tsoLogoffs: m.tsoLogoffs ? m.tsoLogoffs().length : null, hint: m.hint ? m.hint().slice(0, 160) : null,
      status: document.getElementById('ipl-status')?.textContent?.slice(0, 120) ?? null,
    };
  }).catch((e) => ({ err: String(e).slice(0, 200) }));
  s.t = T(); s.label = label; s.rss = rssKiB(); s.hlen = r?.hlen; s.logLines = logCount;
  if (UAMEM_S > 0 && Date.now() >= uamemNext) {
    uamemNext = Date.now() + UAMEM_S * 1000;
    s.uamem = await ev(async () => {
      if (!self.crossOriginIsolated || !performance.measureUserAgentSpecificMemory) return null;
      const m = await performance.measureUserAgentSpecificMemory();
      const by = {};
      for (const b of m.breakdown) { const k = (b.types || []).join('+') + ':' + ((b.attribution || []).map((a) => (a.scope || '') + (a.url ? ' ' + a.url.split('/').pop().slice(0, 40) : '')).join(',') || '-'); by[k] = (by[k] || 0) + b.bytes; }
      return { bytes: m.bytes, by };
    }).catch((e) => ({ err: String(e).slice(0, 120) }));
  }
  s.sfd = { ...sfdLast }; if (lastShadows) { s.opfs = lastShadows; lastShadows = null; }
  samples.push(s);
  fs.appendFileSync(F('.samples.jsonl'), JSON.stringify(s) + '\n');
  if (s.err) problem('sample error', s.err);
  if (s.crash || s.crashDialog || s.state === 'crashed') problem('crashed', { crash: s.crash, state: s.state });
  for (const [id, u, oia] of [['console', s.conU, s.oiaCon], ['tso1', s.tsoU, s.oiaTso]]) {
    if (/X SYSTEM|X Disconnected/.test(oia || '') && !busyCmd) problem('oia', { id, oia });
    if (!u && !busyCmd) { if (lockSince[id] == null) lockSince[id] = s.t; else if (s.t - lockSince[id] > 10) problem('keyboard locked > 10 s while idle', { id, since: lockSince[id], oia }); }
    else if (u) lockSince[id] = null;
  }
  const sf = Object.entries(s.sfd).filter(([k]) => !k.endsWith('[0]')).reduce((a, [, v]) => a + v.size, 0);
  console.log(`[${s.t}s] ${label}: ${s.state} heap ${(s.heapUsed / 1048576).toFixed(1)} sbrk ${(s.sbrk / 1048576).toFixed(1)}/${(s.mem / 1048576).toFixed(0)} MiB lru ${((s.lru || 0) / 1048576).toFixed(1)} sh ${(sf / 1024).toFixed(0)}K wk ${s.workers} drop ${s.logDropped} rss ${s.rss ? Math.round(s.rss.sum / 1024) : '?'}M js ${s.jsHeap ? (s.jsHeap / 1048576).toFixed(1) : '-'} con ${s.conU ? 'U' : 'L'} tso ${s.tsoU ? 'U' : 'L'} log ${logCount}`);
  return s;
}

// ---- terminal actions ----
async function consoleCmd(cmd) {
  busyCmd = true;
  try {
    await tab('console');
    const ok0 = await unlocked('console', REPLY_S * 1000).then(() => true, () => false);
    if (!ok0) { problem('console locked before command', { cmd, oia: await ev(() => window.mvs.oia('console')) }); return { ok: false }; }
    const before = await ev(() => (window.mvs.seenTotal ? window.mvs.seenTotal() : window.mvs.seen().length));
    await page.keyboard.press('Home');
    await page.keyboard.type(cmd, { delay: 15 });
    const te = Date.now();
    await page.keyboard.press('Enter');
    const re = /^d t$/i.test(cmd) ? 'IEE136I' : null;
    const ok = await waitFn(([b, r]) => window.mvs.unlocked('console') && (!r || (window.mvs.seenSince ? window.mvs.seenSince(b) : window.mvs.seen().slice(b)).some((l) => l.includes(r))), [before, re], REPLY_S * 1000, 'console reply').then(() => true, () => false);
    const ms = Date.now() - te;
    const c = { t: T(), term: 'console', cmd, ok, ms };
    res.cmds.push(c);
    if (!ok) problem('console no reply', { cmd, oia: await ev(() => window.mvs.oia('console')) });
    else if (ms > 10000) problem('console reply > 10 s', { cmd, ms });
    return c;
  } finally { busyCmd = false; }
}
async function tsoCmd(cmd, re = /READY\s*$/m) {
  busyCmd = true;
  try {
    await tab('tso1');
    const ok0 = await unlocked('tso1', REPLY_S * 1000).then(() => true, () => false);
    if (!ok0) { problem('tso locked before command', { cmd, oia: await ev(() => window.mvs.oia('tso1')) }); return { ok: false }; }
    await page.keyboard.press('Escape'); await sleep(300);
    await unlocked('tso1', REPLY_S * 1000).catch(() => {});
    const te = Date.now();
    await page.keyboard.type(cmd, { delay: 8 }); await page.keyboard.press('Enter');
    let ok = false, all = '', firstMs = null;
    const end = Date.now() + REPLY_S * 1000;
    while (Date.now() < end) {
      await sleep(200);
      const [t, u] = await ev(() => [window.mvs.text('tso1'), window.mvs.unlocked('tso1')]);
      if (!u) continue;
      if (firstMs == null) firstMs = Date.now() - te;
      if (re.test(t) && (!/^\s*\*\*\*\s*$/m.test(t) || isReady(t))) { ok = true; all += t; break; }
      if (/^\s*\*\*\*\s*$/m.test(t)) { all += t; await page.keyboard.press('Enter'); await sleep(300); }
    }
    const ms = Date.now() - te;
    const c = { t: T(), term: 'tso', cmd, ok, ms, firstMs };
    res.cmds.push(c);
    if (!ok) problem('tso no reply', { cmd, oia: await ev(() => window.mvs.oia('tso1')), tail: (await text('tso1')).split('\n').filter((l) => l.trim()).slice(-3) });
    else if ((firstMs ?? ms) > 10000) problem('tso reply > 10 s', { cmd, ms, firstMs });
    return { ...c, screen: all };
  } finally { busyCmd = false; }
}
async function logon() {
  busyCmd = true;
  try {
    await tab('tso1');
    let t = await waitText('tso1', /CLEAR the screen or hit ENTER|TSO Logon ===>|LOGON/, 90000, 'logon screen');
    if (!/TSO Logon ===>/.test(t)) { await key('tso1', 'Enter'); await waitText('tso1', /TSO Logon ===>/, 60000, 'TSO Logon ===>'); }
    for (let k = 0; ; k++) {
      await sleep(400); await unlocked('tso1');
      await page.keyboard.type('logon mvsce02', { delay: 20 });
      const ok = await waitText('tso1', /TSO Logon ===> *logon mvsce02/i, 3000, 'typed').then(() => true, () => false);
      if (ok) break;
      if (k >= 3) throw new Error('could not type the logon command');
      await key('tso1', 'Escape'); await sleep(500); await key('tso1', 'Enter');
      await waitText('tso1', /TSO Logon ===>/, 30000, 'TSO Logon again');
    }
    await key('tso1', 'Enter');
    await waitText('tso1', /ENTER CURRENT PASSWORD FOR MVSCE02/, 60000, 'password prompt');
    await typeLine('tso1', 'PASS4U');
    for (let i = 0; ; i++) {
      t = await waitText('tso1', /^\s*\*\*\*\s*$|READY\s*$|IN USE|REJECTED|NOT AUTHORIZED/m, 120000, 'READY');
      if (/IN USE|REJECTED|NOT AUTHORIZED/.test(t)) throw new Error('logon failed');
      if (/READY\s*$/m.test(t)) break;
      if (i > 20) throw new Error('no READY');
      await key('tso1', 'Enter'); await sleep(300);
    }
  } finally { busyCmd = false; }
}
// busy: the CPU loop job as a member of MVSCE02.CLIST (FB 80; EDIT puts sequence numbers in 73-80)
const JCL = [
  '//MVSCE02A JOB (1),\'SOAK LOOP\',CLASS=A,MSGCLASS=A,MSGLEVEL=(1,1),',
  '//             TIME=1440',
  '//STEP1    EXEC ASMFCLG,TIME.GO=1440',
  '//ASM.SYSPUNCH DD DUMMY',
  '//ASM.SYSIN DD *',
  'CPULOOP  CSECT',
  '         STM   14,12,12(13)',
  '         BALR  12,0',
  '         USING *,12',
  '         L     5,COUNT',
  'OUTER    LA    6,100',
  'INNER    L     2,VALA',
  '         A     2,VALB',
  '         ST    2,VALC',
  '         MVC   FLDD(16),FLDE',
  '         CLC   FLDD(16),FLDE',
  '         SR    3,3',
  '         IC    3,VALC+3',
  '         SLL   3,2',
  '         N     3,MASK',
  '         LR    4,3',
  '         AR    4,2',
  '         BCT   6,INNER',
  '         BCT   5,OUTER',
  '         LM    14,12,12(13)',
  '         SR    15,15',
  '         BR    14',
  `COUNT    DC    F'${COUNT}'`,
  "VALA     DC    F'1'",
  "VALB     DC    F'3'",
  "VALC     DC    F'0'",
  "MASK     DC    F'255'",
  '         DS    0F',
  'FLDD     DS    CL16',
  "FLDE     DC    CL16'ABCDEFGHIJKLMNOP'",
  '         END   CPULOOP',
  '/*',
  '//',
];
// last non-blank line of a screen
const lastL = (t) => { const l = t.split('\n').map((x) => x.trim()).filter((x) => x); return [l[l.length - 1] || '', l[l.length - 2] || '']; };
// wait until the keyboard is unlocked and the LAST line matches re; '***' (screen full) -> Enter
async function waitLast(re, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const [t, u] = await ev(() => [window.mvs.text('tso1'), window.mvs.unlocked('tso1')]);
    const [a, b] = lastL(t);
    if (u && re.test(a)) return t;
    // screen full: Enter clears it (text typed at '***' is ignored by TSO); if the prompt was the line before, done
    if (u && a === '***') { await page.keyboard.press('Enter'); await sleep(500); if (re.test(b)) return t; continue; }
    if (Date.now() > end) throw new Error(`timeout: ${what} (last: ${b} | ${a})`);
    await sleep(200);
  }
}
async function editJob(mem) {
  busyCmd = true;
  try {
    await tab('tso1');
    await key('tso1', 'Escape'); await sleep(300);
    await typeLine('tso1', `edit 'mvsce02.clist(${mem})' new data`);
    await waitLast(/^\d{5}$/, 60000, 'EDIT INPUT mode');
    let n = 10;
    for (const l of JCL) {
      await waitLast(new RegExp(`^${String(n).padStart(5, '0')}$`), 30000, `EDIT input line ${n}`);
      await page.keyboard.type(l, { delay: 6 }); await page.keyboard.press('Enter');
      n += 10;
      await sleep(150);
    }
    await waitLast(new RegExp(`^${String(n).padStart(5, '0')}$`), 30000, `EDIT input line ${n}`);
    await page.keyboard.press('Enter');                       // empty line: INPUT -> EDIT mode
    await waitLast(/^EDIT$/, 30000, 'EDIT mode');
    await page.keyboard.type('save', { delay: 10 }); await page.keyboard.press('Enter'); await sleep(500);
    await waitLast(/^EDIT$/, 60000, 'SAVE done');
    const dbg = async (w) => step(`edit ${w}`, { tail: (await text('tso1')).split('\n').map((x, i) => `${i}:${x.trimEnd()}`).filter((x) => x.length > 3).slice(-6), oia: await ev(() => window.mvs.oia('tso1')) });
    await dbg('after save');
    await page.keyboard.type('end', { delay: 10 }); await dbg('end typed'); await page.keyboard.press('Enter'); await sleep(500); await dbg('end entered');
    await sleep(2000); await dbg('end +2s');
    await waitLast(/^READY$/, 60000, 'READY after END');
    step('edit done', { tail: (await text('tso1')).split('\n').filter((x) => x.trim()).slice(-4) });
  } finally { busyCmd = false; }
}

let fail = null;
const IDS = {};
try {
  await page.goto(URL0);
  await waitFn(() => window.mvs && !document.getElementById('app').hidden, null, Number(process.env.SOAK_LOAD_S || 300) * 1000, 'app visible');
  step('app visible');
  await waitFn(() => window.mvsState === 'tso', null, 300000, 'TSO tab (IKT007I)');
  step('TSO ready', await ev(() => ({ persist: window.mvs.persist(), timings: window.mvs.timings(), coi: self.crossOriginIsolated })).catch(() => null));
  await unlocked('console', 60000).catch(() => step('console still locked 60 s after TSO ready'));
  await sample('ready');
  if (LOGON) { await logon(); step('TSO logged on'); }
  if (MODE === 'busy') {
    const mem = 'CPULOOP';
    await tsoCmd(`delete 'mvsce02.clist(${mem})'`, /READY\s*$/m);
    await editJob(mem); step('job member written');
    IDS.mem = mem;
  }
  await tab('console');
  const soakStart = Date.now(); res.soakStartT = T();
  const soakEnd = soakStart + DUR_S * 1000;
  let n = 0, lastAct = Date.now(), nAct = 0, nextSample = Date.now();
  let jobRunning = null; let jobsDone = 0;
  const tsoCmds = ['time', 'listcat', 'status', 'lista st'];
  while (Date.now() < soakEnd) {
    if (Date.now() >= nextSample) { await sample(`s${n++}`); nextSample += SAMPLE_S * 1000; if (nextSample < Date.now()) nextSample = Date.now() + SAMPLE_S * 1000; }
    if (MODE === 'busy') {
      // job state from the 0010 lines
      await pullLog();
      const lines = jobLines.slice(), ended = jobEnds;
      if (jobRunning && ended > jobsDone) {
        jobsDone = ended; jobRunning.end = T(); jobRunning.s = Math.round((jobRunning.end - jobRunning.sub) * 10) / 10;
        jobRunning.lines = lines.slice(-6); res.jobs.push(jobRunning); step('job ended', { n: res.jobs.length, s: jobRunning.s }); jobRunning = null;
      }
      if (jobRunning && T() - jobRunning.sub > 900) { problem('job did not end in 900 s', jobRunning); res.jobs.push(jobRunning); jobRunning = null; }
      if (!jobRunning && Date.now() < soakEnd - 30000) {
        const r = await tsoCmd(`submit 'mvsce02.clist(${IDS.mem})'`, /READY\s*$/m);
        const m = /JOB MVSCE02A\((JOB\d+)\) SUBMITTED/.exec(r.screen || '');
        jobRunning = { sub: T(), job: m ? m[1] : null, ok: r.ok };
        if (!m) step('submit: no IKJ56250I', { tail: (r.screen || '').split('\n').filter((l) => l.trim()).slice(-3) });
      }
    }
    if (MODE !== 'idle' && ACT_S > 0 && Date.now() - lastAct >= ACT_S * 1000) {
      lastAct = Date.now(); nAct++;
      if (LOGON) await tsoCmd(tsoCmds[nAct % 4]);
      if (MODE === 'active' || nAct % 2 === 0) await consoleCmd('d t');
      await tab('console');
    }
    if (res.problems.some((p) => /crash|no reply|locked before/.test(p.kind))) { fail = res.problems.find((p) => /crash|no reply|locked before/.test(p.kind)).kind; break; }
    await sleep(Math.max(200, Math.min(nextSample - Date.now(), 1000)));
  }
  if (MODE === 'busy' && jobRunning) {   // let the last job end (up to 300 s) so the counts are complete
    const end = Date.now() + 300000;
    while (Date.now() < end) {
      await pullLog(); const ended = jobEnds;
      if (ended > jobsDone) { jobRunning.end = T(); jobRunning.s = Math.round((jobRunning.end - jobRunning.sub) * 10) / 10; res.jobs.push(jobRunning); jobRunning = null; break; }
      await sleep(2000); if ((Date.now() / 1000 | 0) % 10 === 0) await sample('drain');
    }
  }
  await sample('soak end');
  // ---- the final user sequence: a console command and a TSO Enter ----
  const c1 = await consoleCmd('d t'); step('final console D T', c1);
  if (!c1.ok && !fail) fail = 'final console';
  busyCmd = true;
  await tab('tso1');
  const u0 = await ev(() => window.mvs.unlocked('tso1'));
  if (!u0) { problem('tso locked before final Enter', { oia: await ev(() => window.mvs.oia('tso1')) }); if (!fail) fail = 'tso locked'; }
  else {
    const te = Date.now(); await page.keyboard.press('Enter');
    await sleep(300);
    const ok = await waitFn(() => window.mvs.unlocked('tso1'), null, REPLY_S * 1000, 'tso reply').then(() => true, () => false);
    const c = { t: T(), term: 'tso', cmd: '<Enter>', ok, ms: Date.now() - te, tail: (await text('tso1')).split('\n').filter((l) => l.trim()).slice(-3) };
    res.cmds.push(c); step('final TSO Enter', c);
    if (!ok && !fail) fail = 'final tso enter';
  }
  busyCmd = false;
  await sleep(2000);
  await sample('end');
} catch (e) {
  step(`error: ${String(e).slice(0, 300)}`);
  fail = fail || `error: ${String(e).slice(0, 120)}`;
}
try { await page.screenshot({ path: F('.png') }); } catch { /* ignore */ }
res.herclogTail = await ev(() => window.mvs.herclog().slice(-60).map(([t, l]) => `${(t / 1000).toFixed(1)} ${l}`)).catch(() => null);
res.consoleText = await ev(() => window.mvs.text('console')).catch(() => null);
res.tsoText = await ev(() => window.mvs.text('tso1')).catch(() => null);
res.pageErrors = pageErrors;
res.end = new Date().toISOString();
const serious = res.problems.filter((p) => !/reply > 10 s/.test(p.kind));
res.result = fail ? `FAIL ${fail}` : serious.length ? `PROBLEMS ${[...new Set(serious.map((p) => p.kind))].join('; ')}` : 'ok';
save(); hercOut.end(); conOut.end();
console.log(`SOAK-RESULT ${TAG} ${res.result} samples=${samples.length} cmds=${res.cmds.length} jobs=${res.jobs.length} problems=${res.problems.length}`);
clearTimeout(killer);
await br.close().catch(() => {});
process.exit(fail ? 1 : 0);
