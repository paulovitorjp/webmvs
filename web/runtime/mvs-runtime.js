// SPDX-License-Identifier: Apache-2.0
// mvs-runtime.js -- run the wasm Hercules + MVS/CE in the page.
//
//   import { createRuntime } from './mvs-runtime.js';
//   const rt = createRuntime({ /* options, see DEFAULTS */ });
//   rt.onState((state, info) => ...);    // 'loading' | 'ipl' | 'ready' | 'stopped' | 'error'
//   rt.onLog((line) => ...);             // Hercules log lines (show only with ?debug=1)
//   const con = rt.openTerminal('IBM-3278-2-E@0010');   // master console, BEFORE start()
//   con.onData((bytes) => term.feed(bytes)); con.write(bytes); con.close();
//   await rt.start();                    // resolves when Hercules runs (not when MVS is up)
//   rt.command('devlist');               // hidden Hercules command
//   const tso = rt.openTerminal('IBM-3278-2-E');        // TSO (0400 pool), e.g. at 'ready'
//
// Threads: hercules.js is an Emscripten ES6 module factory (-sPROXY_TO_PTHREAD). C main() runs
// in a worker. Before impl() it fetches the DASD chunks (manifest.json from
// scripts/mk-dasd-chunks.sh) and the boot files in a loader worker (library_webload.js) into
// WasmFS: no DASD byte passes through this (main) thread. This module only calls lock-free C
// exports (hw_term_*, hw_log_read, hw_command, hw_stat, hw_phase, hw_load_*), from a timer.
//
// IPL order (user decision 2026-10-19): the rc file has no IPL. After "HHC02264I ... processing
// ended" the runtime waits until the 0010 console terminal is connected (HHC01018I 0:0010), at
// most consoleWaitMs, then sends "ipl 150". The NIP then uses 0010, and the runtime answers
// IEA101A on 0010 with ENTER (autoNip), like an operator. If 0010 is not connected, NIP uses
// the 3215 at 009 and the HAO rule in the rc answers.
//
// Connection object from openTerminal(ttype): raw TN3270 bytes (the terminal does the telnet
// negotiation and sends ttype in TTYPE IS; '@0010' selects the master console, no suffix = the
// 0400 pool). ttype is also used here to find the console (tap) and the screen size.

import { Screen3270, frameRecord, AID, T, TelnetDecoder } from './tn3270-headless.js';
import { acquireMachineLock, MachineMarker, opfsAvailable, listShadows, readShadow, removeShadows } from './mvs-persist.js';
import { SnapIO, SNAP_DEFAULTS, SNAP_FORMAT, planResume, slotDone, readIntent, writeIntent, sha256Hex, screenRecord, b64, countRecords, schedDecision } from './mvs-snapshot.js';
export { acquireMachineLock, MachineMarker, listShadows, readShadow } from './mvs-persist.js';

// Split a raw telnet stream into segments without changing a byte: {raw} for telnet commands
// outside a record, {raw, data} for a 3270 record (raw = wire bytes incl. IAC EOR, data =
// unescaped record). A partial record is held until its IAC EOR arrives.
class RecordSplitter {
  constructor() { this.st = 0; this.sb = false; this.inRec = false; this.cur = []; this.data = []; }
  feed(bytes) {
    const segs = [];
    const emitCmd = () => { if (!this.inRec && !this.sb) { segs.push({ raw: Uint8Array.from(this.cur) }); this.cur = []; } };
    for (const b of bytes) {
      this.cur.push(b);
      if (this.st === 0) {
        if (b === T.IAC) this.st = 1;
        else if (!this.sb) { this.inRec = true; this.data.push(b); }
      } else if (this.st === 1) {
        this.st = 0;
        if (b === T.IAC) { if (!this.sb) { this.inRec = true; this.data.push(255); } }
        else if (b === T.EOR) {
          segs.push({ raw: Uint8Array.from(this.cur), data: Uint8Array.from(this.data) });
          this.cur = []; this.data = []; this.inRec = false;
        } else if (b >= T.WILL && b <= T.DONT) this.st = 2;
        else if (b === T.SB) this.sb = true;
        else if (b === T.SE) { this.sb = false; emitCmd(); }
        else emitCmd();
      } else { this.st = 0; emitCmd(); }
    }
    return segs;
  }
}

const here = new URL('.', import.meta.url);
const DEFAULTS = {
  herculesUrl: new URL('hercules.js', here).href,       // ES6 factory (make web)
  siteUrl: new URL('../', here).href,                   // base for conf/, boot/, dasd/
  manifest: 'dasd/manifest.json',
  cnf: 'conf/web.cnf',
  rc: 'conf/web-browser.rc',
  shutdownRc: 'conf/web-shutdown.rc',
  files: [                                              // [path in the wasm FS (under /mvs), URL]
    ['conf/web.cnf', 'conf/web.cnf'],
    ['conf/web-browser.rc', 'conf/web-browser.rc'],
    ['conf/web-shutdown.rc', 'conf/web-shutdown.rc'],
    ['herclogo.txt', 'boot/herclogo.txt'],
    ['SCRIPTS/pjes2', 'boot/SCRIPTS/pjes2'],
    ['SCRIPTS/zeod', 'boot/SCRIPTS/zeod'],
    ['SCRIPTS/quiesce', 'boot/SCRIPTS/quiesce'],
    ['SCRIPTS/poweroff', 'boot/SCRIPTS/poweroff'],
  ],
  dirs: ['DASD', 'shadow', 'printers', 'punchcards', 'rdr'],
  empty: ['rdr/rdr00c.txt'],
  // the output devices' dirs (web.cnf: printers/ = JES2 PRINTER1/2 + hardcopy log, punchcards/)
  // are on the bounded outsink backend (src/wasm/outsink.cpp, wasm_main --outsink=): each file keeps only its last
  // ringKiB KiB in the wasm heap. In a WasmFS memory file all output stayed in the fixed heap and doubled its
  // capacity: after about 16 MiB of JES2 print (700 short jobs) Hercules aborted with Aborted(OOM). Nothing in the page reads these files. null = memory files, unbounded.
  outputSink: { dirs: ['printers', 'punchcards'], ringKiB: 64 },
  verify: true,            // sha256 of every chunk (in the loader worker)
  concurrency: 4,          // parallel chunk downloads (manifest format 1, eager load)
  // Base volumes read-only (0444) in the wasm FS, so CCKD opens them RO and writes only to the sf= shadow
  // files. With a writable base CCKD writes into the base file itself, and when
  // a write or its garbage collector extends the file past its loaded size, the WasmFS memory file (a
  // std::vector) doubles its capacity: one 57 MB allocation for the 28.8 MB SYSCPK volume -> Aborted(OOM)
  // about 70 s after the IPL, a dead Hercules thread, and both terminals stuck at X SYSTEM.
  // Lazy volumes (format 2) are read-only anyway. false = writes into the base.
  dasdReadOnly: true,
  // Lazy DASD (manifest format 2, scripts/dasd-chunk.py; src/wasm/lazydasd.cpp + library_lazydasd.js):
  //   concurrency (6 prefetch requests, + extraDemand 2 for demand misses), budgetMiB (in-heap LRU, 24),
  //   cache (Cache Storage 'mvs-dasd-c1'), prefetch ('ready' | 'ikt007i' | 'none'), prefetchWait (false: the
  //   IPL starts while the boot list is still loading). Page mode: URL ?dasd.<key>=<value> overrides.
  lazy: {},
  ipl: '150',              // null: no automatic IPL (call rt.ipl())
  consoleWaitMs: 15000,    // after the rc file: wait this long for the 0010 connection
  autoNip: true,           // answer IEA101A on 0010 with ENTER
  rollMode: 'K S,DEL=R,RNUM=19,RTME=1',   // sent on 0010 at 'ready' (console never stops at IEE159E); null = off
  // at 'ready' set the MVS SRM time-driven interval to srmTune x 1.024 ms (MVS default 1000):
  // without it a TSO user waits up to 1 s per swap-in while a CPU-bound batch job runs (TSO 30-200 x slower, soak
  // finding 3; wasm_main.c srm_tune()). 0 / null = off (page: ?srmtune=0). stats().srmTune = { ms, routines }.
  srmTune: 20,
  pollMs: 8,
  poolSize: 24,            // PTHREAD_POOL_SIZE of the build; stats().poolExhausted if more Workers are made
  extraArgs: [],
  // keep the visitor's machine in this browser. null/false = memory shadows only
  // (memory shadows, every load is a fresh machine). true = PERSIST_DEFAULTS, or an object
  // that overrides some of them. See start() and web/runtime/README.md "Persistence".
  persist: null,
  // keep the RUNNING machine (memory + disks, sr.c checkpoint) in this browser and continue
  // it on the next load without an IPL (needs persist). null/false = off; true = SNAP_DEFAULTS (mvs-snapshot.js); an
  // object overrides some of them. Page mode: on with persistence; ?resume=0 = never resume, ?snap=0 = off,
  // ?snap.<key>=<value> overrides. See web/runtime/README.md "Snapshot".
  snapshot: null,
};
// volumes whose saved shadows are dropped together when the base image of the first one changes (persistSetup)
const COUPLED_VOLUMES = { mvs000: ['spool1'] };
const PERSIST_DEFAULTS = {
  mount: '/opfs',          // WasmFS OPFS backend mount point (wasm_main --opfs=)
  dir: 'shadow',           // OPFS directory of the shadow files: sf=/opfs/shadow/<vol>_*.cckd
  seed: 'dasd/seed/seed.json',   // seed shadows (config-only changes, scripts/mk-seed-shadow.py); null = none
  fsync: true,             // CCKD fsync=1 (fdatasync at every harden; free space reused only after a harden)
  // CCKD write-through (Hyperion patch 0014): a channel program ends only after the tracks it
  // updated are written to the OPFS shadow file, so MVS sees its own writes complete in order and a closed tab is
  // like a power cut between two channel programs. Without it the CCKD cache held updated tracks for up to 10 s:
  // a reload 1-5 s after a TSO SAVE lost the member (60 runs).
  //   'ready' (default): on from TSO ready (IKT007I). During the IPL the cache stays: a tab closed during the IPL
  //            then loses the IPL's writes as a whole, and the next IPL warm-starts JES2 from the old checkpoint
  //            (measured: 40 closes during the IPL, 0 resets). With write-through from the start, 3 of 40 such
  //            closes left a JES2 checkpoint that the next warm start rejected ($HASP095 $Q01 in HASPWARM).
  //   'start': on before the IPL (wasm_main --cckd-wrthru). false: never.
  wrthru: 'ready',
  // CCKD Dasd Hardener interval in s (CCKD dhint=, Hercules default 10) from TSO ready on (null = unchanged). An
  // updated track stays in the CCKD cache until a hardener (or garbage collector) pass flushes it, so with 10 s a
  // reload a few seconds after a TSO SAVE lost the member (measured). 1 = flush + harden every second while
  // there is unsaved data. Set with the hidden command 'cckd dhint=1' at 'ready', NOT in the config: during the IPL
  // MVS writes a lot (JES2 warm start, LOGREC, ...) and the 10 s cache keeps an IPL that is cut off by a closed tab
  // all-or-nothing; with 1 s from the start a kill loop broke TSO logon for good after a close 2.5 s into the IPL
  // flushNow() also works only from 'ready' on. null = never change it. With wrthru the data
  // is written at the end of each channel program anyway; the hardener then only rewrites the CCKD header, L1 table
  // and free space, so the default stays (null).
  dhint: null,
  // devices whose unsaved data does not count for the page's "Saving..." indicator and "Leave page?" prompt
  // (saveState().userDirty), and that keep the cached CCKD writes (no write-through, --cckd-wrthru-skip): 0152 =
  // PAGE00, paging only (page slots are not used again after an IPL; the PLPA on it is written only at a CLPA IPL).
  // Write-through for the paging writes cost about 1 s of IPL time in Chromium. [] = every device counts.
  scratchDevs: ['0152'],
  lock: true,              // Web Lock 'mvs-machine'; a second tab gets state 'locked'
  lockWaitMs: 3000,
  probeMs: 15000,          // wait this long for shadow files that a closing page still holds
  reset: false,            // delete the shadows before the start (also done when the marker asks for it)
  iplTimeoutMs: 180000,    // no IKT007I this long after 'ipl' -> state 'iplfail'
  marker: 'mvs-machine-state',   // localStorage key
};
// conf/web.cnf -> the persistent variant: shadows on OPFS, CCKD fsync=1. Only these edits. (p.dhintCnf: also put
// dhint=<n> in the config, i.e. from the start; tests only, see PERSIST_DEFAULTS.dhint.)
export function persistCnf(text, p) {
  let n = 0;
  let out = text.replace(/\bsf=shadow\//g, () => { n++; return `sf=${p.mount}/${p.dir}/`; });
  const opt = (t, k, v) => t.replace(/^(CCKD\s+)(\S+)/m, (m, a, b) => (new RegExp(`(^|,)${k}=`).test(b)
    ? `${a}${b.replace(new RegExp(`(^|,)${k}=\\d+`), `$1${k}=${v}`)}` : `${a}${b},${k}=${v}`));
  if (p.fsync) out = opt(out, 'fsync', 1);
  if (p.dhintCnf != null) out = opt(out, 'dhint', p.dhintCnf);
  if (!n) throw new Error('persist: no "sf=shadow/" in the config');
  return out;
}

// Count Worker constructions (pthread pool check). emsdk 6.0.13 link.py forces
// PTHREAD_POOL_SIZE_STRICT=0 with PROXY_TO_PTHREAD, so an exhausted pool silently creates a new
// Worker on demand (slow, and a sign that POOL is too small). The build pool is 24 (Makefile POOL).
let workersCreated = 0;
if (typeof Worker === 'function' && !globalThis.__mvsWorkerCount) {
  const RealWorker = Worker;
  // (the snapshot I/O worker of mvs-snapshot.js is not a pthread and is not counted)
  globalThis.Worker = class extends RealWorker { constructor(...a) { super(...a); if (a[1]?.name !== 'mvs-snapshot-io') workersCreated++; } };
  globalThis.__mvsWorkerCount = () => workersCreated;
}

const PH = { INIT: 0, LOADING: 1, STARTING: 2, RUNNING: 3, ENDED: 4, FAILED: 5 };
const ST = { HEAP_USED: 0, HEAP_PEAK: 1, ARENA: 2, SBRK: 3, SBRK_PEAK: 4, SAMPLES: 5, CMDS: 8, MEM: 9, DIRTY: 10, FLUSHES: 11, DIRTYMASK: 12, HARDMASK: 13, SRMTUNE: 14,
  CKDWRITES: 15, INSTCNT: 16, CPUSTATE: 17, USERWRITES: 18, WRITEMASK: 19, DEVWRITES0: 20, CKPT: 40 };   // 40: checkpoint progress (sr.c, patch 0018); 15-19: webrt.h; CPUSTATE bit31 = supported, bit0 started, bit1 wait

// localStorage 'mvs-snap-activity' = { seq (newest committed checkpoint), userAt (first key after it),
// userWrites (disk writes after that key) }: read by the next load for the stale protection (SNAP_DEFAULTS.stale).
const ACTIVITY_KEY = 'mvs-snap-activity';
function readActivity() { try { return JSON.parse(globalThis.localStorage?.getItem(ACTIVITY_KEY) || 'null'); } catch { return null; } }
function writeActivity(v) { try { if (v == null) localStorage.removeItem(ACTIVITY_KEY); else localStorage.setItem(ACTIVITY_KEY, JSON.stringify(v)); } catch { /* blocked */ } }
function devList(M, mask) { const o = []; for (let k = 0; k < 16; k++) if (mask & (1 << k)) o.push((M._hw_cckd_devnum(k) >>> 0).toString(16).toUpperCase().padStart(4, '0')); return o; }
function devFromTtype(ttype) {
  const m = /@([0-9A-F]{3,4})$/i.exec(ttype || '');
  return m ? m[1].toUpperCase().padStart(4, '0') : null;
}
function modelSize(ttype) {
  const m = /3278-(\d)|3279-(\d)/.exec(ttype || '');
  const n = m ? Number(m[1] || m[2]) : 2;
  return { 2: [24, 80], 3: [32, 80], 4: [43, 80], 5: [27, 132] }[n] || [24, 80];
}

export function createRuntime(options = {}) {
  if (typeof options.onProgress === 'function') return createPageRuntime(options);
  return new MvsRuntime(options);
}

// The web/app integration contract (web/app/README.md "Integration contract"):
//   createRuntime({ onProgress, debug }) -> Promise<runtime>, resolved when Hercules runs and
//   openTerminal() works; the page itself starts the IPL (ipl()), answers IEA101A, sets roll
//   mode and shuts down. So the runtime is passive here: no automatic IPL, autoNip or roll mode.
//   onProgress({ phase: 'download' | 'prepare' | 'start', loaded, total, detail }).
async function createPageRuntime({ onProgress, debug, onRuntime, ...rest }) {
  const srm = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('srmtune') : null;   // ?srmtune=0 = off
  const rt = new MvsRuntime({ ipl: null, autoNip: false, rollMode: null, ...(srm != null && /^\d+$/.test(srm) ? { srmTune: Number(srm) } : {}),
    ...rest, snapshot: snapFromUrl(rest.persist, rest.snapshot), lazy: { ...lazyFromUrl(), ...(rest.lazy || {}) } });
  if (typeof onRuntime === 'function') onRuntime(rt);     // the page can offer a reset if the start fails
  rt.onState((s, info) => {
    if (s === 'loading') onProgress(info.loadMs == null
      ? { phase: 'download', loaded: info.loaded, total: info.total, cached: info.cached, lazy: info.lazy,
          detail: info.lazy ? (info.cached && info.cached >= info.loaded && info.loaded > 0 ? 'from cache' : 'boot working set') : undefined }
      : { phase: 'prepare', loaded: info.loaded, total: info.total, cached: info.cached, lazy: info.lazy,
          detail: info.lazy
            ? (info.cachedAll ? 'system loaded from cache'
              : `${(info.loaded / 1048576).toFixed(1)} / ${(info.total / 1048576).toFixed(1)} MB${info.cached ? ' from cache' : ''}, the rest loads during the IPL`)
            : `${info.files} files in ${info.loadMs} ms` });
  });
  rt.onDasd((d) => onProgress({ phase: 'dasd', loaded: d.bootLoaded, total: d.bootTotal, cached: d.cacheBytes, lazy: true,
    done: d.prefetchDone, detail: d.prefetchDone ? (d.netBytes === 0 && d.cacheBytes > 0 ? 'loaded from cache' : 'loaded') : 'boot working set' }));
  // The page subscribes to onLog only after this promise resolves: keep the lines logged before that
  // (webload / lazy DASD notes, the first Hercules messages) and give them to each later subscriber first.
  const early = [];
  const offEarly = rt.onLog((l) => { if (early.length < 5000) early.push(l); });
  await rt.start();
  await rt.running;
  offEarly();
  const onLog = rt.onLog.bind(rt);
  rt.onLog = (cb) => { for (const l of early) try { cb(l); } catch (e) { console.error(e); } return onLog(cb); };
  onProgress({ phase: 'start', detail: 'Hercules is running' });
  return rt;
}

// page mode: snapshots are on with persistence unless ?snap=0; ?resume=0 = do not resume (still save);
// ?snap.<key>=<value> overrides SNAP_DEFAULTS (numbers, 0/1/true/false, strings).
function snapFromUrl(persist, given) {
  if (!persist || given === false) return null;
  const out = typeof given === 'object' && given ? { ...given } : {};
  if (typeof location === 'undefined') return out;
  const q = new URLSearchParams(location.search);
  if (q.get('snap') === '0') return null;
  if (q.get('resume') === '0') out.resume = false;
  for (const [k0, v] of q) {
    if (!k0.startsWith('snap.')) continue;
    const k = k0.slice(5);
    out[k] = /^(true|false)$/i.test(v) ? /^true$/i.test(v) : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return out;
}

// ?dasd.prefetchWait=1&dasd.concurrency=8&dasd.cache=0 ... (numbers, 0/1/true/false, strings)
function lazyFromUrl() {
  const out = {}, bools = new Set(['prefetchWait', 'prefetchAll', 'cache', 'verify', 'cleanup']);
  if (typeof location === 'undefined') return out;
  for (const [k0, v] of new URLSearchParams(location.search)) {
    if (!k0.startsWith('dasd.')) continue;
    const k = k0.slice(5);
    out[k] = bools.has(k) ? /^(1|true|yes)$/i.test(v) : /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return out;
}

// hw_lazy_statd indexes (src/wasm/lazydasd.cpp)
const LZ = ['bootTotal', 'bootLoaded', 'netBytes', 'cacheBytes', 'netReq', 'cacheReq', 'demandWaits', 'waitMs',
  'lruUsed', 'lruPeak', 'evictions', 'gapBytes', 'errors', 'chunksLoaded', 'bootChunks', 'bootChunksLoaded', 'maxWaitMs',
  'reads', 'prefetchDone', 'metaBytes', 'demandNonBoot', 'tracksRead', 'refetch', 'lruBudget', 'prefetchDoneAt', 'firstWaitAt'];

export class MvsRuntime {
  constructor(options) {
    this.o = { ...DEFAULTS, ...options };
    this.M = null;
    this.state = 'new';
    this.info = {};
    this.logCbs = new Set(); this.stateCbs = new Set(); this.injectCbs = new Set(); this.dasdCbs = new Set();
    this.terms = new Set();
    this.lastSeq = -1;
    this.dec = new TextDecoder('utf-8');
    this.logRest = '';
    this.ev = { rcDone: 0, consoleConnected: 0, iplSent: 0, iplLog: 0, ready: 0, ended: 0,
      threads: 0, threadsPeak: 0, errors: [] };
    this.act = { in: 0, out: 0, inRecs: 0 };          // terminal bytes in/out, client records (keys pressed)
    this.connectedDevs = new Set();                   // devices with a client (HHC01018I)
    this.snap = null;
    this.t = { create: 0 };
    this.running = new Promise((res, rej) => { this.runningOk = res; this.runningFail = rej; });
    this.running.catch(() => {});
    globalThis.__mvsRuntime = this;      // test hook (an internal (unpublished) test script: lazyTrace())
  }

  // ---- events ----
  onLog(cb) { this.logCbs.add(cb); return () => this.logCbs.delete(cb); }
  onState(cb) { this.stateCbs.add(cb); return () => this.stateCbs.delete(cb); }
  onInject(cb) { this.injectCbs.add(cb); return () => this.injectCbs.delete(cb); }   // (terminal, bytes) the runtime typed
  // Lazy DASD progress after the load phase (boot working set prefetch, cache): cb(lazyStats())
  onDasd(cb) { this.dasdCbs.add(cb); return () => this.dasdCbs.delete(cb); }
  setState(s, info = {}) {
    const changed = s !== this.state;
    this.state = s; this.info = { ...this.info, ...info };
    if (changed || s === 'loading') for (const cb of this.stateCbs) try { cb(s, this.info); } catch (e) { console.error(e); }
  }
  note(msg) { this.emitLine(`mvs-runtime: ${msg}`); }
  emitLine(line) { for (const cb of this.logCbs) try { cb(line); } catch (e) { console.error(e); } }

  // ---- start ----
  async start() {
    if (this.M || this.starting) return this.starting;
    const o = this.o;
    const abs = (u) => new URL(u, o.siteUrl).href;
    const spec = {
      manifest: o.manifest ? abs(o.manifest) : null, dasdDir: 'DASD',
      files: o.files.map(([path, url]) => ({ path, url: abs(url) })),
      dirs: o.dirs, empty: o.empty, verify: o.verify, concurrency: o.concurrency, lazy: o.lazy,
      dasdReadOnly: !!o.dasdReadOnly,
    };
    if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
      const e = new Error('page is not cross-origin isolated (needs COOP/COEP headers or coi-serviceworker)');
      this.setState('error', { error: e.message }); throw e;
    }
    const pre = [];
    if (o.outputSink?.dirs?.length) pre.push(`--outsink=${o.outputSink.dirs.join(',')}`, `--outsink-ring=${o.outputSink.ringKiB ?? 64}`);
    if (o.persist) await this.persistSetup(spec, pre, abs);
    if (this.snap?.enabled && typeof document !== 'undefined') {     // checkpoint when the visitor leaves
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.snapTick('hidden'); });
      globalThis.addEventListener?.('pagehide', () => { this.snapTick('pagehide'); this.snapUnloadWait(); });
    }
    const args = ['--cwd=/mvs', ...pre, `--webload=${JSON.stringify(spec)}`, '-f', o.cnf, '-r', o.rc, ...o.extraArgs];
    this.t.create = performance.now();
    this.setState('loading', { loaded: 0, total: 0, files: 0 });
    this.starting = (async () => {
      const { default: createHercules } = await import(/* @vite-ignore */ o.herculesUrl);
      this.M = await createHercules({
        arguments: args,
        print: (s) => { this.checkCrash(s); this.emitLine(s); },
        printErr: (s) => { this.checkCrash(s); this.emitLine(s); },
      });
      this.t.module = performance.now();
      this.logBuf = this.M._hw_log_buf(); this.logBufSize = this.M._hw_log_buf_size();
      this.termBuf = this.M._hw_term_buf(); this.termBufSize = this.M._hw_term_buf_size();
      this.cmdBuf = this.M._hw_cmd_buf(); this.cmdBufSize = this.M._hw_cmd_buf_size();
      for (const t of this.terms) this.openConn(t);
      this.timer = setInterval(() => this.tick(), o.pollMs);
    })();
    try { await this.starting; } catch (e) { this.setState('error', { error: String(e) }); throw e; }
  }

  // ---- persistence ----
  // Called by start() before the module loads. Takes the machine lock (a second tab: state
  // 'locked', start() throws an Error with code 'locked'), reads the dirty-start marker, decides
  // on a reset, and changes the start spec: --opfs=<mount>, spec.opfs (reset/probe/seed in the
  // loader worker), and conf/web.cnf with sf= on OPFS and CCKD fsync=1 (inline text).
  async persistSetup(spec, pre, abs) {
    const p = this.p = { ...PERSIST_DEFAULTS, ...(this.o.persist === true ? {} : this.o.persist) };
    const info = this.persist = { enabled: false, why: '', lock: null, dirtyStart: false, reset: false, resetWhy: '',
      opfs: null, seedFiles: [], marker: null, iplFail: null, diskErrors: [] };
    if (!(await opfsAvailable())) {                  // e.g. a private window: memory shadows only
      info.why = 'OPFS not available in this browser context: changes are not saved';
      this.note(`persist: ${info.why}`);
      return;
    }
    if (p.lock) {
      const l = await acquireMachineLock({ waitMs: p.lockWaitMs });
      info.lock = { ok: l.ok, waitedMs: l.waitedMs, api: l.api };
      this.releaseLock = l.release;
      if (!l.ok) {
        const e = new Error('MVS is running in another tab of this browser');
        e.code = 'locked';
        this.setState('locked', { error: e.message });
        throw e;
      }
    }
    this.marker = new MachineMarker(p.marker);
    const m = this.marker.read();
    info.marker = m;
    info.dirtyStart = m.state === 'running';
    info.reset = !!(p.reset || m.resetPending);
    info.resetWhy = p.reset ? 'option' : m.resetPending ? (m.resetWhy || 'requested') : '';
    if (info.reset) info.dirtyStart = false;
    let seed = [];
    const texts = {};                    // the texts behind the snapshot fingerprint
    if (p.seed) {
      try {
        const r = await fetch(abs(p.seed), { credentials: 'same-origin' });
        if (r.ok) {
          texts.seed = await r.text();
          const j = JSON.parse(texts.seed);
          seed = (j.files || []).map((f) => ({ name: f.name, url: new URL(f.file, abs(p.seed)).href, sha256: f.sha256 }));
        } else this.note(`persist: no seed list (${p.seed}: HTTP ${r.status})`);
      } catch (e) { this.note(`persist: seed list: ${e}`); }
    }
    info.seedFiles = seed.map((f) => f.name);
    // A shadow file is only valid on the base image it was written on. Record the base volume
    // sha256s (manifest) and the seed sha256s; if they change (new image, e.g. a rebuilt volume),
    // the shadows of the changed volumes go before the start (the other volumes keep the visitor's
    // data): info.upgrade. If that fails, all shadows go (reset).
    info.base = {};
    try {
      if (this.o.manifest) {
        const r = await fetch(abs(this.o.manifest), { credentials: 'same-origin' });
        if (r.ok) { texts.manifest = await r.text(); for (const v of JSON.parse(texts.manifest).volumes || []) info.base[v.name] = v.sha256 || `size:${v.size}`; }
      }
    } catch (e) { this.note(`persist: manifest for the base check: ${e}`); }
    for (const f of seed) info.base[`seed:${f.name}`] = f.sha256 || '';
    if (!info.reset && m.base && m.state !== 'new') {
      const changed = Object.keys({ ...m.base, ...info.base }).filter((k) => m.base[k] !== info.base[k]);
      if (changed.length) {
        // volume names as in the shadow file names: 'mvsres.3350' -> mvsres, 'seed:mvsres_1.cckd' -> mvsres
        const vols = [...new Set(changed.map((k) => (k.startsWith('seed:') ? k.slice(5).replace(/_\d+\.cckd$/, '') : k.replace(/\.[^.]+$/, ''))))];
        // the JES2 checkpoint (SYS1.HASPCKPT, MVS000) and the spool (SPOOL1) belong together: a new MVS000 also
        // drops the saved spool, else JES2 warm-starts with a checkpoint that does not match the spool
        for (const [v, also] of Object.entries(COUPLED_VOLUMES)) if (vols.includes(v)) for (const x of also) if (!vols.includes(x)) vols.push(x);
        try {
          const removed = await removeShadows(vols, p.dir);
          info.upgrade = { changed, volumes: vols, removed, kept: (await listShadows(p.dir)).map((f) => f.name) };
          this.note(`persist: base image changed (${changed.join(', ')}): removed ${removed.join(', ') || 'no files'}, kept ${info.upgrade.kept.join(', ') || 'no files'}`);
        } catch (e) {
          info.reset = true; info.dirtyStart = false; info.resetWhy = `base image changed: ${changed.join(', ')} (${e})`;
        }
      }
    }
    const cnfUrl = abs(this.o.files.find(([path]) => path === this.o.cnf)?.[1] ?? this.o.cnf);
    const r = await fetch(cnfUrl, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`GET ${cnfUrl}: HTTP ${r.status}`);
    const cnf = persistCnf(await r.text(), p);
    texts.cnf = cnf;
    spec.files = spec.files.map((f) => (f.path === this.o.cnf ? { path: f.path, text: cnf } : f));
    spec.opfs = { dir: p.dir, reset: info.reset, probeMs: p.probeMs, seed };
    if (this.o.snapshot) await this.snapSetup(spec, pre, abs, texts);
    spec.dasdReadOnly = true;            // base volumes 0444: CCKD opens them RO and writes to the OPFS shadows
    pre.push(`--opfs=${p.mount}`);
    // (a resumed machine is past its IPL: write-through from the start, like 'start')
    if (p.wrthru === 'start' || p.wrthru === true || (p.wrthru && this.snap?.plan?.resume)) pre.push('--cckd-wrthru');
    if (p.wrthru && p.scratchDevs?.length) pre.push(`--cckd-wrthru-skip=${p.scratchDevs.join(',')}`);
    info.enabled = true;
    info.wrthru = p.wrthru === true ? 'start' : (p.wrthru || false);
    this.note(`persist: shadows on OPFS ${p.mount}/${p.dir}${p.wrthru ? `, CCKD write-through (${info.wrthru})` : ''}, ${info.reset ? `reset (${info.resetWhy})` : info.dirtyStart ? 'DIRTY start (last session not shut down)' : `start after state '${m.state}'`}`);
  }
  // Hercules is starting: from now on the shadows can change, so the marker says 'running'.
  persistStarted() {
    if (!this.persist?.enabled || this.persist.started) return;
    const i = this.persist;
    i.started = true;
    i.marker = this.marker.write((m) => ({
      state: 'running', lastStart: Date.now(), resetPending: false, resetWhy: '', base: i.base,
      sessions: i.reset ? 1 : m.sessions + 1,
      dirtyStarts: m.dirtyStarts + (i.dirtyStart ? 1 : 0),
      resets: m.resets + (i.reset ? 1 : 0),
      autoResets: m.autoResets + (i.reset && /auto/.test(i.resetWhy) ? 1 : 0),
    }));
  }
  // The page did a clean MVS shutdown (IEE334I + QUIESCE) and Hercules has ended.
  markClean() {
    if (!this.persist?.enabled) return null;
    this.persist.marker = this.marker.write((m) => ({ state: 'clean', lastClean: Date.now(), cleanShutdowns: m.cleanShutdowns + 1 }));
    if (this.snap?.enabled) void this.snapshotDiscard('clean shutdown');   // after Shut down the next load IPLs
    return this.persist.marker;
  }
  // 'Reset machine': the NEXT load deletes the shadows before Hercules starts (the page reloads
  // after this). why: free text; 'auto...' counts as an automatic reset (offer after a failed IPL).
  requestReset(why = 'user') {
    if (!this.marker) this.marker = new MachineMarker((this.p || PERSIST_DEFAULTS).marker);
    const m = this.marker.write({ resetPending: true, resetWhy: why });
    if (this.persist) this.persist.marker = m;
    writeIntent(null); writeActivity(null);                // the reset load removes the slots (snapReset)
    if (this.snap) this.snap.disabled = `reset requested (${why})`;
    return m;
  }
  persistFail(reason) {
    const i = this.persist;
    if (!i?.enabled || i.iplFail || this.ev.ready) return;
    i.iplFail = { reason, dirtyStart: i.dirtyStart, at: performance.now() };
    this.note(`persist: IPL failed: ${reason}${i.dirtyStart ? ' (dirty start)' : ''}`);
    this.setState('iplfail', { reason, dirtyStart: i.dirtyStart });
  }
  // ---- save state ----
  // { dirty: updated CCKD track images not yet written to the shadow files (0 = all written), devs: their device
  //   numbers (['0153', ...]), userDirty: how many of them are not persist.scratchDevs (PAGE00), unhardened: devices written since their last harden (header/free space; the data is
  //   in the file, CCKD's check at the next open repairs the rest), since:
  //   performance.now() when it became dirty (0 = clean), flushes: hw_cckd_flush() requests served,
  //   supported: false on an older build (no hw_cckd_flush export) }. Lock-free reads.
  saveState() {
    const M = this.M;
    if (!M || !M._hw_cckd_flush) return { dirty: 0, since: 0, flushes: 0, supported: false };
    if (M._hw_phase() >= PH.ENDED) return { dirty: 0, userDirty: 0, since: 0, flushes: M._hw_stat(ST.FLUSHES) >>> 0, supported: true };
    const d = M._hw_stat(ST.DIRTY) >>> 0, mask = M._hw_stat(ST.DIRTYMASK) >>> 0, hmask = M._hw_stat(ST.HARDMASK) >>> 0;
    if (d && !this.dirtySince) this.dirtySince = performance.now();
    if (!d) this.dirtySince = 0;
    const devs = (m) => { const o = []; for (let k = 0; k < 16; k++) if (m & (1 << k)) o.push((M._hw_cckd_devnum(k) >>> 0).toString(16).toUpperCase().padStart(4, '0')); return o; };
    const dv = devs(mask), scratch = this.p?.scratchDevs || [];
    const userDirty = dv.filter((x) => !scratch.includes(x)).length;
    return { dirty: d, userDirty, since: this.dirtySince || 0, flushes: M._hw_stat(ST.FLUSHES) >>> 0, devs: dv, unhardened: devs(hmask), supported: true };
  }
  // Ask CCKD for an immediate hardener pass (flush the cache, wait for the writes, harden + fdatasync).
  flushNow(why = '') {
    const M = this.M;
    if (!M || !M._hw_cckd_flush || M._hw_phase() !== PH.RUNNING || !this.fastSave) return false;   // only after 'ready'
    M._hw_cckd_flush();
    this.lastFlush = { at: performance.now(), why };
    return true;
  }
  async shadows() { return listShadows(this.p?.dir || 'shadow'); }
  async shadowBytes(name) { return readShadow(name, this.p?.dir || 'shadow'); }

  // ---- snapshot: checkpoint the running machine, resume it on the next load ----
  // See mvs-snapshot.js (layout, C contract) and web/runtime/README.md "Snapshot".
  // Called by persistSetup() before the module loads: fingerprint of this build/image/config, choice of the slot,
  // and the loader spec (restore the slot's shadows into shadow/, or remove every slot when this load IPLs).
  async snapSetup(spec, pre, abs, texts) {
    const so = { ...SNAP_DEFAULTS, mount: this.p.mount, ...(this.o.snapshot === true ? {} : this.o.snapshot) };
    so.quietDevs = [].concat(so.quietDevs ?? []).flatMap((x) => String(x).split(',')).filter(Boolean).map((x) => x.toUpperCase().padStart(4, '0'));
    const sn = this.snap = { o: so, io: null, enabled: false, plan: null, fp: null, fields: null, seq: 1, busy: '', paused: '',
      disabled: '', last: null, results: [], ckpts: 0, fails: 0, idleRing: [], quietSince: 0, prevSig: null, userAt: 0,
      userCkw: 0, userWrites: false, pageFn: null, resume: null, error: '' };
    const t0 = performance.now();
    try {
      sn.io = new SnapIO();
      const rcUrl = abs(this.o.files.find(([path]) => path === this.o.rc)?.[1] ?? this.o.rc);
      const [glue, rc] = await Promise.all([sn.io.call('fetchHash', this.o.herculesUrl, true),
        fetch(rcUrl, { credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : ''))]);
      sn.fields = { format: SNAP_FORMAT, wasm: '', glue: glue.sha256, image: await sha256Hex(texts.manifest || ''),
        seed: texts.seed ? await sha256Hex(texts.seed) : '', cnf: await sha256Hex(texts.cnf || ''), rc: await sha256Hex(rc) };
      // build id = the wasm: a bundle names it hercules.<first 12 hex of its sha256>.wasm (scripts/bundle-hash.py);
      // otherwise hash the bytes (one more fetch, from the HTTP cache on a revisit)
      const wm = /["']([^"'/]*\.wasm)["']/.exec(glue.text || '');
      sn.wasmUrl = wm ? new URL(wm[1], this.o.herculesUrl).href : null;
      const hm = wm && /\.([0-9a-f]{12})\.wasm$/.exec(wm[1]);
      if (hm) sn.fields.wasm = `name:${hm[1]}`;
      const top = await sn.io.call('list', so.dir);
      const anyGen = (top || []).some((e) => e.kind === 'directory' && /^s\d+$/.test(e.name));
      if (!sn.fields.wasm && anyGen && sn.wasmUrl) sn.fields.wasm = (await sn.io.call('fetchHash', sn.wasmUrl)).sha256;
      if (sn.fields.wasm) sn.fp = { fields: sn.fields, id: await sha256Hex(JSON.stringify(sn.fields)) };
      if (this.persist.reset) sn.plan = { resume: false, why: `machine reset (${this.persist.resetWhy})`, nextSeq: 1 };
      else if (!anyGen) sn.plan = { resume: false, why: 'no saved machine', nextSeq: 1 };
      else {
        sn.plan = await planResume(sn.io, so, sn.fp, { intent: readIntent(), activity: readActivity() });
        if (sn.plan.resume && !so.resume) { sn.plan.resume = false; sn.plan.why = 'resume turned off (?resume=0)'; }
      }
      sn.seq = sn.plan.nextSeq || 1;
      if (sn.plan.resume) {
        const m = sn.plan.manifest;
        spec.opfs.restore = { from: `${so.dir}/${sn.plan.gen}`, shadowDir: m.shadowDir ?? 'shadow', files: m.files, srf: m.srf };
        // a delta slot = the base slot's shadow copies + shadows.dlt (the loader applies it)
        if (m.kind === 'delta') Object.assign(spec.opfs.restore, { files: [], delta: m.delta, base: { from: `${so.dir}/${m.base.gen}`, files: m.base.files, srf: m.base.srf } });
      } else {
        spec.opfs.snapReset = true;     // this load IPLs: from now on every old checkpoint is older than the disks
        writeIntent(null); writeActivity(null);
      }
      spec.opfs.snapDir = so.dir;
      sn.enabled = true;
      sn.planMs = Math.round(performance.now() - t0);
      this.note(`snapshot: ${sn.plan.resume ? `resume ${sn.plan.gen} (saved ${new Date(sn.plan.manifest.savedAt).toISOString()}${sn.plan.commit ? ', committed now' : ''})`
        : `IPL: ${sn.plan.why}`} [${sn.planMs} ms]`);
    } catch (e) {
      sn.error = String(e && e.message || e); sn.plan = { resume: false, why: `snapshot error: ${sn.error}` };
      this.note(`snapshot: off: ${sn.error}`);
    }
  }
  // The fingerprint without an early wasm hash (first visit): computed in the background after 'ready'.
  async snapFingerprint() {
    const sn = this.snap;
    if (sn.fp || sn.fpPending) return sn.fpPending;
    sn.fpPending = (async () => {
      if (!sn.fields.wasm) sn.fields.wasm = sn.wasmUrl ? (await sn.io.call('fetchHash', sn.wasmUrl)).sha256 : 'unknown';
      sn.fp = { fields: sn.fields, id: await sha256Hex(JSON.stringify(sn.fields)) };
    })().catch((e) => { sn.error = `fingerprint: ${e}`; }).finally(() => { sn.fpPending = null; });
    return sn.fpPending;
  }
  // For the page (after createRuntime resolves): what this load does. resume: true -> open the listed terminals
  // (ttype '<type>@<devnum>'), then call resumeMachine() instead of ipl().
  snapshotPlan() {
    const sn = this.snap;
    if (!sn) return null;
    this.snapCheckRestore();
    const p = sn.plan || { resume: false, why: 'snapshot off' };
    return { enabled: sn.enabled, resume: !!p.resume, why: p.why || '', gen: p.gen || null, seq: p.seq || null,
      savedAt: p.manifest?.savedAt || null, terminals: p.manifest?.terminals || [], page: p.page?.extra || null, tried: p.tried || [],
      commit: !!p.commit, stale: p.stale || null, saveWhy: p.manifest?.why || null };
  }
  // The loader reports the restore in 'webload-opfs: {...}' (rt.persist.opfs.restore). A failed verify/copy: IPL.
  snapCheckRestore() {
    const sn = this.snap, p = sn?.plan;
    if (!p?.resume || p.restoreChecked || !this.persist?.opfs) return;
    p.restoreChecked = true;
    const r = this.persist.opfs.restore;
    if (r?.ok) return;
    p.resume = false;
    p.why = `restore of ${p.gen} failed: ${r ? `${r.stage}: ${r.error}${r.wiped ? ' (disks reset to the original)' : ''}` : 'no restore report'}`;
    this.note(`snapshot: ${p.why}`);
    void this.snapshotDiscard(p.why, { keepEnabled: true });
  }
  // The page's part of a checkpoint: fn() -> JSON-able object (console history, tabs), stored in page.json.
  setSnapshotPage(fn) { if (this.snap) this.snap.pageFn = typeof fn === 'function' ? fn : null; }
  // No automatic checkpoints while paused (the page's Shut down). '' = go on.
  snapshotPause(why = 'paused') { if (this.snap) this.snap.paused = why || ''; }

  snapSig() {
    const M = this.M;
    return { io: this.act.in + this.act.out, out: M._hw_outsink_statd ? M._hw_outsink_statd(0) : 0, ckw: this.snapWrites() };
  }
  // Track writes of the devices that can hold the visitor's data: not snapshot.quietDevs (default PAGE00 = paging,
  // MVS000 = the JES2 checkpoint that MVS writes about every 10 s also when nothing happens; measured).
  snapWrites() {
    const M = this.M, q = this.snap?.o?.quietDevs || [];
    if (!this.devIdx) {
      const idx = []; for (let k = 0; k < 16; k++) { const d = (M._hw_cckd_devnum(k) >>> 0); if (d) idx.push([k, d.toString(16).toUpperCase().padStart(4, '0')]); }
      if (!idx.length) return M._hw_stat(ST.USERWRITES) >>> 0;     // devices not known yet (first webdirty pass)
      this.devIdx = idx;
    }
    let w = 0;
    for (const [k, d] of this.devIdx) if (!q.includes(d)) w = (w + (M._hw_stat(ST.DEVWRITES0 + k) >>> 0)) >>> 0;
    return w;
  }
  snapPageData() {
    const screens = {};
    for (const t of this.terms) {
      if (!t.id || t.closed || !t.devnum) continue;
      let rb = null;
      try { rb = t.screenSource ? t.screenSource() : (t.tap ? t.tap.screen.readBuffer(0x60) : t.scr?.readBuffer(0x60)); } catch { rb = null; }
      if (rb && rb.length > 3) screens[t.devnum] = b64.enc(Uint8Array.from(rb));
    }
    let extra = null;
    try { extra = this.snap.pageFn ? this.snap.pageFn() : null; } catch (e) { extra = { error: String(e) }; }
    return { at: Date.now(), screens, extra };
  }

  // Start a checkpoint now. Everything up to the hidden command is synchronous (it also works in a pagehide handler);
  // the returned promise resolves when the slot is committed (snap/current) or the checkpoint failed.
  checkpoint(why = 'manual') {
    const sn = this.snap, so = sn?.o;
    const no = (reason) => Promise.resolve({ ok: false, skipped: true, why, reason });
    if (!sn?.enabled || sn.disabled) return no(sn?.disabled || 'snapshot off');
    if (sn.busy) return no(`busy: ${sn.busy}`);
    if (!this.M || this.M._hw_phase() !== PH.RUNNING || this.ev.crashed || !this.ev.ready) return no('MVS not ready');
    if (!sn.fp) { void this.snapFingerprint(); return no('fingerprint not ready'); }
    const seq = sn.seq++, gen = `s${seq}`, dir = `${so.dir}/${gen}`, path = `${so.mount}/${dir}`;
    // ask for a delta (patch 0018) against the tracked base (sn.base = { gen, files, srf } of a full slot)
    const base = so.incr && sn.base && (sn.nDelta || 0) < so.fullEvery ? sn.base : null;
    const incrArgs = so.incr ? ` incr=1 maxdelta=${so.maxDelta} maxshadow=${so.maxShadow}${base ? ` base=${so.mount}/${so.dir}/${base.gen}` : ''}` : '';
    const at = Date.now(), t0 = performance.now();
    const page = this.snapPageData();
    const terminals = [...this.terms].filter((t) => t.id > 0 && !t.closed && t.devnum).map((t) => ({ devnum: t.devnum, ttype: t.ttype }));
    const sig0 = this.snapSig(), inRecs0 = this.act.inRecs;
    writeIntent({ gen, seq, fp: sn.fp.id, fpFields: sn.fp.fields, at, terminals, page, why, base });
    const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const done = new RegExp(so.doneRe.replace('(\\S+)', `(${esc})`)), failed = new RegExp(so.failRe.replace('(\\S+)', `(${esc})`));
    const res = { ok: false, gen, why, at, seq };
    sn.busy = `checkpoint ${gen} (${why})`;
    // (HHC02032E: usage error of 0015; HHC01600E: a build without the command)
    const wait = this.waitLog(new RegExp(`${done.source}|${failed.source}|^HHC02032E |^HHC01600E .*checkpoint`), so.ckptTimeoutMs);
    if (so.buildCmd && !sn.buildSent) { this.command(`${so.buildCmd} ${sn.fp.fields.wasm}`); sn.buildSent = true; }
    if (!this.command(`checkpoint ${path}${so.ckptArgs ? ` ${so.ckptArgs}` : ''}${incrArgs}`)) { wait.catch(() => {}); sn.busy = ''; writeIntent(null); return no('command queue full'); }
    sn.lastStart = { gen, why, at };
    sn.ckProg0 = this.M._hw_stat(ST.CKPT) >>> 0;
    return (async () => {
      try {
        const line = await wait;
        res.cMs = Math.round(performance.now() - t0);
        res.line = line.slice(0, 300);
        if (!done.test(line)) throw new Error(line.trim());
        const pm = /pause (\d+) ms/.exec(line); if (pm) res.pauseMs = Number(pm[1]);
        const t1 = performance.now();
        const dn = await slotDone(sn.io, dir);
        if (!dn) throw new Error(`no checkpoint.json / checkpoint.done in ${dir}`);
        const isDelta = dn.kind === 'delta';
        if (isDelta && (!base || dn.basePath !== `${so.mount}/${so.dir}/${base.gen}`)) throw new Error(`delta against ${dn.basePath}, expected ${base ? base.gen : 'no base'}`);
        const files = isDelta ? [] : await sn.io.call('hashFiles', dn.shadowDir ? `${dir}/${dn.shadowDir}` : dir, dn.names);
        const [srf, delta] = await sn.io.call('hashFiles', dir, isDelta ? ['machine.srf', 'shadows.dlt'] : ['machine.srf']);
        res.hashMs = Math.round(performance.now() - t1);
        const pageJson = JSON.stringify(page);
        const man = { format: SNAP_FORMAT, gen, seq, savedAt: at, why, fp: sn.fp.fields, fpId: sn.fp.id, shadowDir: dn.shadowDir, files, srf, terminals,
          kind: dn.kind || 'full', ...(isDelta ? { delta, base } : {}),
          page: { size: pageJson.length, sha256: await sha256Hex(pageJson) }, c: { line: res.line, ...dn.c, shadows: undefined } };
        res.kind = man.kind; res.msPages = dn.c.msPages; res.kindWhy = dn.c.kindWhy;
        const t2 = performance.now();
        await sn.io.call('writeText', `${dir}/page.json`, pageJson);
        await sn.io.writeJson(`${dir}/manifest.json`, man);
        await sn.io.writeJson(`${so.dir}/current`, { gen, seq, at });            // the commit point
        res.commitMs = Math.round(performance.now() - t2);
        const prev = sn.currentGen, prevBase = sn.currentBase; sn.currentGen = gen;
        // a full slot is the new base; a delta keeps its base (both kept from pruning while in use)
        if (isDelta) { sn.nDelta = (sn.nDelta || 0) + 1; sn.currentBase = base.gen; }
        else { sn.base = so.incr ? { gen, files, srf } : null; sn.nDelta = 0; sn.currentBase = null; }
        writeIntent(null);
        res.srfBytes = srf.size; res.shadowBytes = isDelta ? delta.size : files.reduce((a, f) => a + f.size, 0); res.files = isDelta ? 1 : files.length;
        res.totalMs = Math.round(performance.now() - t0);
        res.ok = true;
        // baseline for "changed since the last checkpoint": the state at the checkpoint (its own cache flush included)
        const sig = this.snapSig();
        sn.last = { seq, gen, at, pnow: t0, sig: { io: sig0.io, out: sig0.out, ckw: sig.ckw }, inRecs: inRecs0 };
        if (this.act.inRecs === inRecs0) { sn.userAt = 0; sn.userWrites = false; }
        else { sn.userAt = Date.now(); sn.userCkw = sig.ckw; sn.userWrites = false; }   // keys after the checkpoint point
        writeActivity({ seq, userAt: sn.userAt, userWrites: sn.userWrites });
        sn.ckpts++;
        // prune: keep this slot and the previous current one
        const keep = new Set([gen, prev, sn.currentBase, prevBase, sn.base?.gen].filter(Boolean));
        const top = (await sn.io.call('list', so.dir)) || [];
        const olds = top.filter((e) => e.kind === 'directory' && /^s\d+$/.test(e.name) && !keep.has(e.name) && Number(e.name.slice(1)) < seq)
          .sort((a, b) => Number(b.name.slice(1)) - Number(a.name.slice(1)));
        for (const e of olds.slice(Math.max(0, so.keep - keep.size))) await this.snapPrune(e.name);
        this.note(`snapshot: ${gen} saved (${why}, ${man.kind}${isDelta ? ` of ${base.gen}: ${res.msPages} pages` : res.kindWhy ? `: ${res.kindWhy}` : ''}): C ${res.cMs} ms (pause ${res.pauseMs ?? '?'} ms), hash ${res.hashMs} ms, commit ${res.commitMs} ms, srf ${res.srfBytes} B, ${res.files} shadows ${res.shadowBytes} B`);
      } catch (e) {
        res.error = String(e && e.message || e);
        sn.fails++;
        this.note(`snapshot: checkpoint ${gen} (${why}) failed: ${res.error}`);
        writeIntent(null);
        sn.lastFailAt = performance.now();               // the scheduler waits 30 s before the next try
      } finally {
        sn.busy = '';
        sn.results.push(res); if (sn.results.length > 50) sn.results.shift();
      }
      return res;
    })();
  }

  // in pagehide, keep the page alive until the C side has ended the running checkpoint (its
  // checkpoint.json is written; the next load commits it through the intent), at most snapshot.unloadWaitMs. The
  // page's own thread only reads an atomic counter (hw_stat CKPT, lock-free); the checkpoint runs in Hercules'
  // threads and the WasmFS OPFS worker. Result in localStorage 'mvs-snap-unload' (tests).
  snapUnloadWait() {
    const sn = this.snap, M = this.M, w = sn?.o?.unloadWaitMs;
    const ms = w === 'auto' ? (/Firefox\//.test(globalThis.navigator?.userAgent || '') ? 0 : 2000) : Number(w) || 0;
    if (!ms || !M || !/^checkpoint/.test(sn.busy || '') || sn.ckProg0 == null) return;
    const t0 = performance.now(), end0 = sn.ckProg0 >>> 2;
    let p = M._hw_stat(ST.CKPT) >>> 0, n = 0;
    while ((p >>> 2) === end0 && performance.now() - t0 < ms) { p = M._hw_stat(ST.CKPT) >>> 0; n++; }
    const r = { gen: sn.lastStart?.gen, why: sn.lastStart?.why, done: (p >>> 2) !== end0, phase: p & 3, ms: Math.round(performance.now() - t0), polls: n, at: Date.now() };
    try { localStorage.setItem('mvs-snap-unload', JSON.stringify(r)); } catch { /* full or blocked */ }
  }

  // Remove an old slot directory. Through Hercules' WasmFS (hidden command 'snaprm', wasm_main.c)
  // when the build has it: WasmFS caches every entry it has seen with an OPFS handle, and a slot removed behind its back
  // (the OPFS worker) stayed cached with about 12 handles for the life of the page. The first use waits for the reply
  // (at most pruneWaitMs); a build without the command (HHC01600E) or no reply -> the worker removes it, as before.
  async snapPrune(name) {
    const sn = this.snap, so = sn.o, path = `${so.mount}/${so.dir}/${name}`;
    if (so.pruneCmd && sn.pruneC !== false) {
      const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const w = this.waitLog(new RegExp(`^wasm_main: ${so.pruneCmd} ${esc} rc=(-?\\d+)|^HHC01600E .*${so.pruneCmd}`), so.pruneWaitMs);
      if (this.command(`${so.pruneCmd} ${path}`)) {
        if (sn.pruneC === true) { w.then((l) => { if (!/ rc=0 /.test(l)) this.note(`snapshot: prune ${name}: ${l.trim()}`); }, () => {}); sn.pruned = (sn.pruned || 0) + 1; return; }
        const line = await w.catch(() => '');
        if (/ rc=0 /.test(line)) { sn.pruneC = true; sn.pruned = (sn.pruned || 0) + 1; return; }
        if (/HHC01600E/.test(line)) sn.pruneC = false;
        this.note(`snapshot: prune ${name} through WasmFS: ${line.trim() || 'no reply'}; removed by the OPFS worker`);
      } else w.catch(() => {});
    }
    await sn.io.call('remove', `${so.dir}/${name}`, true).catch(() => {});
  }

  // Resume the slot of snapshotPlan() (the page has opened the plan's terminals). Resolves { ok, ms, ... }; on a
  // failure the slots are discarded (the next load IPLs) and the state is 'resumefail' { reason }.
  async resumeMachine() {
    const sn = this.snap, so = sn?.o;
    this.snapCheckRestore();
    const plan = sn?.plan;
    if (!plan?.resume) return { ok: false, reason: plan?.why || 'no snapshot' };
    const t0 = performance.now(), r = sn.resume = { gen: plan.gen, steps: {} };
    const step = (k) => { r.steps[k] = Math.round(performance.now() - t0); };
    const until = async (f, ms, what) => { const end = performance.now() + ms; while (!f()) { if (performance.now() > end) throw new Error(`timeout: ${what}`); await new Promise((z) => setTimeout(z, 50)); } };
    const fail = async (reason) => {
      r.ok = false; r.reason = reason; r.ms = Math.round(performance.now() - t0);
      plan.resume = false; plan.why = `resume failed: ${reason}`;
      this.note(`snapshot: resume of ${plan.gen} failed: ${reason}`);
      sn.busy = '';
      await this.snapshotDiscard(`resume failed: ${reason}`).catch(() => {});
      this.setState('resumefail', { reason });
      return r;
    };
    sn.busy = 'resume';
    try {
      await until(() => this.ev.rcDone, 60000, 'rc file');
      const want = (plan.manifest.terminals || []).map((t) => t.devnum);
      await until(() => want.every((d) => this.connectedDevs.has(d)), 30000, `terminals ${want.join(' ')} connected`);
      for (const t of this.terms) if (want.includes(t.devnum)) await until(() => t.recs.n >= 1, 10000, `first screen on ${t.devnum}`).catch(() => {});
      step('terminals');
      // the screens of the checkpoint (the C checkpoint does not ask the terminals for them)
      for (const t of this.terms) {
        const rb = plan.page?.screens?.[t.devnum];
        const rec = rb && screenRecord(b64.dec(rb));
        if (rec) this.deliver(t, rec);
      }
      step('screens');
      const wait = this.waitLog(new RegExp(`${so.resumeOkRe}|${so.resumeErrRe}`), so.resumeTimeoutMs);
      if (so.buildCmd) { this.command(`${so.buildCmd} ${sn.fp.fields.wasm}`); sn.buildSent = true; }
      this.command(`resume ${so.mount}/${so.dir}/${plan.gen}/machine.srf${so.incr && so.track ? ' track=1' : ''}`);
      let line;
      try { line = await wait; } catch { return await fail(`no end of 'resume' within ${so.resumeTimeoutMs / 1000} s`); }
      if (new RegExp(so.resumeErrRe).test(line)) return await fail(line.trim());
      step('resume');
      const M = this.M;
      if ((M._hw_stat(ST.CPUSTATE) >>> 0) & 0x80000000) {
        const i0 = M._hw_stat(ST.INSTCNT) >>> 0;
        try { await until(() => ((M._hw_stat(ST.CPUSTATE) >>> 0) & 1) && (M._hw_stat(ST.INSTCNT) >>> 0) !== i0, so.cpuMs, 'CP00 running'); }
        catch { return await fail(`CP00 not running ${so.cpuMs / 1000} s after resume (state ${(M._hw_stat(ST.CPUSTATE) >>> 0).toString(16)})`); }
      }
      step('cpu');
      if (this.ev.crashed) return await fail(`Hercules crashed: ${this.ev.crashed.line}`);
      if (so.probe) {
        const w = this.waitLog(new RegExp(so.probeRe), so.probeMs);
        this.command(so.probe);
        try { r.probe = (await w).trim().slice(0, 120); } catch { return await fail(`MVS did not answer '${so.probe}' within ${so.probeMs / 1000} s`); }
      }
      step('probe');
      r.ok = true; r.ms = Math.round(performance.now() - t0);
      sn.busy = '';
      sn.currentGen = plan.gen;
      // with track=1 the C side's base is the resumed slot's base (itself if full)
      const pm = plan.manifest;
      if (so.incr && so.track) {
        sn.base = pm.kind === 'delta' ? pm.base : { gen: plan.gen, files: pm.files, srf: pm.srf };
        sn.currentBase = pm.kind === 'delta' ? pm.base.gen : null; sn.nDelta = 0;
      }
      if (plan.commit) {                               // a checkpoint of the last page that it did not commit itself
        const man = { ...plan.manifest }; delete man.pending;
        const pageJson = JSON.stringify(plan.page || {});
        man.page = { size: pageJson.length, sha256: await sha256Hex(pageJson) }; man.committedAtLoad = Date.now();
        await sn.io.call('writeText', `${so.dir}/${plan.gen}/page.json`, pageJson).catch(() => {});
        await sn.io.writeJson(`${so.dir}/${plan.gen}/manifest.json`, man).catch(() => {});
        await sn.io.writeJson(`${so.dir}/current`, { gen: plan.gen, seq: plan.seq, at: plan.manifest.savedAt }).catch(() => {});
        writeIntent(null);
      }
      this.markReady('resume');
      const sig = this.snapSig();
      sn.last = { seq: plan.seq, gen: plan.gen, at: plan.manifest.savedAt, pnow: performance.now(), sig, inRecs: this.act.inRecs };
      sn.userAt = 0; sn.userWrites = false; writeActivity({ seq: plan.seq, userAt: 0, userWrites: false });
      this.note(`snapshot: resumed ${plan.gen} in ${r.ms} ms ${JSON.stringify(r.steps)}${r.probe ? `, MVS: ${r.probe}` : ''}`);
      return r;
    } catch (e) {
      return await fail(String(e && e.message || e));
    }
  }

  // Delete the saved machine: the next load IPLs. Waits for a running checkpoint first.
  async snapshotDiscard(why = 'user', { keepEnabled = false } = {}) {
    const sn = this.snap;
    if (!sn?.io) return false;
    if (!keepEnabled) sn.disabled = `discarded: ${why}`;
    writeIntent(null); writeActivity(null);
    for (let i = 0; sn.busy && sn.busy !== 'resume' && i < 600; i++) await new Promise((z) => setTimeout(z, 100));
    await sn.io.writeJson(`${sn.o.dir}/current`, { gen: null, discarded: true, why, at: Date.now() });
    sn.currentGen = null; sn.last = null;
    this.note(`snapshot: discarded (${why})`);
    return true;
  }

  // Scheduler (from tick(), every 250 ms): idle sampling, activity, stale tracking, automatic checkpoints.
  snapTick(event = null) {
    const sn = this.snap, M = this.M;
    if (!sn?.enabled || !M) return;
    const now = performance.now();
    if (event === 'hidden' && !sn.o.onHidden) return null;
    if (event === 'pagehide' && !sn.o.onPagehide) return null;
    if (!event) {
      if (now - (sn.tickAt || 0) < 250) return;
      sn.tickAt = now;
      const cs = M._hw_stat(ST.CPUSTATE) >>> 0;
      sn.idleRing.push((cs & 0x80000000) ? ((cs & 2) ? 1 : 0) : 1);
      if (sn.idleRing.length > 8) sn.idleRing.shift();
    }
    const cur = this.snapSig();
    if (!sn.prevSig || cur.io !== sn.prevSig.io || cur.ckw !== sn.prevSig.ckw || cur.out !== sn.prevSig.out) sn.quietSince = now;
    sn.prevSig = cur;
    if (sn.last && !sn.busy) {                             // keys pressed + disk writes after the last checkpoint?
      if (!sn.userAt && this.act.inRecs !== sn.last.inRecs) { sn.userAt = Date.now(); sn.userCkw = cur.ckw; writeActivity({ seq: sn.last.seq, userAt: sn.userAt, userWrites: false }); }
      if (sn.userAt && !sn.userWrites && cur.ckw !== sn.userCkw) { sn.userWrites = true; writeActivity({ seq: sn.last.seq, userAt: sn.userAt, userWrites: true }); }
    }
    if (sn.disabled || !sn.o.auto) return;
    if (!sn.fp && this.ev.ready && !sn.fpPending) void this.snapFingerprint();
    const ready = this.state === 'ready' && !!this.ev.ready && !this.ev.crashed && M._hw_phase() === PH.RUNNING && !sn.paused;
    const idle = sn.idleRing.length ? sn.idleRing.reduce((a, b) => a + b, 0) / sn.idleRing.length : 0;
    const why = schedDecision({ now, ready, busy: !!sn.busy || (!!sn.lastFailAt && now - sn.lastFailAt < 30000), readyAt: this.ev.ready, lastAt: sn.last?.pnow || 0,
      last: sn.last?.sig || { io: -1, out: -1, ckw: -1 }, cur, quietSince: sn.quietSince, idle, userSince: !!sn.userAt, event }, sn.o);
    if (why) void this.checkpoint(why);
    return why;
  }
  snapStats() {
    const sn = this.snap;
    if (!sn) return null;
    const M = this.M, cs = M ? M._hw_stat(ST.CPUSTATE) >>> 0 : 0;
    return { enabled: sn.enabled, disabled: sn.disabled, error: sn.error, busy: sn.busy, paused: sn.paused, plan: this.snapshotPlan(),
      planMs: sn.planMs, fp: sn.fp?.fields || null, currentGen: sn.currentGen || null, nextSeq: sn.seq, ckpts: sn.ckpts, fails: sn.fails, pruned: sn.pruned || 0, pruneC: sn.pruneC ?? null,
      last: sn.last ? { gen: sn.last.gen, at: sn.last.at } : null, results: sn.results.slice(-20), resume: sn.resume,
      userAt: sn.userAt, userWrites: sn.userWrites, act: { ...this.act },
      cpu: (cs & 0x80000000) ? { started: !!(cs & 1), wait: !!(cs & 2), inst: M._hw_stat(ST.INSTCNT) >>> 0, ckdWrites: M._hw_stat(ST.CKDWRITES) >>> 0,
        userWrites: M._hw_stat(ST.USERWRITES) >>> 0, snapWrites: this.snapWrites(), written10s: devList(M, M._hw_stat(ST.WRITEMASK) >>> 0) } : null };
  }
  devConnected(dev) {
    this.connectedDevs.add(dev);
    if ([...this.terms].some((t) => t.devnum === dev)) return;
    const t = [...this.terms].filter((x) => x.id > 0 && !x.closed && !x.devnum && !/@/.test(x.ttype || '')).sort((a, b) => a.id - b.id)[0];
    if (t) t.devnum = dev;
  }

  // ---- terminals ----
  openTerminal(ttype = '', opts = {}) {
    const [rows, cols] = modelSize(ttype);
    const t = { ttype, id: 0, dataCbs: new Set(), closeCbs: new Set(), pending: [], closed: false, state: 'pending',
      isConsole: false, tap: null, sniff: !ttype,
      // device number (from '@xxxx' in the ttype, else from the HHC01018I line after the connect), records
      // received (the first one = the Hercules logo), screen model for the snapshot (page source or own tap)
      devnum: devFromTtype(ttype), recs: { st: {}, n: 0 }, inSt: {}, scr: null, dec: null, screenSource: null, rows, cols };
    const asConsole = (rows, cols) => {
      t.isConsole = true;
      t.tap = { screen: new Screen3270(rows, cols), split: new RecordSplitter(), nipDone: false, nipTimer: 0, cmd: null, queue: [] };
      this.console = t;
    };
    if (opts.console ?? /@(0010|CONSOLE)\b/i.test(ttype)) asConsole(rows, cols);
    // No ttype given: take it from the client's TTYPE IS (IAC SB 24 0 <ttype> IAC SE), which is
    // sent before any 3270 record, so the console tap still sees every record.
    const sniff = (b) => {
      for (let i = 0; i + 4 < b.length; i++) {
        if (b[i] === 255 && b[i + 1] === 250 && b[i + 2] === 24 && b[i + 3] === 0) {
          let e = i + 4; while (e < b.length && b[e] !== 255) e++;
          t.ttype = new TextDecoder().decode(b.subarray(i + 4, e)); t.sniff = false;
          t.devnum = t.devnum || devFromTtype(t.ttype);
          [t.rows, t.cols] = modelSize(t.ttype);
          if (/@(0010|CONSOLE)\b/i.test(t.ttype)) { const [r, c] = modelSize(t.ttype); asConsole(r, c); }
          return;
        }
      }
    };
    const api = {
      get ttype() { return t.ttype; },
      get id() { return t.id; },
      write: (bytes) => {
        if (t.closed) return;
        const b = Uint8Array.from(bytes);
        if (t.sniff) sniff(b);
        t.pending.push(b); if (this.M) this.pushInput(t);
      },
      onData: (cb) => { t.dataCbs.add(cb); return () => t.dataCbs.delete(cb); },
      onClose: (cb) => { t.closeCbs.add(cb); return () => t.closeCbs.delete(cb); },
      close: () => this.closeTerm(t, 'client'),
      screenText: () => (t.tap ? t.tap.screen.text() : null),
      // device number once known ('0010', '0400', ...); setScreenSource(fn): fn() returns the terminal's Read
      // Buffer image (AID, cursor, buffer with SF orders), saved with each checkpoint and written back on resume
      get devnum() { return t.devnum; },
      setScreenSource: (fn) => { t.screenSource = typeof fn === 'function' ? fn : null; },
    };
    t.api = api;
    this.terms.add(t);
    if (this.M) this.openConn(t);
    return api;
  }
  openConn(t) {
    if (t.id || t.closed) return;
    const b = new TextEncoder().encode(t.ttype).subarray(0, 47);
    this.M.HEAPU8.set(b, this.termBuf); this.M.HEAPU8[this.termBuf + b.length] = 0;
    t.id = this.M._hw_term_open(this.termBuf);
    if (t.id <= 0) { this.note(`hw_term_open(${t.ttype}) failed: no free slot`); this.closeTerm(t, 'no slot'); return; }
    this.pushInput(t);
  }
  pushInput(t) {
    const M = this.M, H = M.HEAPU8;
    while (t.id > 0 && t.pending.length) {
      const c = t.pending[0], n = Math.min(c.length, this.termBufSize);
      H.set(c.subarray(0, n), this.termBuf);
      const k = M._hw_term_input(t.id, this.termBuf, n);
      if (k < 0) { this.closeTerm(t, 'hercules'); return; }
      if (k === 0) return;                                   // ring full: next tick
      this.act.in += k; this.act.inRecs += countRecords(c.subarray(0, k), t.inSt);   // activity
      if (k === c.length) t.pending.shift(); else t.pending[0] = c.subarray(k);
    }
  }
  drain(t) {
    const M = this.M;
    for (;;) {
      const n = M._hw_term_read(t.id, this.termBuf, this.termBufSize);
      if (n === 0) return;
      if (n < 0) { this.closeTerm(t, 'hercules'); return; }
      this.act.out += n;                                              // activity
      this.deliver(t, M.HEAPU8.slice(this.termBuf, this.termBuf + n));   // copy out of the SAB
    }
  }
  // Hercules -> terminal bytes (also used for the screen that a resume writes back)
  deliver(t, bytes) {
    t.recs.n += countRecords(bytes, t.recs.st);
    if (t.tap) bytes = this.tapConsole(t, bytes);
    else if (this.snap && !t.screenSource) {                        // own screen model (no page source)
      if (!t.scr) { t.scr = new Screen3270(t.rows || 24, t.cols || 80); t.dec = new TelnetDecoder({ onRecord: (r) => t.scr.process(r) }); }
      t.dec.feed(bytes);
    }
    if (!bytes.length) return;
    for (const cb of t.dataCbs) try { cb(bytes); } catch (e) { console.error(e); }
  }
  closeTerm(t, why) {
    if (t.closed) return;
    t.closed = true;
    if (this.M && t.id > 0) this.M._hw_term_close(t.id);
    this.terms.delete(t);
    if (this.console === t) this.console = null;
    for (const cb of t.closeCbs) try { cb(why); } catch (e) { console.error(e); }
  }

  // ---- master console automation (tap on the 0010 stream) ----
  // Every record is applied to a shadow screen. The MVS 3270 console reads the input with
  // Read Buffer after an AID, so to type a command (consoleCommand) the runtime answers the
  // next Read Buffer itself from a copy of the shadow screen with the command typed in, and
  // does not pass that one Read Buffer to the visitor's terminal.
  tapConsole(t, bytes) {
    const out = [];
    for (const seg of t.tap.split.feed(bytes)) {
      if (seg.data) {
        const c = seg.data[0];
        if (t.tap.cmd && (c === 0xf2 || c === 0x02)) {
          const reply = frameRecord(t.tap.cmd.readBuffer(AID.ENTER));
          t.tap.cmd = null; clearTimeout(t.tap.cmdTimer);
          t.pending.push(reply); this.pushInput(t);
          this.nextConsoleCommand(t);
          continue;
        }
        t.tap.screen.process(seg.data);
        out.push(seg.raw);
        this.onConsoleScreen(t);
      } else out.push(seg.raw);
    }
    if (out.length === 1) return out[0];
    const all = new Uint8Array(out.reduce((a, x) => a + x.length, 0));
    let o = 0; for (const x of out) { all.set(x, o); o += x.length; }
    return all;
  }
  onConsoleScreen(t) {
    const text = t.tap.screen.text();
    if (!this.ev.ready && /IKT007I/.test(text) && !this.snap?.plan?.resume) this.markReady('0010');
    if (this.o.autoNip && !t.tap.nipDone && /IEA101A/.test(text)) {
      clearTimeout(t.tap.nipTimer);                          // answer when the screen is quiet
      t.tap.nipTimer = setTimeout(() => {
        if (t.tap.nipDone || !/IEA101A/.test(t.tap.screen.text())) return;
        t.tap.nipDone = true; this.ev.nipAnswered = performance.now();
        this.injectRecord(t, t.tap.screen.readModified(AID.ENTER));
        this.note('IEA101A on 0010: sent ENTER (default system parameters)');
      }, 300);
    }
  }
  injectRecord(t, rec) {
    const f = frameRecord(rec);
    for (const cb of this.injectCbs) try { cb(t.api, f); } catch (e) { console.error(e); }
    t.pending.push(f); this.pushInput(t);
  }
  // Type an MVS command on the master console (0010) and press ENTER. Returns false if no
  // console terminal is connected. The visitor's terminal shows the reply, not the typed text.
  consoleCommand(text) {
    const t = this.console;
    if (!t || !t.id || t.closed) return false;
    if (t.tap.cmd || t.tap.queue.length) { t.tap.queue.push(text); return true; }   // one at a time
    return this.sendConsoleCommand(t, text);
  }
  nextConsoleCommand(t) {
    if (t.tap.queue.length && !t.tap.cmd) setTimeout(() => { if (!t.tap.cmd && t.tap.queue.length) this.sendConsoleCommand(t, t.tap.queue.shift()); }, 200);
  }
  sendConsoleCommand(t, text) {
    const src = t.tap.screen, s = new Screen3270(src.rows, src.cols);
    s.buf.set(src.buf); s.fa.set(src.fa); s.cursor = src.cursor;
    if (src.protectedAt(s.cursor) || s.fa[s.cursor] >= 0) {     // cursor not in the entry area
      const f = s.fields().filter((x) => !(x.attr & 0x20) && x.len > 0).pop();
      if (!f) return false;
      s.cursor = f.data;
    }
    const f = s.fieldStart(s.cursor);                           // clear the entry field first
    if (f >= 0) for (let p = (f + 1) % s.size; s.fa[p] < 0; p = (p + 1) % s.size) s.buf[p] = 0;
    if (f >= 0) s.cursor = (f + 1) % s.size;
    if (!s.type(text)) return false;
    t.tap.cmd = s;
    t.tap.cmdTimer = setTimeout(() => { if (t.tap.cmd === s) { t.tap.cmd = null; this.note('consoleCommand: no Read Buffer from MVS'); this.nextConsoleCommand(t); } }, 5000);
    this.injectRecord(t, s.readModified(AID.ENTER));
    this.note(`0010 command: ${text}`);
    return true;
  }

  // ---- Hercules commands ----
  command(cmd) {
    if (!this.M) return false;
    const b = new TextEncoder().encode(cmd);
    if (b.length >= this.cmdBufSize) return false;
    this.M.HEAPU8.set(b, this.cmdBuf); this.M.HEAPU8[this.cmdBuf + b.length] = 0;
    return this.M._hw_command(this.cmdBuf) === 0;
  }
  ipl(dev = this.o.ipl || '150') {
    if (this.ev.iplSent) return false;
    this.ev.iplSent = performance.now();
    this.note(`ipl ${dev} (console connected: ${!!this.ev.consoleConnected})`);
    this.setState('ipl', { iplDev: dev, consoleAtIpl: !!this.ev.consoleConnected });
    if (this.persist?.enabled) {
      this.iplTimer = setTimeout(() => this.persistFail(`no IKT007I within ${this.p.iplTimeoutMs / 1000} s`), this.p.iplTimeoutMs);
      // a CCKD error while the devices were opened (before the IPL): report it now, the IPL cannot work
      if (this.persist.diskErrors.length) setTimeout(() => this.persistFail(`disk error: ${this.persist.diskErrors[0]}`), 0);
    }
    return this.command(`ipl ${dev}`);
  }
  // Clean MVS shutdown. 0010 is the master console, so first make 009 the master console
  // from 0010 (V 009,MSTCONS), then run the shutdown script (HAO chain on 009, see
  // conf/web-shutdown.rc). Resolves when Hercules has ended.
  async shutdown({ timeoutMs = 300000 } = {}) {
    if (this.console && this.consoleCommand('V 009,MSTCONS')) {
      await this.waitLog(/IEE143I|MSTCONS/, 15000).catch(() => this.note('no IEE143I seen; trying the script anyway'));
    }
    this.command(`script ${this.o.shutdownRc}`);
    await this.waitState('stopped', timeoutMs);
  }
  waitLog(re, ms) {
    return new Promise((resolve, reject) => {
      const off = this.onLog((l) => { if (re.test(l)) { off(); clearTimeout(to); resolve(l); } });
      const to = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${re}`)); }, ms);
    });
  }
  waitState(s, ms) {
    return new Promise((resolve, reject) => {
      if (this.state === s) return resolve(this.info);
      const off = this.onState((st, info) => { if (st === s) { off(); clearTimeout(to); resolve(info); } });
      const to = setTimeout(() => { off(); reject(new Error(`timeout waiting for state ${s}`)); }, ms);
    });
  }

  stats() {
    const M = this.M;
    if (!M) return null;
    return {
      heapUsed: M._hw_stat(ST.HEAP_USED) >>> 0, heapPeak: M._hw_stat(ST.HEAP_PEAK) >>> 0,
      arena: M._hw_stat(ST.ARENA) >>> 0, sbrk: M._hw_stat(ST.SBRK) >>> 0, sbrkPeak: M._hw_stat(ST.SBRK_PEAK) >>> 0,
      samples: M._hw_stat(ST.SAMPLES) >>> 0, commands: M._hw_stat(ST.CMDS) >>> 0,
      // memoryBytes: the wasm memory size (hw_stat MEM, from the heap sampler; an older build: the main-thread view,
      // which can be stale after a growth in a worker with WEBGROW=1)
      memoryBytes: (M._hw_stat(ST.MEM) >>> 0) || M.HEAPU8.length, logDropped: M._hw_log_dropped() >>> 0,
      threads: this.ev.threads, threadsPeak: this.ev.threadsPeak, errors: this.ev.errors.slice(),
      crashed: this.ev.crashed || null,
      workersCreated: globalThis.__mvsWorkerCount ? globalThis.__mvsWorkerCount() : null,
      poolExhausted: globalThis.__mvsWorkerCount ? globalThis.__mvsWorkerCount() > this.o.poolSize : null,
      lazy: this.lazyStats(),
      snapshot: this.snapStats(),
      // SRM interval set at 'ready' (srmTune); null = not (yet) done or the MVS blocks not found
      srmTune: (() => { const v = M._hw_stat(ST.SRMTUNE) >>> 0; return v ? { units: Math.floor(v / 1000), routines: v % 1000, sentAt: this.srmTuneSent ?? null } : null; })(),
      // output devices (outsink.cpp): bytes written, files, heap bytes in their rings, dirs, largest file size
      output: M._hw_outsink_statd ? { bytes: M._hw_outsink_statd(0), files: M._hw_outsink_statd(1), ringHeap: M._hw_outsink_statd(2),
        dirs: M._hw_outsink_statd(3), maxFileBytes: M._hw_outsink_statd(4) } : null,
    };
  }
  // Lazy DASD counters (null if the volumes were loaded eagerly). Lock-free reads.
  lazyStats() {
    const M = this.M;
    if (!M || !M._hw_lazy_statd || !M._hw_lazy_vol_count()) return null;
    const o = {};
    LZ.forEach((k, i) => { o[k] = M._hw_lazy_statd(i); });
    o.waitMs = Math.round(o.waitMs); o.maxWaitMs = Math.round(o.maxWaitMs);
    o.prefetchDone = !!o.prefetchDone;
    o.traceLen = M._hw_lazy_trace_len() >>> 0;
    o.traceAtIkt007i = this.lazyTraceAtReady ?? null;   // trace length when IKT007I was seen
    return o;
  }
  // First reads of each track since the start, in order: ['0150,0', ...] (devnum,trk; boot manifest input)
  lazyTrace(from = 0, to) {
    const M = this.M;
    if (!M || !M._hw_lazy_trace_len) return [];
    const n = M._hw_lazy_trace_len() >>> 0, p = M._hw_lazy_trace_buf() >>> 2, out = [];
    const devs = []; for (let i = 0; i < M._hw_lazy_vol_count(); i++) devs.push(M._hw_lazy_vol_devnum(i).toString(16).toUpperCase().padStart(4, '0'));
    const H = new Uint32Array(M.HEAPU8.buffer);
    for (let i = from; i < Math.min(n, to ?? n); i++) { const x = H[p + i]; out.push(`${devs[x >>> 24]},${x & 0xFFFFFF}`); }
    return out;
  }

  markReady(where) {
    if (this.ev.ready) return;
    this.ev.ready = performance.now();
    if (this.M && this.M._hw_lazy_trace_len) this.lazyTraceAtReady = this.M._hw_lazy_trace_len() >>> 0;
    clearTimeout(this.iplTimer);
    if (this.persist?.started) this.persist.marker = this.marker.write({ lastIplOk: Date.now() });
    // from now on flushNow() may ask for hardener passes; and (if set) the hardener interval (PERSIST_DEFAULTS.dhint)
    if (this.persist?.enabled) {
      this.fastSave = performance.now();
      if (this.p.dhint != null) this.command(`cckd dhint=${this.p.dhint}`);
      // write-through from now on (PERSIST_DEFAULTS.wrthru 'ready'): first one hardener pass for what the IPL left
      // in the cache, then every channel program writes its tracks before it ends
      if (this.p.wrthru === 'ready' && this.M._hw_cckd_wrthru) {
        this.M._hw_cckd_flush?.();
        this.M._hw_cckd_wrthru(1);
        this.persist.wrthruAt = Math.round(performance.now());
        this.note('persist: CCKD write-through on (TSO ready)');
      }
    }
    // (a resumed machine has the SRM values in its main storage already)
    if (this.o.srmTune > 0 && where !== 'resume') { this.command(`srmtune ${Math.round(this.o.srmTune)}`); this.srmTuneSent = Math.round(performance.now()); }
    this.setState('ready', { readyVia: where, iplToReadyMs: this.ev.iplSent ? Math.round(this.ev.ready - this.ev.iplSent) : null });
    if (this.o.rollMode && this.console) setTimeout(() => this.consoleCommand(this.o.rollMode), 500);
  }

  // ---- log parsing ----
  onLine(line) {
    const ev = this.ev;
    if (/^HHC00100I /.test(line)) { ev.threads++; ev.threadsPeak = Math.max(ev.threadsPeak, ev.threads); }
    else if (/^HHC00101I /.test(line)) ev.threads--;
    else if (/^HHC02264I /.test(line) && !ev.rcDone) ev.rcDone = performance.now();
    else if (/^HHC01018I 0:0010 /.test(line)) { ev.consoleConnected = performance.now(); this.connectedDevs.add('0010'); }
    else if (/^HHC01603I ipl /i.test(line) && !ev.iplLog) ev.iplLog = performance.now();
    else if (/^HHC01412I /.test(line)) ev.ended = performance.now();
    if (/^HHC\d{5}[ES] /.test(line)) ev.errors.push(line);
    let dm;
    if ((dm = /^HHC01018I \d:([0-9A-F]{4}) /.exec(line))) this.devConnected(dm[1]);
    else if ((dm = /^HHC01022I \d:([0-9A-F]{4}) /.exec(line))) this.connectedDevs.delete(dm[1]);
    this.checkCrash(line);
    if (!ev.ready && /IKT007I/.test(line) && !this.snap?.plan?.resume) this.markReady('log');
    if (this.persist) {
      let m;
      if ((m = /^webload-opfs: (\{.*\})\s*$/.exec(line))) { try { this.persist.opfs = JSON.parse(m[1]); } catch { /* ignore */ } }
      if (/^HHC003\d\dE /.test(line)) { this.persist.diskErrors.push(line); if (ev.iplSent) this.persistFail(`disk error: ${line}`); }
      if (ev.iplSent && /^HHC00809I .*disabled wait state/.test(line) && !/000A0000 00000CCC/.test(line)) this.persistFail(`MVS stopped: ${line}`);
    }
    this.emitLine(line);
  }

  // ---- main-thread poll (lock-free calls only) ----
  tick() {
    const M = this.M, ev = this.ev, o = this.o;
    // log
    for (let guard = 0; guard < 64; guard++) {
      const n = M._hw_log_read(this.logBuf, this.logBufSize);
      if (n <= 0) break;
      const s = this.logRest + this.dec.decode(M.HEAPU8.slice(this.logBuf, this.logBuf + n), { stream: true });
      const lines = s.split('\n');
      this.logRest = lines.pop();
      for (const l of lines) this.onLine(l.replace(/\r$/, ''));
    }
    // load progress / phase
    const ph = M._hw_phase();
    const lz = (ph >= PH.LOADING) ? this.lazyStats() : null;
    if (ph === PH.LOADING || (ph === PH.INIT && this.state === 'loading')) {
      let loaded = M._hw_load_bytes() >>> 0, total = M._hw_load_total() >>> 0;
      const files = M._hw_load_files() >>> 0;
      let cached;
      if (lz && lz.bootTotal) { loaded = lz.bootLoaded; total = lz.bootTotal; cached = lz.cacheBytes; }
      if (loaded !== this.info.loaded || total !== this.info.total) this.setState('loading', { loaded, total, files, cached, lazy: !!lz });
    } else if (ph >= PH.STARTING && !this.t.loaded) {
      this.t.loaded = performance.now();
      if (ph !== PH.FAILED) this.persistStarted();
      const info = { loaded: M._hw_load_bytes() >>> 0, total: M._hw_load_total() >>> 0,
        files: M._hw_load_files() >>> 0, loadMs: Math.round(this.t.loaded - this.t.create), lazy: !!lz };
      if (lz && lz.bootTotal) Object.assign(info, { loaded: lz.bootLoaded, total: lz.bootTotal, cached: lz.cacheBytes,
        cachedAll: lz.prefetchDone && lz.netBytes === 0 && lz.cacheBytes > 0 });
      this.setState('loading', info);
    }
    if (lz && this.t.loaded && this.dasdCbs.size && (lz.bootLoaded !== this.lastDasd?.bootLoaded || lz.prefetchDone !== this.lastDasd?.prefetchDone)) {
      this.lastDasd = lz;
      for (const cb of this.dasdCbs) try { cb(lz); } catch (e) { console.error(e); }
    }
    if (ph === PH.RUNNING) this.runningOk(this);
    if (ph === PH.FAILED && this.state !== 'error') {
      this.flushLog(); this.setState('error', { error: 'Hercules failed to start (see log)' });
      this.runningFail(new Error('Hercules failed to start (see log)'));
    }
    if (ph === PH.ENDED && this.state !== 'stopped') { this.flushLog(); this.setState('stopped', {}); }
    // terminals
    const seq = M._hw_term_out_seq() >>> 0;
    const changed = seq !== this.lastSeq; this.lastSeq = seq;
    for (const t of [...this.terms]) {
      if (!t.id) continue;
      if (t.pending.length) this.pushInput(t);
      if (changed) this.drain(t);
    }
    // IPL
    if (this.snap && ph === PH.RUNNING) this.snapTick();
    if (o.ipl && ev.rcDone && !ev.iplSent && ph === PH.RUNNING && !this.snap?.plan?.resume) {
      const waitingConsole = this.console && !ev.consoleConnected;
      if (!waitingConsole || performance.now() - ev.rcDone > o.consoleWaitMs) this.ipl();
    }
  }
  // A wasm trap or abort in a Hercules thread: Emscripten prints "Aborted(<why>)" (stderr of that thread),
  // then the main thread logs "worker sent an error! ...: Uncaught RuntimeError: unreachable". The thread is
  // gone, often with a lock held, so MVS and every terminal stop. Report it as
  // state 'crashed' {error, oom}; the page shows it instead of terminals that stay at X SYSTEM.
  checkCrash(line) {
    const ev = this.ev;
    if (!/^Aborted\(|worker sent an error!|RuntimeError: (unreachable|memory access out of bounds)/.test(line)) return;
    if (ev.crashed) { if (/Aborted\(OOM\)/.test(line)) ev.crashed.oom = true; return; }
    ev.crashed = { at: performance.now(), line, oom: /Aborted\(OOM\)/.test(line) };
    this.note(`Hercules thread crashed: ${line}`);
    setTimeout(() => this.setState('crashed', { error: ev.crashed.line, oom: ev.crashed.oom }), 0);
  }
  flushLog() { if (this.logRest) { const l = this.logRest; this.logRest = ''; this.onLine(l); } }
}
