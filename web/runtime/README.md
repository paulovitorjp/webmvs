# web/runtime: MVS runtime for the page

`mvs-runtime.js` loads the browser build of Hercules (`hercules.js` + `hercules.wasm`, made by
`make -f src/wasm/Makefile.wasm web`), loads the DASD and boot files into the wasm file system
inside a worker, starts Hercules, starts the IPL, and gives the page raw TN3270 connections.
It has no UI. The visitor page renders the terminals.

## Files
| File | What |
|---|---|
| `mvs-runtime.js` | the runtime module (ES module, no dependencies except `tn3270-headless.js`) |
| `tn3270-headless.js` | telnet record splitter, 3270 screen model, headless TN3270 client (tests, console automation) |
| `mvs-snapshot.js` | Snapshot slots on OPFS (worker I/O, fingerprint, slot choice, scheduler rules, screen record) |
| `snap-unit.mjs` | Node unit tests of `mvs-snapshot.js` (`node web/runtime/snap-unit.mjs`) |
| `test.html` | bare test page: boots MVS, drives 0010 and one TSO terminal, prints `RESULT {json}` |
| `run-test.mjs` | Playwright runner for `test.html` (Chromium / Firefox), samples browser RSS |
| `serve.mjs` | static test server, 127.0.0.1 only; `--headers coi` (COOP/COEP/CORP) or `none` |
| `package.json` | playwright 1.56.1, coi-serviceworker 0.1.7 (test only) |

Build: `scripts/build.sh ext | build | chunks | seed`. DASD chunks: `scripts/mk-dasd-chunks.sh <out>`.

## Site layout (what the runtime expects by default)
```
<site>/runtime/   mvs-runtime.js tn3270-headless.js hercules.js hercules.wasm [coi-serviceworker.js]
<site>/conf/      web.cnf web-browser.rc web-shutdown.rc
<site>/boot/      herclogo.txt SCRIPTS/{pjes2,zeod,quiesce,poweroff}   (from the MVS/CE release tar)
<site>/dasd/      manifest.json + <volume>.<NNN> chunks (<= 25 MiB each, default 8 MiB)
```
All URLs can be changed with options (`herculesUrl`, `siteUrl`, `manifest`, `files`). If the page
bundles `mvs-runtime.js`, pass `herculesUrl` and `siteUrl` explicitly (the defaults use
`import.meta.url`).

## API
```js
import { createRuntime } from './runtime/mvs-runtime.js';
const rt = createRuntime(options);            // nothing starts yet
rt.onState((state, info) => {});              // returns an unsubscribe function
rt.onLog((line) => {});                       // Hercules log lines + "mvs-runtime: ..." notes
const con = rt.openTerminal('IBM-3278-2-E@0010');   // master console: open BEFORE start()
await rt.start();                             // resolves when the wasm module runs
const tso = rt.openTerminal('IBM-3278-2-E');  // TSO, 0400 pool (no suffix)
rt.command('devlist');                        // hidden Hercules command (true = queued)
rt.consoleCommand('D A,L');                   // type an MVS command on 0010 + ENTER
await rt.shutdown();                          // clean MVS shutdown through the master console
rt.stats();                                   // heap, threads, errors (see below)
```
- `openTerminal(ttype)` returns `{ write(bytes), onData(cb), onClose(cb), close(), id, ttype, screenText() }`.
  The bytes are the raw TN3270 stream (telnet negotiation included). The terminal library does the
  negotiation itself and must send `ttype` in `TTYPE IS` (plain TN3270, no TN3270E; Hercules
  console.c has no TN3270E). `@0010` selects the master console; a ttype without a suffix gets a
  free 0400-0403 device. It can be called before `start()` (the connection opens when the module is
  ready) and any time later. `screenText()` is the runtime's shadow copy of the 0010 screen (0010 only).
  The terminal must answer Read Buffer, Read Modified and WSF Read Partition Query (TSO sends a
  Query when the ttype ends in `-E`).
- States: `loading` (repeated with `{loaded, total, files}`; last one adds `loadMs`), `ipl`
  (`{iplDev, consoleAtIpl}`), `ready` (IKT007I seen; `{readyVia, iplToReadyMs}`), `stopped`
  (Hercules ended), `error` (`{error}`), `crashed` (`{error, oom}`: a Hercules thread aborted or trapped,
  `Aborted(...)` / `worker sent an error!` in the log; MVS and the terminals do not respond any more, see
  also `stats().crashed`). Switch to the TSO tab at `ready`.
- `outputSink`: the
  output devices' directories (web.cnf: JES2 PRINTER1/2 and the hardcopy log in `printers/`, the punches in
  `punchcards/`) are on the bounded WasmFS backend `src/wasm/outsink.cpp` (`wasm_main --outsink=... --outsink-ring=KiB`):
  each file keeps its logical size and only its last `ringKiB` KiB in the heap. As WasmFS memory files they kept all
  output in the fixed heap and doubled their capacity: `Aborted(OOM)` after about 16 MiB of print.
  `stats().output` = `{bytes, files, ringHeap, dirs, maxFileBytes}`.
- `srmTune`: at `ready` the runtime
  queues the hidden command `srmtune <n>` (handled in `src/wasm/wasm_main.c`, `srm_tune()`; not a Hercules command).
  It sets the MVS 3.8 SRM time-driven interval in main storage from 1000 to `n` units of 1.024 ms: `RMPTTOM`/`RMPTTOL`
  in the SRM parameter table and the interval of every time-driven SRM routine that has the default 1000 (CVT ->
  RMCT -> RMPT and the RMCTTMQE chain; every eye-catcher is checked, nothing is changed on a mismatch). Without it a
  TSO user that MVS swapped out at a terminal wait is swapped in only at the next SRM interval (up to 1.024 s) while a
  CPU-bound batch job keeps the one CPU busy, so TSO answers 30-200 x slower (measured in a long soak test). Log line
  `wasm_main: srmtune <n> rc=<routines changed>: ...`; `stats().srmTune` = `{units, routines, sentAt}` (null before).
- `dasdReadOnly` (default `true`): the base volumes are `chmod 0444` in the wasm FS after the load, so CCKD
  opens them read-only and writes only to the `sf=` shadow files. With a writable base, CCKD writes into the
  base file, and a WasmFS memory file that grows past its loaded size doubles its capacity in one allocation
  (an `Aborted(OOM)` hang). Lazy volumes (format 2) are read-only anyway.
- IPL order: the rc file (`conf/web-browser.rc`) has no IPL. After the rc file ends
  (`HHC02264I`), the runtime waits until the 0010 terminal is connected (`HHC01018I 0:0010`, at
  most `consoleWaitMs`, default 15 s), then sends `ipl 150`. NIP then uses 0010. When the 0010
  screen shows `IEA101A`, the runtime sends ENTER on 0010 (`autoNip`, default on) like an operator.
  If no 0010 terminal is open, NIP uses the 3215 at 009 and the HAO rule in the rc file answers.
  At `ready` it types `K S,DEL=R,RNUM=19,RTME=1` on 0010 (`rollMode`), so the console never stops
  at `IEE159E MESSAGE WAITING`.
- `consoleCommand(text)`: the MVS 3270 console reads its input with Read Buffer after the AID, so
  the runtime sends ENTER and answers that one Read Buffer itself from its shadow screen with the
  text in the entry field. That Read Buffer is not passed to the visitor's terminal. Commands are
  sent one at a time (queued). The reply shows on the visitor's 0010 screen.
- `shutdown()`: `V 009,MSTCONS` on 0010 (009 becomes master, `IEE143I`), then
  `script conf/web-shutdown.rc` (the HAO chain on 009: JES2, Z EOD, QUIESCE, poweroff).
  Resolves at state `stopped` (about 45 s in Chromium).
- `stats()`: `{heapUsed, heapPeak (mallinfo uordblks), sbrk, sbrkPeak (heap high-water), arena,
  memoryBytes (current wasm memory size, `hw_stat(9)`; = INITIAL_MEMORY unless the build has WEBGROW=1), threads, threadsPeak (from HHC00100I/HHC00101I), errors
  (HHC....E/S lines), logDropped, commands, output (outsink counters), srmTune}`.
- The page must be cross-origin isolated (COOP/COEP headers, or `coi-serviceworker.js` loaded
  before the module on hosts without headers); `start()` fails with state `error` otherwise.

## Persistence: `createRuntime({ persist: true })`
The visitor's machine is kept in this browser: every CCKD shadow file (`sf=`) is on the WasmFS
**OPFS backend**, mounted at `/opfs` (`wasm_main --opfs=/opfs`), in the OPFS directory `shadow/`.
The base volumes stay in WasmFS memory and are made read-only (0444), so CCKD opens them RO and
writes go to the shadows (with a writable base CCKD opens it R/W and never uses a shadow).
- Config: the runtime fetches `conf/web.cnf` and changes only `sf=shadow/` -> `sf=/opfs/shadow/` and
  adds `fsync=1` to the `CCKD` line (CCKD then fdatasyncs at every harden and reuses freed space
  only after a harden). The changed text goes to the loader inline (`files[].text`).
- Web Lock `mvs-machine` (`mvs-persist.js acquireMachineLock`): taken before anything starts; if
  another tab holds it (after a 3 s wait for a page in this tab that is still being replaced),
  `start()` throws `Error{code:'locked'}` and the state is `locked`. The page shows "MVS is running
  in another tab". The lock is held for the life of the page.
- Loader (`library_webload.js`, in the loader worker, before `impl()`): `opfs.reset` removes
  `shadow/`; then every existing shadow file is opened with a sync access handle and closed again,
  retrying up to 15 s while a closing page still holds one (else CCKD's R/W open gets EACCES, it opens
  the file RO and makes a new shadow `_2`); then seed files are written if missing
  (`dasd/seed/seed.json`: `mvsres_1.cckd` = SMFPRM00 `MAN=NONE`, `scripts/mk-seed-shadow.py`).
  Result: log line `webload-opfs: {files, seeded, reset, waitMs, retries}` -> `rt.persist.opfs`.
- Dirty-start marker (localStorage `mvs-machine-state`, `MachineMarker`): `state: 'running'` from
  the moment Hercules starts until `rt.markClean()` (the page calls it after a clean MVS shutdown and
  Hercules quit). A start that finds `'running'` has `rt.persist.dirtyStart = true`.
- IPL watchdog (persist mode only): no IKT007I within 180 s after `ipl()`, a disabled wait other than
  `000A0000 00000CCC`, or an `HHC003nnE` CCKD error -> state `iplfail {reason, dirtyStart}`; the page
  offers "Reset machine" (`?autoreset=1` accepts it, for tests).
- Base check: the marker records the sha256 of every base volume (`manifest.json`) and of every seed
  file; when one of them changes (a new image), the next start resets the shadows (`resetWhy: 'base
  image changed: <names>'`), because a shadow is only valid on the base image it was written on.
- `rt.requestReset(why)`: sets `resetPending`; the NEXT load deletes `shadow/` in the loader before
  Hercules starts (so a reset never happens while Hercules has the files open). `why` starting with
  `auto` counts as an automatic reset (`marker.autoResets`).
- Write-through (`persist.wrthru`: `'ready'` (default) | `'start'` | false): Hyperion patch 0014:
  at the end of each channel program that updated a track, CCKD writes the device's updated tracks and the
  channel program ends only after they are in the OPFS shadow file. MVS then sees its writes complete in its own
  order, and a closed or reloaded tab is like a power cut between two channel programs. `'ready'`: the runtime
  turns it on at state `ready` (`hw_cckd_wrthru(1)`, after one hardener pass); during the IPL the CCKD cache stays,
  so a tab closed during the IPL loses that IPL's writes as a whole (JES2 then warm-starts from its old
  checkpoint). `'start'`: `wasm_main --cckd-wrthru` before the IPL. `persist.scratchDevs` (default `['0152']`,
  PAGE00) never get write-through (`--cckd-wrthru-skip=`). `rt.persist.wrthru`, `rt.persist.wrthruAt`.
- Save state: without write-through CCKD keeps a changed track in its cache until a Dasd Hardener or garbage
  collector pass hands it to the writer thread; with the Hercules default `dhint=10` a reload 1-5 s after a TSO
  SAVE lost the member (measured), and a flush cut off by a closed tab could leave a JES2
  checkpoint that JES2 rejects ($HASP096). `persist.dhint` (default null = unchanged) sets `cckd dhint=<n>` at
  state `ready`. `rt.saveState()` = `{ dirty, userDirty, devs, unhardened, since,
  flushes, supported }` (lock-free; `dirty` = updated track images still in the CCKD cache (`userDirty`: not counting `persist.scratchDevs`,
  default `0152` = PAGE00, paging only), from the
  `wasm_webdirty` thread every 100 ms, `hw_stat(10)`; `devs` = their device numbers), `rt.flushNow(why)` asks for
  an immediate hardener pass (`hw_cckd_flush()`: flush the cache, wait for the writes, harden + fdatasync = OPFS
  `flush()`; only from `ready` on). The page calls it when it sees unsaved data after the IPL, when it is hidden
  and at pagehide (all only after TSO ready).
- `rt.persist` = `{ enabled, why, lock, dirtyStart, reset, resetWhy, opfs, seedFiles, marker,
  iplFail, diskErrors }`; `rt.shadows()` lists the OPFS files; `rt.shadowBytes(name)` reads one
  (only while Hercules is stopped). Without OPFS (some private windows) persist is off (`why`).

## Snapshot: continue the running machine on the next visit
On by default in page mode when persistence is on (`createRuntime({ persist: true })`; `snapshot: true | {...}` in direct
use; page: `?snap=0` off, `?resume=0` never resume, `?snap.<key>=<value>` overrides `SNAP_DEFAULTS` in `mvs-snapshot.js`).
Needs a Hercules with the hidden commands `checkpoint <dir> [screens=0 ...]`, `srbuildid <id>` and `resume <file>`
(patch 0015).
- **Checkpoint** (`rt.checkpoint(why)`, also automatic): `checkpoint /opfs/snap/s<seq> screens=0`. The C side stops the
  CPUs, drains the I/O, copies every CCKD shadow file at that point (cache flushed, hardened, under the device locks),
  writes `machine.srf` and last `checkpoint.json`, and restarts the CPUs (pause 0.24-0.33 s in Chromium, 1.5 s in
  Playwright's Firefox). The runtime then hashes the files in its OPFS worker and writes `page.json` (screens of the
  terminals as Read Buffer images, the page's data: console history, tabs), `manifest.json` (fingerprint, sizes and
  sha256) and **last** `snap/current`. It keeps the new slot and the previous one. A slot directory is never changed
  after it is written (WasmFS caches directory entries): every checkpoint is a new `s<seq>`. Older slots are removed
  through Hercules' WasmFS (hidden command `snaprm /opfs/snap/s<n>`, `src/wasm/wasm_main.c`), so
  WasmFS drops its cached entries and their OPFS handles; a build without it (`HHC01600E`) or no reply within
  `pruneWaitMs` -> the OPFS worker removes the slot as before. `stats().snapshot.pruned` / `pruneC`.
- **Incremental**: `snapshot.incr` (default on) adds `incr=1
  base=/opfs/snap/<base> maxdelta= maxshadow=`: when `<base>` is the C side's tracked base (its last full checkpoint,
  or the slot that `resume ... track=1` resumed), the slot is a **delta**: `machine.srf` has only the 4 KB pages of
  main storage that differ from the base (XXH64 per page) and a reference to the base's `machine.srf`; the shadow
  files are not copied, `shadows.dlt` has the 4 KB blocks written since the base copy (CCKD bitmaps). Restore = the base
  slot's shadow copies + `shadows.dlt` (in the loader); resume reads the base's main storage, then the pages. A delta
  is always against a full slot (never a chain); a full one is written when there is no tracked base, after
  `fullEvery` (40) deltas, or when the delta is over `maxDelta` % (50) of the pages / `maxShadow` % (90) of the shadow
  bytes. Pruning keeps the current and the previous slot and their base; a delta slot is used only with its base.
  Pause: Chromium 30-90 ms (full 230-300), Playwright Firefox about 0.25 s (full 1.3 s). `manifest.json` has `kind`
  (`full`/`delta`), and for a delta `base { gen, files, srf }` and `delta { name, size, sha256 }`.
- **pagehide wait**: the page waits (lock-free spin on `hw_stat` 40, the C side's checkpoint counter) until a
  running checkpoint ended, at most `unloadWaitMs` ('auto' = 2 s; 0 in Firefox, where the checkpoint does not move on
  while the page's thread waits); result in localStorage `mvs-snap-unload`. In Chromium most page closes and reloads
  now resume the close checkpoint itself.
- **Memory per checkpoint**: the worker hashes the slot files through a sync access
  handle into one reused buffer (no new ArrayBuffer per file), and patch 0017 makes the C side read its own files for
  the crc32 through a read-write open (a WasmFS OPFS read-only open reads through a Blob: a new 64 KB ArrayBuffer per
  `read()`). Unknown worker operations are an error (`unknown snapshot worker op`).
- **When** (`schedDecision`): `visibilitychange` -> hidden and `pagehide` (at once, if anything changed); 3 s after the
  last terminal I/O or disk write when keys were pressed since the last checkpoint and CP00 is mostly in a wait state
  (1.5 s, at most every 5 s); every 60 s while idle if the terminals or the printers changed; every 5 min if only MVS's own
  disk writes changed; never before 10 s after TSO ready, during a checkpoint/resume, or after Shut down started.
  Activity = terminal bytes, printer/punch bytes, CCKD track writes (`hw_stat` 15), CP00 wait state (`hw_stat` 17).
  The start of a checkpoint is synchronous (also in a pagehide handler); localStorage `mvs-snap-intent` records it,
  so a checkpoint that ended after the page was gone is committed by the next load (if `checkpoint.json` has `"end":true`).
- **Load** (`snapSetup`, before the module starts): fingerprint = { format, wasm (bundle: the 12 hex digits in
  `hercules.<h>.wasm`, else the sha256 of the bytes), sha256 of `hercules.js`, of the DASD manifest, seed list, the
  persistent `web.cnf` text and the rc file }. The newest slot with the same fingerprint and the manifest sizes is
  chosen (`current` first, then older ones, then a completed but uncommitted one of the intent). The loader worker
  checks the sha256 of every slot file, then **replaces** the files of `shadow/` with the slot's copies (the live
  shadows are newer than the checkpoint; a resume on them would mix two points in time). Write-through is on from the
  start (`--cckd-wrthru`). If no slot is used, the loader removes `snap/` (this load IPLs; every old slot is older than
  the disks from now on).
- **Resume** (`rt.resumeMachine()`, the page calls it instead of `ipl()` when `rt.snapshotPlan().resume`): wait for the
  rc file and for every terminal of the checkpoint (the page opens them with `<ttype>@<devnum>`), write the saved screen
  to each (EW + buffer + SBA + IC, as sr.c does), `srbuildid <wasm id>`, `resume /opfs/snap/<gen>/machine.srf`; watchdog:
  `resume complete` (HHC02026I) within 30 s, CP00 started and executing within 10 s, and MVS answers `/D T` on the hidden
  3215 (IEE136I in the Hercules log) within 30 s. Then state `ready` (`readyVia: 'resume'`). On a failure the slots are
  discarded (`snap/current` = `{discarded}`), state `resumefail {reason}`; the page reloads and that load IPLs.
- **Discarded** by: Shut down (start and `markClean()`), `requestReset()`, a failed restore/resume, `rt.snapshotDiscard(why)`
  (the page's "Start fresh (IPL)"), any fingerprint change (build, image, seed, config, rc), an IPL.
- **Stale protection** (`stale: 'ipl'`): localStorage `mvs-snap-activity` records keys pressed and disk writes after the
  newest committed checkpoint. If the page was closed after such writes (a TSO SAVE 1 s before the close) and the close
  checkpoint did not finish, the next load IPLs on the newer disks instead of resuming the older machine (which would
  lose the SAVE). `stale: 'resume'` prefers the session.
- API: `rt.snapshotPlan()` -> `{ resume, why, gen, savedAt, terminals, page, commit }`; `rt.resumeMachine()`;
  `rt.checkpoint(why)` -> `{ ok, gen, cMs, pauseMs, hashMs, commitMs, totalMs, srfBytes, shadowBytes }`;
  `rt.setSnapshotPage(fn)`; `rt.snapshotPause(why)`; `rt.snapshotDiscard(why)`; `stats().snapshot`. Terminal objects:
  `devnum`, `setScreenSource(fn)` (fn returns the terminal's Read Buffer image; default: the runtime's own screen model).

## Main-thread rules
The runtime calls only lock-free C exports from the page thread (`hw_term_*`, `hw_log_read`,
`hw_command`, `hw_stat`, `hw_phase`, `hw_load_*`) on an 8 ms timer. The DASD bytes are fetched
and written by the loader worker (`src/wasm/library_webload.js`); the page thread never sees them.
In a hidden tab the timer is throttled (1 s, later 1 min in Chromium): terminal output and the log
then wait in the wasm rings (64 KB per terminal, 512 KB log).

## Lazy DASD
`dasd/manifest.json` format 2 (made by `scripts/dasd-chunk.py`) switches the loader to lazy volumes.
Format 1 (`scripts/mk-dasd-chunks.sh`, all bytes before the IPL) still works.

Site layout: `dasd/manifest.json` + `dasd/c/<sha256>` (one file per distinct chunk, plus the gzip
metadata blob). A chunk = the compressed CCKD track images of a run of consecutive tracks (track order).
Null tracks are in no chunk. Default chunking: `--mode bootsplit --chunk-kib 128 --split-min 0`
(at most 128 KiB, and a new chunk at each change between boot-list and other tracks), 589 files, 58.7 MB.

How it works (C: `src/wasm/lazydasd.cpp`, worker JS: `src/wasm/library_lazydasd.js`):
- The loader pthread (a worker) loads the metadata blob (headers, L1, L2 of each volume; 209 KB gzip),
  registers the volumes and creates `/mvs/DASD/<volume>` as read-only WasmFS files (one custom WasmFS
  backend per volume, mode 0444). Then `impl()` starts. Hercules is not changed: CCKD opens the base
  read-only (the O_RDWR open fails with EACCES, ckddasd.c retries O_RDONLY because `sf=` is set).
- A Hercules thread that reads a track image whose chunk is not in the in-heap LRU (24 MiB) queues the
  chunk, rings the I/O worker (BroadcastChannel; 25 ms poll as fallback) and waits on a futex. The I/O
  worker takes Cache Storage (`mvs-dasd-c1`) first, else `fetch()` of the whole file (no Range
  requests), checks size and sha256 (= the file name), stores it in Cache Storage, copies it into the
  heap and wakes the waiters. Demand requests go first; the boot list (`manifest.boot.ready`, first-access
  order) is prefetched with 6 parallel requests (+2 for demand) from the start, while Hercules boots.
- The browser main thread only reads counters (`hw_lazy_statd`), never waits, never copies DASD bytes.

Options (`createRuntime({ lazy: {...} })`, or in page mode the URL `?dasd.<key>=<value>`):
`concurrency` (6), `extraDemand` (2), `budgetMiB` (24, in-heap LRU), `cache` (true), `cacheName`,
`prefetch` (`ready` | `ikt007i` | `none`), `prefetchWait` (false: the IPL does not wait for the boot
list), `prefetchAll` (false; test: prefetch every chunk, more than the LRU), `verify` (sha256, true).

Progress (page mode, `onProgress`): `{phase:'download', loaded, total, cached, lazy:true, detail}` with
`total` = boot working set bytes and `detail` 'boot working set' or 'loaded from cache'; after the loader
phase `{phase:'dasd', loaded, total, cached, detail}` until the boot list is in. `stats().lazy`: `bootTotal`,
`bootLoaded`, `netBytes`, `cacheBytes`, `netReq`, `cacheReq`, `demandWaits`, `waitMs`, `maxWaitMs`,
`demandNonBoot`, `lruUsed`, `lruPeak`, `evictions`, `refetch`, `gapBytes` (reads outside any extent; 0 expected),
`errors`, `tracksRead`, `prefetchDone`. `globalThis.__mvsRuntime.lazyTrace()` = the first read of each
track in order (`'0150,123'`, input for a new boot list: `dasd-chunk.py --boot a.csv,b.csv`).

Seam for persistent shadows: the base volumes are `/mvs/DASD/*` (lazy backend, read-only,
never written). The shadow files are on a separate mount: without persistence `sf=shadow/<vol>_*.cckd` (cwd
`/mvs`) = `/mvs/shadow`, a memory directory made by the loader (`dirs`); with the OPFS backend
(mounted by `wasm_main --opfs=/opfs`) `sf=/opfs/shadow/<vol>_*.cckd`. Either works with the lazy base: CCKD
reads a track from the shadow if the shadow has it, else from the base (lazy chunk). A shadow is only valid
on top of the same base image: keep `manifest.volumes[].sha256` (whole-file sha256 of the base image) with the
shadows and reset them when it changes (for example after an image change such as the LCL400 trim). The base
chunk cache (Cache Storage) is read-only and content-addressed, so tabs can share it without the Web Lock.
