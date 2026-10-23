#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// End-to-end test of the dev bundle web/dist-dev: the visitor page with the
// wasm Hercules runtime, in headless Chromium or Firefox (Playwright). Runs on the build host.
//
// Usage: node scripts/e2e.mjs <chromium|firefox|webkit> <page url> <out dir> <tag> [--shutdown] [--timeout <s>] [--load-timeout <s>] [--channel chrome]
// Env:   PLAYWRIGHT_DIR  dir whose node_modules has playwright 1.56.1 (default <repo>/web/app)
//
// Checks, in order (any failure ends the run with exit 1):
//   1. page load; with no COOP/COEP headers coi-serviceworker reloads once; crossOriginIsolated === true;
//      backend is wasm; the Hercules log pane is hidden (no ?debug=1)
//   2. the Console tab (0010) shows the Hercules logo before the IPL (0010 connected before IPL)
//   3. NIP on the Console tab: IEA101A SPECIFY SYSTEM PARAMETERS
//   4. the page answers IEA101A with ENTER on 0010 (operator event), roll mode is set
//   5. IKT007I: the page switches to the TSO tab by itself (IKT007I seen on 0010, not the log fallback)
//   6. TSO logon MVSCE02 / PASS4U with the keyboard, `time` -> TIME-hh:mm:ss ... line
//   7. `D T` typed on the Console tab -> IEE136I reply on 0010
//   8. TSO logoff
//   9. no main-thread long task over 200 ms after the load event (Chromium; Firefox has no longtask API)
//      and, in every browser, no main-thread stall over 200 ms after the load event: a setTimeout(16 ms)
//      heartbeat on the page's main thread records each gap; stall = gap - 16 ms (works in Firefox/WebKit)
//  9b. wasm memory (INITIAL_MEMORY, fixed) >= sbrk peak * 1.25 in this run
//  10. no console errors / page errors; Hercules log: no HHC....E/S, HHC....W only on the allowlist;
//      wasm pthread pool not exhausted (Workers created <= pool size)
//  11. (--shutdown) MVS shutdown typed on 0010 by the page, then Hercules quit (HHC01412I)
// Additional checks, active when the bundle has a lazy manifest (format 2) / persistence on:
//  12. DASD bytes: every request under /dasd/ is counted (Playwright request + requestfinished: body +
//      headers; with PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 Chromium also reports the requests of
//      coi-serviceworker). "Before IKT007I" = requests STARTED before the IKT007I log line (full size counted).
//      Cold visit (default): bytes before IKT007I <= working set (--ws-bytes, default 4,174,729)
//      + 20%. Warm visit (--warm, with --profile of an earlier visit): DASD bytes of the whole visit < 1 MB.
//      If Playwright cannot see the service worker's requests (Firefox on a host without headers), the
//      runtime's own counters (stats().lazy.netBytes at IKT007I + manifest + metadata) are used.
//  13. lazy read path: gapBytes 0, lazy errors 0
//  14. persistence (page default on): persist enabled; after --shutdown: the marker is clean, OPFS has one
//      shadow file per volume (<vol>_1.cckd, no _2 = no sf+ file), and SMF is off (IEE351I, never IEE362A)
//  15. --expect-no-ist068i: 0 IST068I lines on the 0010 console (LCL400 trimmed image)
//  17. --expect-outsink: stats().output shows the 2 outsink dirs (printers, punchcards), and
//      the heap used by output files is at most 64 KiB per file. WebKit warm visits: HTTP-cache hits that Playwright
//      WebKit reports with a body size (Date header older than the request) count 0 bytes (res.dasdNet.cacheHits).
//  18. --expect-srmtune: stats().srmTune shows that the runtime set the MVS SRM
//      time-driven interval at TSO ready (wasm_main.c srm_tune(); TSO under a CPU-bound job).
//  16. --expect-no-ist025i: 0 IST025I lines on 0010 and in the log (VTAMLIB stub image);
//      header status text not cut off (no clipped text, full text in the title); after --shutdown no tab button
//      keeps the focus. Save state: with persist, the page's window.mvs.saving() is recorded.
// Options: --profile <dir> (persistent browser profile: Cache Storage, HTTP cache, OPFS and the
// marker stay for the next run), --warm, --ws-bytes <n>, --expect-no-ist068i, --expect-persist.
// Env E2E_THROTTLE=<down Mbit/s>,<up Mbit/s>,<latency ms> (Chromium, CDP; not applied to service-worker requests).
// Records: load time, IPL -> IKT007I (log and 0010), IKT007I -> READY, wasm heap peak / memory,
// JS heap (Chromium performance.memory), RSS of the browser process tree.
// Output: <out>/e2e-<tag>.json, screenshots <out>/<tag>-<step>.png
// Diagnosis options ( the checks are unchanged): --trace <file.json.gz> (Chromium: Chrome trace of
// the run, stalls/long tasks explained in res.traceSummary, see scripts/trace-stall.mjs), --trace-keep,
// --trace-min-stall <ms> (default 50), --exe <browser executable>, --no-chrome-models (Google Chrome: no
// Optimization Guide model downloads in a new profile; see below).
// --settle-s <s> waits <s> seconds on about:blank after the browser start, before the navigation
// (a new Google Chrome profile installs its models 10-14 s after the start; with --settle-s 30 this is over before the
// page opens, as in a visitor's Chrome that already ran). The trace (--trace) covers the settle time too, and
// res.traceSummary.modelInstall gives the install window in page time (negative = before the navigation).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= '1';   // count coi-serviceworker requests (Chromium)
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.join(here, '..', 'web', 'app'), 'package.json'));
const { chromium, firefox, webkit } = require('playwright');

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const [B, URL0, OUT, TAG] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--timeout', '--channel', '--load-timeout', '--profile', '--ws-bytes', '--trace', '--exe', '--trace-min-stall', '--settle-s'].includes(argv[i - 1])));
if (!['chromium', 'firefox', 'webkit'].includes(B) || !URL0 || !OUT || !TAG) {
  console.error('usage: e2e.mjs <chromium|firefox|webkit> <url> <out dir> <tag> [--shutdown] [--timeout s] [--no-shots]'); process.exit(2);
}
const SHUTDOWN = flag('shutdown');
const TIMEOUT_S = Number(opt('timeout', 900));
const W_ALLOW = new Set(['HHC00112W', 'HHC00898W', 'HHC00826W']);   // allowlist (wasm)
// Persistence: after a dirty start (a session closed without Shut down) CCKD may check and repair its own
// shadow files: HHC00363W cdevhdr inconsistencies, HHC00364W forcing check level 1, HHC00368W free space
// errors. Allowed only when the page reports a dirty start.
const W_ALLOW_DIRTY = new Set(['HHC00363W', 'HHC00364W', 'HHC00368W']);
const PROFILE = opt('profile', null);
const WARM = flag('warm');
const WS_BYTES = Number(opt('ws-bytes', 4174729));   // boot working set 4,166,543 (dasd/manifest/working-set.json) + WORK00 8,186 (dasd/manifest/work00)
const POOL = 24;
fs.mkdirSync(OUT, { recursive: true });

const T0 = Date.now();
const el = () => (Date.now() - T0) / 1000;
const res = { browser: B, url: URL0, tag: TAG, date: new Date().toISOString(), steps: [], checks: {}, ok: false };
const step = (name, extra = {}) => {
  res.steps.push({ t: Number(el().toFixed(2)), name, ...extra });
  console.log(`[${el().toFixed(1)}s] ${name}`, Object.keys(extra).length ? JSON.stringify(extra) : '');
};
const check = (name, pass, evidence) => { res.checks[name] = { pass: !!pass, evidence }; if (!pass) throw new Error(`check failed: ${name}: ${JSON.stringify(evidence)}`); };
const killer = setTimeout(() => { console.log(`E2E TIMEOUT after ${TIMEOUT_S} s`); process.exit(3); }, TIMEOUT_S * 1000);

// RSS of all descendants of this node process (the browser tree), from /proc.
function treeRss() {
  if (!fs.existsSync('/proc/self/stat')) return { sumMiB: 0, maxProcMiB: 0 };   // not Linux (e.g. the Mac): no RSS
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(d));
    } catch { /* gone */ }
  }
  let sum = 0, max = 0;
  const walk = (p) => { for (const c of kids.get(p) || []) {
    try { const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${c}/status`, 'utf8')); const kb = m ? Number(m[1]) : 0; sum += kb; max = Math.max(max, kb); } catch { /* gone */ }
    walk(c); } };
  walk(process.pid);
  return { sumMiB: Math.round(sum / 1024), maxProcMiB: Math.round(max / 1024) };
}
let rssPeak = { sumMiB: 0, maxProcMiB: 0 };
const sampler = setInterval(() => { const r = treeRss(); rssPeak = { sumMiB: Math.max(rssPeak.sumMiB, r.sumMiB), maxProcMiB: Math.max(rssPeak.maxProcMiB, r.maxProcMiB) }; }, 1000);

const launchOpts = B === 'firefox' ? { firefoxUserPrefs: { 'dom.max_script_run_time': 0 } } : {};
if (opt('channel')) launchOpts.channel = opt('channel');   // e.g. --channel chrome: the installed Google Chrome
if (opt('exe')) launchOpts.executablePath = opt('exe');   // e.g. a fresh Chrome for Testing install
// --no-chrome-models (Google Chrome only). About 11-13 s after the start of a NEW profile,
// Google Chrome 155 downloads its Optimization Guide prediction models (11 downloads, 33 unzips in new utility
// processes, language-detection model install; seen in the traces of every fresh-profile cold run on the Mac, not in
// Chrome for Testing and not in Playwright's headless shell). Playwright's --disable-background-networking and
// --disable-component-update do not stop it. This flag adds the Optimization Guide features to Playwright's own
// --disable-features list (the last --disable-features switch wins, so the list is merged).
if (flag('no-chrome-models') && B === 'chromium') {
  const sw = require(path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/server/chromium/chromiumSwitches.js'));
  const base = sw.chromiumSwitches(false).find((a) => a.startsWith('--disable-features=')) ?? '--disable-features=';
  launchOpts.args = [...(launchOpts.args ?? []), `${base},OptimizationGuideModelDownloading,OptimizationHints,OptimizationHintsFetching,OptimizationTargetPrediction,OptimizationGuideOnDeviceModel`];
}
let br, ctx;
if (PROFILE) {   // persistent profile (a second visit sees the same Cache Storage / HTTP cache / OPFS / localStorage)
  ctx = await ({ chromium, firefox, webkit })[B].launchPersistentContext(PROFILE, { ...launchOpts, viewport: { width: 1280, height: 860 } });
  br = { version: () => ctx.browser()?.version?.() ?? '', close: () => ctx.close() };
} else {
  br = await ({ chromium, firefox, webkit })[B].launch(launchOpts);
  ctx = await br.newContext({ viewport: { width: 1280, height: 860 } });
}
res.browserVersion = `${B} ${br.version()}`;
res.profile = PROFILE; res.warm = WARM;
const page = ctx.pages()[0] || await ctx.newPage();
// --trace <file.json.gz> (Chromium) records a Chrome trace (CDP Tracing, all processes) of the
// whole run. At the end the run's stalls over 50 ms (--trace-min-stall) and long tasks over 50 ms are explained from it
// (res.traceSummary: per window the busy time and CPU time of the page's main thread, its biggest events, and the
// busiest threads of every process). The trace file is kept when a stall over 100 ms happened or with --trace-keep. --exe <path>: browser executable.
const TRACE = B === 'chromium' ? opt('trace', null) : null;
let traceCdp = null;
if (TRACE) {
  traceCdp = await ctx.newCDPSession(page);
  await traceCdp.send('Tracing.start', { transferMode: 'ReturnAsStream', streamCompression: 'gzip', traceConfig: {
    recordMode: 'recordUntilFull', traceBufferSizeInKb: 400 * 1024,
    includedCategories: ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing',
      'v8', 'v8.execute', 'disabled-by-default-v8.gc', 'blink', 'cc', 'gpu', 'viz', 'renderer.scheduler', 'loading',
      'disabled-by-default-devtools.timeline.frame', 'benchmark', '__metadata'] } });
}
// DASD bytes. Start time (epoch ms) of each request; sizes when it finishes.
const net = { dasd: [], other: 0, runtime: 0, swAnswered: 0, cacheHits: 0 };
const reqStart = new Map();
ctx.on('request', (r) => reqStart.set(r, Date.now()));
ctx.on('requestfinished', async (r) => {
  const t0 = reqStart.get(r) ?? Date.now(); reqStart.delete(r);
  let sz = null; try { sz = await r.sizes(); } catch { /* gone */ }
  const resp = await r.response().catch(() => null);
  if (resp && resp.fromServiceWorker && resp.fromServiceWorker()) { net.swAnswered++; return; }   // counted on the SW's own request
  let bytes = sz ? sz.responseBodySize + sz.responseHeadersSize : 0;
  // Playwright WebKit reports a body size for HTTP-cache hits too (an
  // immutable / max-age file that WebKit serves without a request; the server log shows no request). A response
  // whose Date header is more than 5 s older than the request start was not made by the server for this request:
  // count it as a cache hit (0 bytes). WebKit only: the other browsers report cache hits with 0 bytes, and a CDN
  // may serve a real transfer with an old Date.
  let cacheHit = false;
  if (B === 'webkit' && resp) {
    const d = Date.parse(resp.headers()['date'] ?? '');
    if (Number.isFinite(d) && d < t0 - 5000) { cacheHit = true; bytes = 0; net.cacheHits++; }
  }
  let u; try { u = new URL(r.url()); } catch { return; }
  if (u.pathname.includes('/dasd/')) net.dasd.push({ t0, bytes, path: u.pathname.replace(/^.*\/dasd\//, ''), status: resp?.status() ?? null, ...(cacheHit ? { cacheHit } : {}) });
  else if (u.pathname.includes('/runtime/')) net.runtime += bytes;
  else net.other += bytes;
});
// E2E_THROTTLE=<down Mbit/s>,<up Mbit/s>,<latency ms> -> CDP Network.emulateNetworkConditions
// (Chromium only; it also applies to the fetches of the page's workers, e.g. the DASD I/O worker).
if (process.env.E2E_THROTTLE) {
  if (B !== 'chromium') { console.error('E2E_THROTTLE needs chromium'); process.exit(2); }
  const [d, u, l] = process.env.E2E_THROTTLE.split(',').map(Number);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: l, downloadThroughput: d * 1e6 / 8, uploadThroughput: u * 1e6 / 8 });
  res.throttle = { downMbit: d, upMbit: u, latencyMs: l };
}
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
// WebKit reports an unknown <meta name=viewport> key as a console error; the key is for Chrome on Android
// (interactive-widget=resizes-content, on-screen keyboard), so this message is expected and is recorded, not failed.
const ERR_ALLOW = [/^Viewport argument key "interactive-widget" not recognized and ignored\.$/];
const allowedErrors = [];
// the test's own probe for ./entry.json gets a 404 on a bundle without entry.json;
// Chromium logs that as a console error with the URL in location(): recorded, not failed.
const OWN_PROBE = /\/entry\.json(\?|$)/;
page.on('console', (m) => { if (m.type() !== 'error') return; const t = m.text();
  if (ERR_ALLOW.some((re) => re.test(t)) || OWN_PROBE.test(m.location()?.url ?? '')) allowedErrors.push(t); else errors.push(`console.error: ${t}`); });
page.on('crash', () => errors.push('page crash'));
// which URL failed (a console 'Failed to load resource' line has no URL)
page.on('response', (r) => { if (r.status() >= 400 && !OWN_PROBE.test(r.url())) errors.push(`http ${r.status()} ${r.url()}`); });
await page.addInitScript(() => {
  // what the visitor sees while the system loads: #loader-text values, then the header #dasd-status
  window.__loaderTexts = []; window.__dasdTexts = [];
  const iv = setInterval(() => {
    const e = document.getElementById('loader-text'), l = document.getElementById('loader');
    if (e && l && !l.hidden) { const a = window.__loaderTexts, t = e.textContent; if (!a.length || a[a.length - 1][1] !== t) a.push([Math.round(performance.now()), t]); }
    const d = document.getElementById('dasd-status');
    if (d && !d.hidden) { const a = window.__dasdTexts, t = d.textContent; if (!a.length || a[a.length - 1][1] !== t) a.push([Math.round(performance.now()), t]); }
    if (window.__dasdTexts.length > 300 || performance.now() > 120000) clearInterval(iv);
  }, 50);
  window.__lt = { supported: false, tasks: [], loadAt: null };
  addEventListener('load', () => { window.__lt.loadAt = performance.now(); });
  // main-thread heartbeat (all browsers): a 16 ms timer chain; a late tick = the main thread was busy
  window.__hb = { period: 16, ticks: 0, maxStallMs: 0, maxStallAfterLoadMs: 0, stalls: [] };
  let last = performance.now();
  const tick = () => {
    const now = performance.now(), stall = now - last - window.__hb.period;
    window.__hb.ticks++;
    if (stall > window.__hb.maxStallMs) window.__hb.maxStallMs = Math.round(stall);
    if (window.__lt.loadAt != null && last >= window.__lt.loadAt && stall > window.__hb.maxStallAfterLoadMs) window.__hb.maxStallAfterLoadMs = Math.round(stall);
    if (stall > 50) window.__hb.stalls.push([Math.round(last), Math.round(stall)]);
    last = now; setTimeout(tick, window.__hb.period);
  };
  setTimeout(tick, 16);
  try {
    window.__lt.supported = (PerformanceObserver.supportedEntryTypes || []).includes('longtask');
    if (window.__lt.supported) new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.tasks.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* no PerformanceObserver */ }
});
let navigations = 0;
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });

const ev = (fn, arg) => page.evaluate(fn, arg);
const text = (id) => ev((i) => window.mvs?.text(i) ?? '', id);
async function waitText(id, re, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const t = await text(id).catch(() => '');
    if (re.test(t)) return t;
    if (Date.now() > end) { console.log(`--- ${id} screen at timeout:\n${t}`); throw new Error(`timeout (${ms / 1000} s) waiting for ${what ?? re} on ${id}`); }
    await page.waitForTimeout(150);
  }
}
async function waitFn(fn, arg, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await ev(fn, arg).catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout (${ms / 1000} s) waiting for ${what}`);
    await page.waitForTimeout(150);
  }
}
// Each test screenshot's window is recorded in page time (heartbeat.shots), and every heartbeat stall over
// 50 ms is listed with the screenshot it overlaps, if any (heartbeat.stallsOver50Attributed), for diagnosis
// only: the stall check counts all stalls. A test checked the idea that the one 265 ms Mac stall
// was caused by the screenshot taken at IKT007I: refuted (246 screenshots every 250 ms during the IPL on Mac
// Chrome, 0 stalls over 50 ms). --no-shots skips all screenshots except the one after a failure.
const NO_SHOTS = flag('no-shots');
const shots = [];
const pnow = () => (res.timeOrigin ? Math.round(Date.now() - res.timeOrigin) : null);
const shot = async (name, always = false) => {
  if (NO_SHOTS && !always) return;
  const a = pnow();
  await page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) });
  shots.push([name, a, pnow()]);
};
const unlocked = (id) => waitFn((i) => window.mvs.unlocked(i), id, 30000, `${id} keyboard unlocked`);
async function typeLine(id, s) { await unlocked(id); await page.keyboard.type(s, { delay: 15 }); await page.keyboard.press('Enter'); }
const herclog = () => ev(() => window.mvs?.herclog() ?? []).catch(() => []);
const ikt = { at: null, poll: 0 };
function dasdNet() {   // DASD bytes, before IKT007I and in total
  const tIkt = ikt.at && res.timeOrigin ? res.timeOrigin + ikt.at.t : null;
  const before = net.dasd.filter((x) => tIkt != null && x.t0 <= tIkt);
  const o = { allBytes: net.dasd.reduce((a, x) => a + x.bytes, 0), allReq: net.dasd.length,
    beforeIktWire: before.reduce((a, x) => a + x.bytes, 0), beforeIktReq: before.length, ikt007iEpoch: tIkt,
    runtimeBytes: net.runtime, otherBytes: net.other, swAnswered: net.swAnswered, status304: net.dasd.filter((x) => x.status === 304).length,
    cacheHits: net.cacheHits, dasdCacheHits: net.dasd.filter((x) => x.cacheHit).length };
  const lz = ikt.at?.lazy;
  const m = res.manifest || {};
  // runtime view: chunk bytes the I/O worker fetched (not from Cache Storage) + manifest + metadata blob
  o.beforeIktRuntime = lz ? lz.netBytes + (m.metaSize || 0) + (m.bytes || 0) : null;
  const chunkReqSeen = before.filter((x) => /^c\//.test(x.path)).length;
  // Playwright sees the chunk requests (headers mode; Chromium also through the SW) -> wire bytes; else the runtime's count
  if (chunkReqSeen > 2 || o.beforeIktRuntime == null) { o.beforeIktBytes = o.beforeIktWire; o.source = 'wire (Playwright)'; }
  else { o.beforeIktBytes = Math.max(o.beforeIktWire, o.beforeIktRuntime); o.source = 'runtime counters (service-worker requests not visible to Playwright)'; }
  return o;
}

try {
  // 1. load + isolation
  const SETTLE_S = Number(opt('settle-s', 0));
  if (SETTLE_S > 0) { res.settleS = SETTLE_S; step(`settle ${SETTLE_S} s on about:blank before the navigation`); await page.waitForTimeout(SETTLE_S * 1000); }
  await page.goto(URL0);
  await waitFn(() => window.mvs && !document.getElementById('app').hidden, null, Number(opt('load-timeout', 120)) * 1000, 'app visible (download + Hercules start)');
  const iso = await ev(() => ({ crossOriginIsolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer === 'function',
    swControlled: !!navigator.serviceWorker?.controller, backend: window.mvs.backend(),
    debugPaneHidden: document.getElementById('debug').hidden && document.getElementById('herclog').textContent === '',
    hercInputVisible: !!document.getElementById('hcmd')?.offsetParent,
    loadAt: window.__lt.loadAt, appAt: performance.now() }));
  iso.navigations = navigations;
  step('page loaded, app visible', iso);
  // snapshot of the runtime's lazy DASD counters when IKT007I appears in the Hercules log
  res.timeOrigin = await ev(() => performance.timeOrigin);
  ikt.poll = setInterval(async () => {
    if (ikt.at) return;
    const v = await ev(() => { const h = window.mvs?.herclog() ?? []; const x = h.find(([, l]) => /IKT007I/.test(l));
      return x ? { t: x[0], lazy: window.mvs.stats()?.lazy ?? null } : null; }).catch(() => null);
    if (v && !ikt.at) { ikt.at = v; clearInterval(ikt.poll); }
  }, 100);
  check('crossOriginIsolated', iso.crossOriginIsolated && iso.sab, iso);
  check('backend wasm', iso.backend === 'wasm', iso.backend);
  if (!URL0.includes('debug=1')) check('Hercules pane hidden without ?debug=1', iso.debugPaneHidden && !iso.hercInputVisible, iso);
  const pageLog = await ev(() => window.mvs.log());
  res.loadDetail = pageLog.filter((l) => /\[status\]|webload/.test(l)).slice(0, 10);

  // 2. console 0010 before IPL
  await waitText('console', /Welcome to MVS Community Edition|Hercules Version/, 30000, '0010 logo');
  step('Console tab: 0010 connected, logo shown before IPL');
  await shot('console-logo');

  // 3./4. NIP + IEA101A
  await waitText('console', /IEA101A SPECIFY SYSTEM PARAMETERS/, 90000, 'NIP IEA101A');
  step('NIP on Console tab: IEA101A');
  await shot('nip');
  await waitFn(() => window.mvs.events().some((e) => /IEA101A answered/.test(e.what)), null, 30000, 'IEA101A answered by the page');
  const after101 = await text('console');
  step('IEA101A answered with ENTER on 0010 by the page');
  check('IEA101A answered on 0010', true, (await ev(() => window.mvs.events())).find((e) => /IEA101A answered/.test(e.what)));
  await waitFn(() => window.mvs.events().some((e) => /roll mode/.test(e.what)), null, 90000, 'roll mode');
  step('roll mode set on 0010');

  // 5. IKT007I -> auto-switch to TSO. The page connects TSO at the first IKT007I but
  // selects the TSO tab only after IKT007I is on the 0010 screen (+ switchdelay, default 1.5 s).
  const newSwitch = await ev(() => 'consoleIkt' in window.mvs.timings());
  if (newSwitch) {
    await waitFn(() => window.mvs.timings().consoleIkt > 0 || window.mvs.timings().switched > 0, null, 180000, 'IKT007I on 0010 (or the switch)');
    const before = await ev(() => ({ active: window.mvs.active(), switched: window.mvs.timings().switched }));
    if (before.active === 'console' && !before.switched) await shot('console-ikt007i');
    res.consoleAtIkt = before;
  }
  await waitFn(() => window.mvs.active() === 'tso1', null, 180000, 'auto-switch to TSO');
  const events = await ev(() => window.mvs.events());
  const tm = await ev(() => window.mvs.timings());
  const hl = await herclog();
  const tIplLog = hl.find(([, l]) => /^HHC01603I ipl /i.test(l))?.[0];
  const tIktLog = hl.find(([, l]) => /IKT007I/.test(l))?.[0];
  const src = events.find((e) => /IKT007I seen/.test(e.what))?.what;
  res.timing = {
    navToAppS: Number((iso.appAt / 1000).toFixed(2)),   // navigation start -> app visible: DASD download + sha256 + Hercules start
    iplToIkt007iLogS: tIplLog && tIktLog ? Number(((tIktLog - tIplLog) / 1000).toFixed(2)) : null,
    iplRequestToTsoSwitchS: Number(((tm.tso - tm.started) / 1000).toFixed(2)),   // TSO ready (terminal connected)
    ...(newSwitch ? {
      iplRequestToConsoleIktS: tm.consoleIkt ? Number(((tm.consoleIkt - tm.started) / 1000).toFixed(2)) : null,
      iplRequestToTabSwitchS: Number(((tm.switched - tm.started) / 1000).toFixed(2)),
      switchReason: tm.switchReason,
    } : {}),
  };
  step('auto-switched to TSO at IKT007I', { source: src, ...res.timing });
  check('auto-switch to TSO from IKT007I (Hercules log or 0010)', /IKT007I seen \((console 0010|Hercules log)/.test(src || ''), src);
  if (newSwitch) check('TSO tab selected only after IKT007I is on the 0010 screen', tm.consoleIkt > 0 && tm.switched >= tm.consoleIkt, { consoleIkt: tm.consoleIkt, switched: tm.switched, why: tm.switchReason, atIkt: res.consoleAtIkt });
  // the master console shows IKT007I too (roll mode delivers it some seconds after the log)
  await waitFn(() => window.mvs.seen().some((l) => /IKT007I/.test(l)), null, 60000, 'IKT007I on the 0010 screen');
  step('IKT007I shown on the Console tab (0010)');
  check('IKT007I on the Console tab', true, (await ev(() => window.mvs.seen())).find((l) => /IKT007I/.test(l)).trim());
  res.nipLines = (await ev(() => window.mvs.seen())).filter((l) => /\bIEA\d{3}[AIDE]\b/.test(l)).map((l) => l.trim()).slice(0, 12);
  check('NIP messages on the Console tab', res.nipLines.some((l) => /IEA101A/.test(l)), res.nipLines);
  await waitText('tso1', /CLEAR the screen or hit ENTER|TSO Logon ===>/, 30000, 'TSO welcome');
  await shot('tso-welcome');
  // the user can switch back and forth
  await page.click('button.tab[data-tab="console"]');
  await waitFn(() => window.mvs.active() === 'console', null, 3000, 'console tab selected');
  await page.click('button.tab[data-tab="tso1"]');
  await waitFn(() => window.mvs.active() === 'tso1', null, 3000, 'tso tab selected');
  step('switched Console <-> TSO by clicks');

  // 6. TSO logon + time
  let t = await waitText('tso1', /CLEAR the screen or hit ENTER|TSO Logon ===>/, 30000, 'logon screen');
  if (!/TSO Logon ===>/.test(t)) { await unlocked('tso1'); await page.keyboard.press('Enter'); await waitText('tso1', /TSO Logon ===>/, 30000, 'TSO Logon ===>'); }
  const tLogon = Date.now();
  await typeLine('tso1', 'logon mvsce02');
  await waitText('tso1', /ENTER CURRENT PASSWORD FOR MVSCE02/, 60000, 'password prompt');
  await typeLine('tso1', 'PASS4U');
  // Retype safeguard (added after the page's own fix, web/app/src/termview.ts PW_RESEND): if the
  // prompt is still there after 20 s with nothing after it, MVS dropped the password: type it again once and count it
  // (res.passwordRetries). Reported, not a failure.
  res.passwordRetries = 0;
  {
    const end = Date.now() + 20000;
    let more = false;
    while (Date.now() < end) {
      const s2 = await ev(() => window.mvs.text('tso1'));
      if (!/ENTER CURRENT PASSWORD/.test(s2) || /^\s*\*\*\*\s*$|READY\s*$|IKJ\d{5}/m.test(s2)) { more = true; break; }
      await page.waitForTimeout(250);
    }
    if (!more) {
      res.passwordRetries++;
      step('password still asked for after 20 s: typed again (retype safeguard)', { pw: await ev(() => (window.mvs.typeahead ? window.mvs.typeahead('tso1') : null)) });
      await typeLine('tso1', 'PASS4U');
    }
  }
  for (let i = 0; ; i++) {
    t = await waitText('tso1', /^\s*\*\*\*\s*$|READY\s*$|IN USE|REJECTED|NOT AUTHORIZED/m, 90000, 'READY');
    if (/IN USE|REJECTED|NOT AUTHORIZED/.test(t)) throw new Error(`logon failed: ${t.split('\n').find((l) => /IN USE|REJECTED|NOT AUTH/.test(l))}`);
    if (/READY\s*$/m.test(t)) break;
    if (i > 20) throw new Error('no READY');
    await unlocked('tso1'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  }
  res.timing.logonToReadyS = Number(((Date.now() - tLogon) / 1000).toFixed(2));
  // times from navigation start (performance.now() of the final navigation; with coi-serviceworker the second one)
  res.timing.navToReadyS = Number(((await ev(() => performance.now())) / 1000).toFixed(2));
  if (ikt.at) res.timing.navToIkt007iS = Number((ikt.at.t / 1000).toFixed(2));
  step('TSO logon MVSCE02 READY', { s: res.timing.logonToReadyS });
  await unlocked('tso1'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await typeLine('tso1', 'time');
  t = await waitText('tso1', /TIME-\d\d:\d\d:\d\d [AP]M\. CPU-\S+ SERVICE-\d+ SESSION-\S+ \w+ \d+,\d{4}/, 60000, 'TIME output');
  const timeLine = t.split('\n').find((l) => /TIME-/.test(l)).trim();
  step('TSO time', { line: timeLine });
  check('TSO time output', true, timeLine);
  const st = await ev(() => document.getElementById('ipl-status')?.textContent ?? '');
  check('status bar says TSO ready (not an IPL phase) after the logon', /^TSO ready/.test(st), st);
  await shot('tso');
  // 3270 status line (OIA) under the screen: '4' (reverse) 'A' (underlined) ... cursor rrr/ccc
  const oia = await ev(() => (window.mvs.oia ? { tso1: window.mvs.oia('tso1'), console: window.mvs.oia('console') } : null));
  if (oia) { res.oia = oia; check('OIA: 4 A and cursor position', /^4A\s.*\d{3}\/\d{3}$/.test(oia.tso1), oia); }

  // 7. D T on the Console tab
  await page.click('button.tab[data-tab="console"]');
  await unlocked('console');
  await page.keyboard.press('Home');
  await typeLine('console', 'd t');
  const dt = await waitFn(() => window.mvs.seen().find((l) => /IEE136I/.test(l)), null, 30000, 'IEE136I reply to D T');
  step('Console: D T', { line: dt.trim() });
  check('D T on Console tab answered (IEE136I)', true, dt.trim());
  res.consoleNoise = await ev(() => ({ IST068I: window.mvs.seen().filter((l) => /IST068I/.test(l)).length,
    IEA000I: window.mvs.seen().filter((l) => /IEA000I/.test(l)).length, lines: window.mvs.seen().length,
    IST025I: window.mvs.seen().filter((l) => /IST025I/.test(l)).length,
    IST025Ilog: window.mvs.herclog().filter(([, l]) => /IST025I/.test(l)).length }));
  await page.waitForTimeout(500);
  await shot('console');

  // 8. logoff
  await page.click('button.tab[data-tab="tso1"]');
  await unlocked('tso1'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await typeLine('tso1', 'logoff');
  await waitText('tso1', /LOGGED OFF|TSO Logon ===>|CLEAR the screen/, 60000, 'logoff');
  step('TSO logoff');
  check('TSO logoff', true, 'logon screen back');

  // QPL notice: the About dialog links SOURCE.txt, the QPL text and the source index; all must be in the bundle (checked here, after the
  // IPL steps: over a slow link the fetches would delay the 0010 logo check past the start of the IPL)
  const lic = await ev(async () => { const out = {}; for (const a of document.querySelectorAll('#about a[href^="./"]')) {
    const r = await fetch(a.getAttribute('href'), { cache: 'no-store' }); out[a.getAttribute('href')] = r.status; } return out; });
  check('About links to license / source notice resolve (QPL)', ['./SOURCE.txt', './licenses/hercules-QPL-1.0.html', './source/'].every((h) => lic[h] === 200), lic);
  // 9./10. metrics and log checks (before the optional shutdown)
  res.stats = await ev(() => window.mvs.stats());
  res.jsHeap = await ev(() => (performance.memory ? { usedMiB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
    totalMiB: +(performance.memory.totalJSHeapSize / 1048576).toFixed(1) } : null));
  const s = res.stats || {};
  res.memory = { wasmMemoryMiB: s.memoryBytes ? s.memoryBytes / 1048576 : null, sbrkPeakMiB: s.sbrkPeak ? +(s.sbrkPeak / 1048576).toFixed(1) : null,
    mallocPeakMiB: s.heapPeak ? +(s.heapPeak / 1048576).toFixed(1) : null, workersCreated: s.workersCreated, poolExhausted: s.poolExhausted };
  res.memory.sbrkPeakBytes = s.sbrkPeak ?? null; res.memory.memoryBytes = s.memoryBytes ?? null;
  res.memory.headroomPct = s.sbrkPeak && s.memoryBytes ? Number(((s.memoryBytes / s.sbrkPeak - 1) * 100).toFixed(1)) : null;
  check('wasm memory >= sbrk peak + 25%', s.sbrkPeak && s.memoryBytes >= 1.25 * s.sbrkPeak, res.memory);
  check('pthread pool not exhausted', s.workersCreated != null && s.workersCreated <= POOL && !s.poolExhausted, { workersCreated: s.workersCreated, pool: POOL });
  // output devices on the bounded outsink backend (src/wasm/outsink.cpp): printers/ + punchcards/
  res.output = s.output ?? null;
  if (flag('expect-outsink')) check('output devices on the bounded outsink backend (printers, punchcards)', s.output && s.output.dirs === 2 && s.output.files >= 1 && s.output.ringHeap <= s.output.files * 65536, s.output);
  // the runtime set the MVS SRM time-driven interval at TSO ready (srmTune)
  if (flag('expect-srmtune')) check('MVS SRM interval set at TSO ready (srmtune)', s.srmTune && s.srmTune.units > 0 && s.srmTune.routines >= 1, s.srmTune);
  // lazy DASD read path and download
  // a bundle from scripts/bundle.sh has a content-hashed manifest name, listed in ./entry.json
  res.manifest = await ev(async () => { try {
    let murl = './dasd/manifest.json';
    try { const e = await fetch('./entry.json', { cache: 'no-store' }); if (e.ok) murl = `./${(await e.json()).dasdManifest}`; } catch { /* no entry.json: older layout */ }
    const txt = await (await fetch(murl)).text(); const m = JSON.parse(txt);
    return { format: m.format, bytes: txt.length, volumes: m.volumes?.length ?? null, chunks: m.chunks?.length ?? null, metaSize: m.meta?.size ?? null, bootReadyBytes: m.boot?.readyBytes ?? null }; } catch (e) { return { error: String(e) }; } });
  res.lazy = s.lazy || null;
  for (let i = 0; i < 50 && !ikt.at; i++) await page.waitForTimeout(100);
  clearInterval(ikt.poll);
  if (res.manifest.format === 2) {
    check('lazy DASD: no reads outside the chunk map, no fetch errors', res.lazy && res.lazy.gapBytes === 0 && res.lazy.errors === 0, res.lazy && { gapBytes: res.lazy.gapBytes, errors: res.lazy.errors, refetch: res.lazy.refetch });
    res.dasdNet = dasdNet();
    if (WARM) {
      // wire = what Playwright saw; if it cannot see the service worker's requests (no /dasd/ request at all),
      // the runtime's chunk bytes + the whole manifest (as if fetched again) is the upper bound
      const wireSeen = res.dasdNet.allReq > 0;
      const rtBytes = (res.lazy.netBytes ?? 0) + (wireSeen ? 0 : (res.manifest.bytes || 0));
      const wireOk = res.dasdNet.allBytes < 1e6;
      const rtOk = rtBytes < 1e6;
      res.dasdNet.warmBytes = Math.max(res.dasdNet.allBytes, B === 'webkit' && !rtOk ? 0 : rtBytes);
      check('warm visit: < 1 MB of DASD over the network', wireOk && (rtOk || B === 'webkit'),
        { bytes: res.dasdNet.warmBytes, wireBytes: res.dasdNet.allBytes, wireReq: res.dasdNet.allReq, runtimeNetBytes: res.lazy.netBytes, runtimeCacheBytes: res.lazy.cacheBytes, runtimePlusManifest: wireSeen ? undefined : rtBytes,
          note: !rtOk && B === 'webkit' ? 'WebKit: Cache Storage keeps nothing (Playwright WebKit 26 on Linux); the chunks came from the HTTP cache (0 B on the wire)' : undefined });
    } else {
      const lim = Math.floor(WS_BYTES * 1.2);
      check('cold visit: DASD bytes before IKT007I <= boot working set + 20%', res.dasdNet.beforeIktBytes > 0 && res.dasdNet.beforeIktBytes <= lim,
        { bytes: res.dasdNet.beforeIktBytes, source: res.dasdNet.source, wire: res.dasdNet.beforeIktWire, runtime: res.dasdNet.beforeIktRuntime, limit: lim, workingSet: WS_BYTES });
    }
  }
  // persistence
  res.persist = await ev(() => window.mvs.persist?.() ?? null);
  const pinfo = res.persist?.info;
  res.dirtyStart = !!pinfo?.dirtyStart;
  if (flag('expect-persist')) check('persistence on (OPFS shadows, Web Lock)', pinfo?.enabled === true, pinfo && { enabled: pinfo.enabled, why: pinfo.why, lock: pinfo.lock, dirtyStart: pinfo.dirtyStart, reset: pinfo.reset });
  if (flag('expect-no-ist068i')) check('no IST068I on the Console tab (LCL400 trimmed)', res.consoleNoise.IST068I === 0, res.consoleNoise);
  if (flag('expect-no-ist025i')) check('no IST025I BLDL FAILED on the Console tab or in the log (VTAMLIB stub)', res.consoleNoise.IST025I === 0 && res.consoleNoise.IST025Ilog === 0, res.consoleNoise);
  const headerFit = () => ev(() => { const e = document.getElementById('ipl-status'); return { text: e.textContent, title: e.title, clipped: e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1, h: e.clientHeight }; });
  res.headerStatus = [await headerFit()];
  check('header status text not cut off', !res.headerStatus[0].clipped && (!res.headerStatus[0].title || res.headerStatus[0].title === res.headerStatus[0].text), res.headerStatus[0]);
  res.saving = await ev(() => window.mvs.saving?.() ?? null);

  if (SHUTDOWN) {
    const t1 = Date.now();
    await ev(() => { void window.mvs.shutdown(); });
    await waitFn(() => window.mvsState === 'off', null, 300000, 'shutdown complete (mvsState off)');
    await waitFn(() => window.mvs.herclog().some(([, l]) => /^HHC01412I/.test(l)), null, 30000, 'HHC01412I Hercules terminated');
    res.timing.shutdownS = Number(((Date.now() - t1) / 1000).toFixed(1));
    res.shutdownLines = (await ev(() => window.mvs.seen())).filter((l) => /IKT006I|IST102I|\$HASP099|\$HASP085|IEE334I/.test(l)).map((l) => l.trim());
    step('shutdown on 0010 + Hercules quit', { s: res.timing.shutdownS, lines: res.shutdownLines.length });
    check('shutdown through the master console', res.shutdownLines.some((l) => /IEE334I/.test(l)), res.shutdownLines);
    res.headerStatus.push(await headerFit());
    check('header status text not cut off after Shut down', !res.headerStatus[1].clipped, res.headerStatus[1]);
    res.focusAfterShutdown = await ev(() => { const a = document.activeElement; return { tag: a?.tagName, id: a?.id, cls: a?.className, tab: !!a?.closest?.('#tabs'), outline: a ? getComputedStyle(a).outlineStyle : null }; });
    check('no tab button keeps the focus after Shut down', !res.focusAfterShutdown.tab, res.focusAfterShutdown);
    await shot('shutdown');
    if (pinfo?.enabled) {
      await waitFn(() => window.mvs.persist().herculesStopped, null, 30000, 'Hercules stopped (persist)');
      const pst = await ev(() => window.mvs.persist());
      res.persistAfter = { cleanShutdown: pst.cleanShutdown, marker: pst.info?.marker?.state ?? null };
      res.shadows = await ev(() => window.mvs.shadows());
      const vols = res.manifest?.volumes ?? null;
      check('persist: clean shutdown recorded (marker clean)', pst.cleanShutdown === true, res.persistAfter);
      check('persist: one OPFS shadow per volume, no sf+ (_2) file', res.shadows.length === (vols ?? res.shadows.length) && res.shadows.length > 0 && res.shadows.every((f) => /_1\.cckd$/.test(f.name)), res.shadows);
    }
  }
  if (pinfo?.enabled) {
    const all = (await herclog()).map(([, l]) => l).concat(await ev(() => window.mvs.seen()));
    res.smf = { IEE351I: all.filter((l) => /IEE351I/.test(l)).length, IEE362A: all.filter((l) => /IEE362A/.test(l)).length };
    check('SMF off (seed shadow): IEE351I, no IEE362A', res.smf.IEE351I > 0 && res.smf.IEE362A === 0, res.smf);
  }
  res.ok = true;
} catch (e) {
  step('FAILED', { error: String(e) });
  await shot('failure', true).catch(() => {});
  for (const id of ['console', 'tso1']) res[`screen_${id}`] = await text(id).catch(() => '');
} finally {
  clearInterval(sampler);
  const lt = await ev(() => window.__lt).catch(() => null);
  const hb = await ev(() => window.__hb).catch(() => null);
  const hl = await herclog();
  const codes = {};
  for (const [, l] of hl) { const m = /^(HHC\d{5}[WES])\b/.exec(l); if (m) codes[m[1]] = (codes[m[1]] || 0) + 1; }
  const badCodes = Object.keys(codes).filter((c) => !c.endsWith('W') || !(W_ALLOW.has(c) || (res.dirtyStart && W_ALLOW_DIRTY.has(c))));
  res.loaderTexts = await ev(() => window.__loaderTexts).catch(() => null);
  res.dasdTexts = await ev(() => { const a = window.__dasdTexts || []; return a.length > 8 ? [...a.slice(0, 4), ...a.slice(-4)] : a; }).catch(() => null);
  if (!res.dasdNet) res.dasdNet = dasdNet();
  res.hhcWES = codes;
  res.longtasks = lt ? { supported: lt.supported, loadAtMs: lt.loadAt, count: lt.tasks.length,
    maxMs: Math.max(0, ...lt.tasks.map((x) => x[1])),
    over200AfterLoad: lt.tasks.filter(([st, d]) => d > 200 && st >= (lt.loadAt ?? 0)), tasks: lt.tasks.slice(0, 50) } : null;
  res.heartbeat = hb ? { ticks: hb.ticks, maxStallMs: hb.maxStallMs, maxStallAfterLoadMs: hb.maxStallAfterLoadMs,
    stallsOver50: hb.stalls.length, stalls: hb.stalls.slice(0, 50), stallsOver200AfterLoad: hb.stalls.filter(([st, d]) => d > 200 && st >= (lt?.loadAt ?? 0)) } : null;
  // A stall [last tick, gap] overlaps a test screenshot [start, end] (page ms, 20 ms slack for the clocks).
  const inShot = ([st, d]) => shots.find(([, a, b]) => a != null && b != null && st < b + 20 && st + hb.period + d > a - 20)?.[0] ?? null;
  if (res.heartbeat) {
    res.heartbeat.shots = shots;
    res.heartbeat.noShots = NO_SHOTS;
    res.heartbeat.stallsOver50Attributed = hb.stalls.slice(0, 50).map((x) => [...x, inShot(x)]);
    res.heartbeat.stallsOver200DuringShots = res.heartbeat.stallsOver200AfterLoad.filter((x) => inShot(x)).map((x) => [...x, inShot(x)]);
    res.heartbeat.longtasks = lt ? lt.tasks.slice(0, 50) : null;
  }
  res.errors = errors;
  res.allowedConsoleErrors = allowedErrors;
  res.rssPeak = rssPeak;
  res.events = await ev(() => window.mvs?.events() ?? []).catch(() => []);
  res.pageLog = (await ev(() => window.mvs?.log() ?? []).catch(() => [])).slice(-60);
  fs.writeFileSync(path.join(OUT, `herc-${TAG}.log`), hl.map(([t, l]) => `+${String(Math.round(t)).padStart(7)} ${l}`).join('\n') + '\n');
  if (res.ok) {
    try {
      check('no HHC....E/S, HHC....W only allowlisted', badCodes.length === 0, codes);
      check('no console errors / page errors', errors.length === 0, errors);
      if (B === 'chromium') check('no long task over 200 ms after load (Chromium)', lt && lt.supported && res.longtasks.over200AfterLoad.length === 0, res.longtasks);
      else res.checks['no long task over 200 ms after load (Chromium)'] = { pass: null, evidence: `not measurable: ${B} longtask supported=${lt?.supported}` };
      check('no main-thread stall over 200 ms after load (heartbeat, all browsers)', hb && hb.ticks > 100 && res.heartbeat.stallsOver200AfterLoad.length === 0, res.heartbeat);
    } catch (e) { res.ok = false; step('FAILED', { error: String(e) }); }
  }
  res.totalS = Number(el().toFixed(1));
  fs.writeFileSync(path.join(OUT, `e2e-${TAG}.json`), JSON.stringify(res, null, 1));
  console.log(`longtasks: ${JSON.stringify(res.longtasks && { supported: res.longtasks.supported, count: res.longtasks.count, maxMs: res.longtasks.maxMs })} heartbeat: ${JSON.stringify(res.heartbeat && { ticks: res.heartbeat.ticks, maxStallMs: res.heartbeat.maxStallMs, maxStallAfterLoadMs: res.heartbeat.maxStallAfterLoadMs, over50: res.heartbeat.stallsOver50, over200: res.heartbeat.stallsOver200AfterLoad, over200DuringShots: res.heartbeat.stallsOver200DuringShots, noShots: NO_SHOTS })}`);
  console.log(`timing: ${JSON.stringify(res.timing)} memory: ${JSON.stringify(res.memory)} jsHeap: ${JSON.stringify(res.jsHeap)} rss: ${JSON.stringify(rssPeak)}`);
  console.log(`HHC W/E/S: ${JSON.stringify(codes)} errors: ${errors.length} allowed console errors: ${allowedErrors.length}`);
  console.log(res.ok ? 'E2E PASS' : 'E2E FAIL', `${res.totalS} s`, `passwordRetries=${res.passwordRetries ?? '-'}`, errors.length ? `errors: ${errors.join(' | ')}` : '');
  if (traceCdp) {
    try { res.traceSummary = await finishTrace(); } catch (e) { res.traceSummary = { error: String(e) }; }
    fs.writeFileSync(path.join(OUT, `e2e-${TAG}.json`), JSON.stringify(res, null, 1));
    console.log(`trace: ${JSON.stringify(res.traceSummary?.short ?? res.traceSummary)}`.slice(0, 3000));
  }
  clearTimeout(killer);
  await br.close();
  process.exit(res.ok ? 0 : 1);
}

// ------------------------------------------------------------------ --trace
async function finishTrace() {
  const sync = await ev(() => { performance.mark('e2e-trace-sync'); return performance.now(); }).catch(() => null);
  const done = new Promise((ok) => traceCdp.once('Tracing.tracingComplete', ok));
  await traceCdp.send('Tracing.end');
  const { stream } = await done;
  const parts = [];
  for (;;) {
    const r = await traceCdp.send('IO.read', { handle: stream, size: 4 << 20 });
    parts.push(Buffer.from(r.data, r.base64Encoded ? 'base64' : 'utf8'));
    if (r.eof) break;
  }
  await traceCdp.send('IO.close', { handle: stream });
  const gz = Buffer.concat(parts);
  const { analyze } = await import('./trace-stall.mjs');
  const evs = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  const list = Array.isArray(evs) ? evs : evs.traceEvents;
  const out = analyze(list, { syncPageMs: sync, minStall: Number(opt('trace-min-stall', 50)), stalls: res.heartbeat?.stalls ?? [], tasks: res.longtasks?.tasks ?? [] });
  const keep = flag('trace-keep') || (out.windows ?? []).some((w) => w.kind === 'stall' && w.ms > 100);
  if (keep) fs.writeFileSync(TRACE, gz);
  return { ...out, syncPageMs: sync, gzBytes: gz.length, kept: keep ? TRACE : null };
}

