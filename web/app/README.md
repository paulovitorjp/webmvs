# web/app: the visitor page

Static page: loader, then two interactive tabs, **Console** (MVS master console, device 0010) and
**TSO** (3270 from the 0400 pool). The page shows the IPL on Console, answers `IEA101A` on 0010,
sets roll mode, and switches to TSO when `IKT007I` appears. `+` opens more TSO sessions (0401...).
The Hercules log and command line exist only with `?debug=1`.

## Build
```
cd web/app && npm install          # esbuild 0.28.2, playwright 1.56.1 (tests only)
node build.mjs                     # -> dist/ (index.html, app.js, app.css, 3270.bdf, coi-serviceworker.js, _headers, licenses)
node build.mjs --dev               # + dist/mock/mock-runtime.js (dev stand-in for the wasm runtime)
```
`@tn3270/core` is bundled from `web/vendor/tn3270` (pinned, see docs/PINS.md); `@tn3270/frontend`
is aliased to `src/frontend-browser.ts` (the real barrel pulls in `node:tls`). The upstream canvas
`renderer.ts` is a singleton (one `#screen`, one `window.tn3270`), so `src/termview.ts` uses the
upstream `drawList`/`blit`/BDF atlas once per tab instead. Type check: `npx -p typescript@5.9 tsc -p tsconfig.json`
(only 2 vendor errors: `process` in an unreachable `session.ts` branch).

## Files
| File | What |
|---|---|
| `index.html`, `app.css` | layout: loader, header with tabs, terminal views, hint line, keypad, debug pane, About dialog (credits, Shut down) |
| `src/main.ts` | boot flow, tabs, keyboard routing, soft-keyboard capture, debug pane, test hooks (`window.mvs`) |
| `src/termview.ts` | one tn3270 `Session` + canvas per tab, integer-scale blit + CSS fit, `typeCommand()` |
| `src/operator.ts` | 0010 automation: IEA101A reply, roll mode, IKT007I, $HASP426 fallback, shutdown sequence |
| `src/keys.ts` | keyboard map and keypad keys |
| `src/machine.ts` | backends: `NativeDevMachine` (websockify + dev server), `WasmMachine` (runtime contract) |
| `src/transport.ts` | `RawTerminal` contract, WebSocket transport, adapter to the tn3270 `Connection` |
| `devserver.py` | dev static server + `/dev/` API (status, log, cmd, quit); `--coi-headers` adds COOP/COEP/CORP |
| `dev/mock-runtime.js` | the runtime contract implemented over websockify (tests `?backend=wasm`) |
| `e2e.mjs`, `probe3.mjs` | Playwright tests (host: `scripts/ui-e2e.sh`, `scripts/ui-probe.sh`) |

## Query parameters
`backend=wasm|native` (default wasm; native = dev Hercules through websockify), `ws=` (native websockify URL, default `ws://<host>:8213/`),
`runtime=` (wasm runtime module URL, default `./runtime/mvs-runtime.js`), `debug=1`, `console=late`
(fallback mode, see below), `noipl=1`, `switchdelay=` (ms after IKT007I is on the 0010 screen before the page selects the
TSO tab, default 1500), `switchmax=` (upper bound after TSO ready, default 20000), `oia=0` (hide the 3270 status line),
`persist=0` (do not keep the machine in this browser), `savingms=` (show "Saving…" when data stays unsaved
this long, default 400), `autoreset=1`
(tests: accept the automatic "Reset machine" offer after a failed IPL), `typeahead=0` and `pwresend=0` (turn off
the keyboard typeahead and the password nudge below, for comparisons; `pwresendms=` the wait, default 1500), `kbdhold=0`
(no keyboard hold after a Query, below; `kbdholdms=` its limit, default 1000).

## Persistence
The machine is kept in this browser (CCKD shadow files on OPFS, see `web/runtime/README.md` "Persistence").
Header buttons: **Shut down** (the shutdown sequence below; after Hercules has quit the page calls
`markClean()`) and **Reset machine** (enabled only while Hercules is stopped; a dialog asks first; the page
then reloads and the new load deletes the saved disks before Hercules starts). A second tab of the same
origin shows "MVS is running in another tab" (Web Lock) with "Try again". If an IPL fails (state `iplfail`,
or Hercules does not start) the page offers "Reset machine" in a dialog, and says when the last session
was not shut down. Test hooks: `window.mvs.persist()`, `window.mvs.shadows()`, `window.mvs.shadowB64(name)`.

Console lines and idle logoff: `window.mvs.seen()` is a window of the newest distinct 0010
lines (at most about 4,500; `operator.ts` `SEEN_MAX`), `window.mvs.seenTotal()` counts all lines since the IPL and
`window.mvs.seenSince(n)` returns the lines from absolute index `n` on. When MVS logs a TSO user off after 30 minutes
without input (`IEF450I <user> ... ABEND S522`), every TSO tab shows a notice in the hint line until the next key on
that tab (`window.mvs.tsoLogoffs()`).

Save state: after the IPL the header shows **Saving…** while changed disk data stays unsaved
longer than `savingms` (default 400 ms), then **Saved** for 2.5 s. The page asks the runtime for an immediate CCKD
flush (`rt.flushNow`) as soon as it sees unsaved data, when the page is hidden and at pagehide; a reload or close
while data is unsaved gets the browser's "Leave page?" prompt (beforeunload, only then). Test hook
`window.mvs.saving()` (state, prompts, flush requests, dirty windows in ms, per-device samples).

The TSO terminal connects at the first IKT007I (Hercules log), but the TSO tab is selected
only `switchdelay` ms after IKT007I is visible on the Console tab, so the visitor sees the end of the IPL there.
Under each screen the page draws a 3270-style OIA (separator line; `4` in reverse video, `A` underlined = 3270 mode;
`X SYSTEM`/`X Wait`/... at column 9; `^` = insert; cursor `rrr/ccc` on the right); test hook `window.mvs.oia(tab)`.
`index.html` sets `window.coi.doReload` so coi-serviceworker reloads only after its worker is active (one reload).

## Snapshot: the machine continues after the tab is closed
The runtime saves the running machine in this browser (memory + disks; `web/runtime/README.md` "Snapshot"). When a
load has a usable snapshot, the page does not IPL: it connects the console (0010) and one TSO tab per TSO device of the
snapshot (`IBM-3278-2-E@0400`, ...) BEFORE the resume, puts the saved console lines back, calls the runtime's resume,
selects the tab that was active, and shows **Resumed your saved machine (saved <time>)**. The TSO session goes on
(after a gap longer than the MVS job wait time, 30 min, MVS logs the user off with S522; the page shows its notice).
- **History** (header): the console lines of this machine, also from before the resume (the restored 0010 screen shows
  only the last ones). Test hook `window.mvs.history()`.
- **Start fresh (IPL)** (header, after a resume): discard the snapshot, reload, IPL (the disks stay). Shut down also
  discards it; Reset machine removes it.
- If the resume fails (watchdog), the status line says so and the page reloads; that load IPLs.
- Test hooks: `window.mvs.snapshot()` (`{ page, rt }`), `window.mvs.checkpoint(why)`; `mvsState` `'resuming'`, then `'tso'`
  (or `'resumefail'`). `?snap=0` off, `?resume=0` IPL but keep saving, `?snap.<key>=<value>` (runtime options).
- Each TSO view gives the runtime its screen as a Read Buffer image (`TermView.readBufferImage()`, `setScreenSource`).

## Keyboard input while the host holds the keyboard, and the lost TSO password
- **Typeahead** (`src/termview.ts`, like x3270 `enq_ta`): keys pressed while the host holds the keyboard (`X SYSTEM`
  after an AID, the enter-inhibit after a Query reply, the wait for the first write) are kept in order and played back
  when the host unlocks the keyboard; an AID in the queue locks it again and the rest waits. Reset drops the queue.
  Before, the vendored `Keyboard` refused (dropped) every such character, while `Session.sendAID()` still sent an
  Enter typed at the same time, with a Read Modified that lacked the dropped characters.
- **Password nudge**: MVS 3.8 TSO sometimes takes the password line as typeahead (its answer is a bare
  keyboard-unlock Write: WCC restore, only SBA/SF/IC) and the logon does not read it (the prompt stays); TSO keeps the
  line queued for its next read. When an Enter carried a modified non-display field, the first host answer is that bare
  write, nothing else comes for 1.5 s, the visitor types nothing and the screen still asks for a PASSWORD, the view sends
  one Enter without a modified field: the logon then gets the queued password, the empty line goes to the first TSO
  read after it. (`?pwresend=resend`, tests only: send the password again; the queued copy then runs as a TSO command
  and shows the password: `COMMAND PASS4U NOT FOUND`.)
- **Keyboard hold after a Query**:
  after `LOGON <user>` TSO sends a Read Partition Query and then the password prompt in two records: an Erase/Write
  without keyboard restore (the text) and a Write with restore that defines the non-display field and moves the cursor
  there. The vendored core (like x3270) unlocks the keyboard at the first one; a key typed between the two (the
  runtime drains the ring every 8 ms) went to the old cursor position and was then overwritten: the password reached
  MVS without its first character (`PASSWORD NOT AUTHORIZED`). Now a write that ends the enter-inhibit without a
  keyboard restore keeps the keyboard held until a write with restore (at most the limit); keys typed meanwhile wait in
  the typeahead queue. Unit test: `node web/app/test/kbdhold-unit.mjs` (replays the records of the failed logon).
- Test hooks: `window.mvs.kbdlog(tab)` (the last 400 keyboard and data-stream events of a tab: host records with
  command, WCC, length, keyboard state and the first 24 bytes; sent records with AID, cursor and first SBA, never the
  field data), `window.mvs.typeahead(tab)` (counters: queued, replayed, refusedChars, aidWhileLocked, pwBareUnlock,
  pwResends, holds, holdTimeouts), `window.mvs.fields(tab)` (unprotected fields: attribute address, length, hidden, MDT, how many cells
  hold a character; no contents).

## Keyboard
Enter = Enter, Esc = Clear, F1-F12 = PF1-12, Shift+F1-F12 (or F13-F24) = PF13-24, Ctrl+1/2/3 (or Alt+1/2/3) = PA1-3,
Ctrl+R = Reset, End = Erase EOF, Ctrl+U = Erase Input, Tab/Shift+Tab, arrows, Home, Backspace, Delete, Insert.
Paste types the first line of the clipboard. Keypad (Keys button; shown by default on touch devices): Enter, Clear,
PA1-3, Reset, Tab, BkTab, ErEOF, Home, arrows, PF1-24. On touch devices, Kbd focuses a hidden textarea for the soft keyboard.

## Dev bundle
`scripts/mk-dist-dev.sh` builds this page and puts it together with
`web/runtime/mvs-runtime.js`, the wasm build, the boot files and the DASD chunks into `web/dist-dev/` (layout in the
script). Serve it with `node scripts/pages-emu.mjs` (see the root README);
test it with `scripts/e2e.mjs`. Test hooks added for that: `window.mvs.herclog()` (Hercules log lines with arrival
time), `window.mvs.stats()` (runtime `stats()`), `window.mvs.backend()`.

## Integration contract (wasm runtime)
The runtime is an ES module (default URL `./runtime/mvs-runtime.js`):
```ts
export function createRuntime(opts: {
  onProgress(p: { phase: 'download' | 'prepare' | 'start'; loaded?: number; total?: number; detail?: string }): void;
  debug: boolean;
}): Promise<WasmRuntime>;

interface WasmRuntime {
  openTerminal(): RawTerminal | Promise<RawTerminal>;   // hw_term_open("") + output drain
  ipl(): void | Promise<void>;                          // hw_panel_command("ipl 150"), or no-op if the rc IPLs
  command(cmd: string): void | Promise<void>;           // hw_panel_command(cmd); 'quit' powers off
  onLog?(cb: (line: string) => void): void;             // Hercules log lines ("hh:mm:ss <msg>" like the native log)
}
interface RawTerminal {
  write(bytes: Uint8Array): void;                       // -> hw_term_input (queue the rest if short; never block)
  onData(cb: (bytes: Uint8Array) => void): void;        // <- hw_term_read; pass a COPY (slice), not a SAB view
  onClose?(cb: () => void): void;                       // hw_term_read returned -2 (Hercules closed)
  close(): void;                                        // hw_term_close; idempotent
}
```
Rules:
1. `createRuntime()` resolves when `openTerminal()` works (Hercules `impl()` started, CNSLPORT listener registered, or
   wasmsock's pre-listen pending slot available). It must NOT have started the IPL yet unless `ipl()` is a no-op.
2. The page calls, in order: `openTerminal()` for the console, completes the telnet negotiation with TTYPE
   `IBM-3278-2-E@0010` (console.c `negotiate_ttype`: `@` + hex = device number), waits for the first screen
   (the HERCLOGO logo on 0010, up to 15 s), then calls `ipl()`. TSO terminals use TTYPE `IBM-3278-2-E` (the pool
   gives 0400, 0401, ...). The terminal byte stream is the full telnet stream (TN3270E off).
3. The page needs `crossOriginIsolated` for the wasm backend (it stops with an error otherwise). `index.html` loads
   `coi-serviceworker.js` first; the page waits up to 4 s for its one-time reload before it opens any terminal
   (otherwise the first console connection is cut mid-negotiation: seen as `HHC02908E` in an early run).
4. `onLog` is used for: the debug pane, the IKT007I fallback (5 s after the log shows it, if 0010 did not), and the
   shutdown (`HHC00809I ... disabled wait state 000A0000 00000CCC`, then `command('quit')`; without a log the page
   waits 20 s).
5. The rc file keeps the two HAO rules (`hao tgt input for console 0:0009` = fallback IEA101A reply if 0010 is not the
   NIP console; `$HASP426` reply, which still fires with 0010 as master because the message also reaches the log).
6. DASD: each file must be <= 25 MiB (Cloudflare Pages limit). Of the 7-volume set only `syscpk.3350` (28,817,574 bytes)
   is larger; split it (for example 2 chunks) and join it in the worker before `impl()`. Report bytes through `onProgress`.

## Console decision and fallback
Default (`console=early`): 0010 is connected before the IPL, so it is the NIP console; the page answers IEA101A with
Enter, sends `K S,DEL=R,RNUM=19,RTME=1` when the MVS console format appears (otherwise the screen holds at
`IEE159E MESSAGE WAITING` and IKT007I is never shown), and detects IKT007I on 0010. Shutdown (About > Shut down MVS)
is typed on 0010: `$CA,ALL`, `SWITCH SMF`, `F TSO,USERMAX=0`, `$PI`, `$P` devices, `P TSO` (IKT006I; IKT010D -> FSTOP),
`Z NET,QUICK` (IST102I), `$HASP099`, `$PJES2` ($HASP085), `Z EOD` (IEE334I), `QUIESCE`, then Hercules `quit`.
Reason: the 3215 at 009 cannot do it while 0010 is master (`V ...` gives `IEE345I AUTHORITY INVALID` on 009).

Fallback (`console=late`, tested, not the default): 009 MVS messages from the Hercules log are shown as text on the
Console tab during NIP (HAO answers IEA101A on 009), then 0010 is attached at IKT007I with `/V 010,CONSOLE`. In this
mode 009 stays master, so the 0010 shutdown sequence would fail; use `script conf/web-shutdown.rc` instead.

## IPL automation: IEA305A
The page answers `IEA101A SPECIFY SYSTEM PARAMETERS` on 0010 with a plain Enter. A key that the visitor typed on the
Console tab during NIP went out with that Enter, MVS answered `IEA305A INVALID REPLY FORMAT - RESPECIFY`, and the IPL
waited until the 180 s reset offer. Now each new IEA305A after the page's reply gets one more plain Enter (at most 3;
`operator.ts`). Erase EOF or Erase Input before the Enter do not work on this console: MVS answers IEA305A to an empty
modified field. Test: an internal (unpublished) test script.

