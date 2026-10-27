// SPDX-License-Identifier: Apache-2.0
/**
 * MVS 3.8J visitor page.
 *
 * Flow: loader (download / prepare) -> Console tab (0010 master console, connected BEFORE the IPL)
 * -> IPL -> the page answers IEA101A on 0010 -> roll mode -> IKT007I -> TSO tab opens (0400 pool)
 * and is selected. The Hercules log and command line exist only with ?debug=1.
 *
 * Query parameters:
 *   backend=wasm|native   (default wasm: Hercules in this page; native = dev Hercules via websockify)
 *   ws=<url>              native: websockify URL (default ws://<page host>:8213/)
 *   runtime=<url>         wasm: runtime ES module (default ./runtime/mvs-runtime.js)
 *   debug=1               Hercules log + command pane
 *   console=early|late    early (default): 0010 before IPL; late: fallback (009 log text during NIP,
 *                         then 0010 attached with V 010,CONSOLE after IKT007I)
 *   noipl=1               do not start the IPL (tests / when the rc file IPLs)
 *   switchdelay=<ms>      Console -> TSO auto-switch this long after IKT007I shows on 0010 (default 1500)
 *   switchmax=<ms>        ... but at most this long after TSO is ready (log IKT007I; default 20000)
 *   oia=0                 hide the 3270 status line (OIA) under the screens
 *   persist=0             do not keep the machine in this browser (memory shadows)
 *   savingms=<ms>         show "Saving..." when data stays unsaved this long (default 400)
 *   autoreset=1           tests: accept the automatic "Reset machine" offer after a failed IPL
 *
 * the machine is kept in this browser (CCKD shadow files on OPFS). Only one tab
 * runs it (Web Lock 'mvs-machine': a second tab shows "MVS is running in another tab"). "Shut down"
 * quiesces MVS and marks the disks clean; "Reset machine" (only while Hercules is stopped) deletes
 * the saved disks. A load after a session that was not shut down is a dirty start; if its IPL then
 * fails, the page offers "Reset machine" automatically.
 */
import { loadAtlas, TermView, type Atlas } from './termview.js';
import { toConnection, type RawTerminal } from './transport.js';
import { LockedError, NativeDevMachine, WasmMachine, type Machine, type Progress, type SnapshotPlan } from './machine.js';
import { ConsoleOperator } from './operator.js';
import { actionForKey, PAD_MAIN, PAD_PF } from './keys.js';
import type { Action } from '@tn3270/frontend';

const q = new URLSearchParams(location.search);
const DEBUG = q.get('debug') === '1';
const BACKEND = q.get('backend') ?? 'wasm';
const CONSOLE_MODE = q.get('console') === 'late' ? 'late' : 'early';
const PERSIST = q.get('persist') !== '0';
const AUTORESET = q.get('autoreset') === '1';
const TTYPE = 'IBM-3278-2-E';            // 3278 model 2, 24x80, extended data stream (as s3270 / scripts/tso-smoke.sh)
const CONSOLE_TTYPE = `${TTYPE}@0010`;   // console.c: '@' suffix = device number (negotiate_ttype)
// Auto-switch to TSO: TSO is connected at the first IKT007I
// (Hercules log, about 3.3 s after the IPL in Chromium), but the tab changes only SWITCH_DELAY ms after
// IKT007I is visible on the 0010 screen (roll mode shows it 3-6 s after the log), so the visitor sees the
// IPL end on the Console tab. SWITCH_MAX: upper bound after TSO ready, if 0010 never shows it.
const SWITCH_DELAY = Number(q.get('switchdelay') ?? 1500);
const SWITCH_MAX = Number(q.get('switchmax') ?? 20000);

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const logLines: string[] = [];
/** Hercules log lines with their arrival time (performance.now()); kept for tests, shown only with ?debug=1. */
const hercLines: [number, string][] = [];
function dlog(s: string): void {
  logLines.push(s);
  if (logLines.length > 5000) logLines.splice(0, 1000);
  if (DEBUG) appendLog(s);
  console.debug(s);
}

// ------------------------------------------------------------------ machine
const machine: Machine = BACKEND === 'wasm'
  ? new WasmMachine(q.get('runtime') ?? new URL('./runtime/mvs-runtime.js', location.href).href, DEBUG, PERSIST)
  : new NativeDevMachine(q.get('ws') ?? `ws://${location.hostname}:8213/`);

// ------------------------------------------------------------------ tabs
interface Tab { id: string; label: string; view?: TermView; el: HTMLElement; button: HTMLButtonElement; hint: string; notice?: string; raw?: RawTerminal }
const tabs = new Map<string, Tab>();
let active = 'console';
let userPicked = false;

function makeTab(id: string, label: string, hint: string): Tab {
  const el = document.createElement('div');
  el.className = 'view'; el.id = `view-${id}`; el.hidden = true;
  $('views').appendChild(el);
  const button = document.createElement('button');
  button.className = 'tab'; button.textContent = label; button.dataset.tab = id;
  button.setAttribute('role', 'tab');
  button.addEventListener('click', () => { userPicked = true; select(id); });
  button.addEventListener('pointerup', () => button.blur());
  $('tabs').insertBefore(button, $('add-tso'));
  const t: Tab = { id, label, el, button, hint };
  tabs.set(id, t);
  return t;
}

function select(id: string): void {
  active = id;
  for (const t of tabs.values()) {
    const on = t.id === id;
    t.el.hidden = !on;
    t.button.classList.toggle('active', on);
    t.button.setAttribute('aria-selected', String(on));
  }
  const t = tabs.get(id);
  renderHint(t);
  t?.view?.paint();
  focusTerminal();
}
/** shown once after a new image replaced the saved changes of system volumes (see setupPersist / persist.upgrade) */
const UPDATE_NOTICE = 'webmvs was updated; system changes you saved were replaced (your data sets are kept).';
function renderHint(t: Tab | undefined): void {
  $('hint').innerHTML = (t?.notice ? `<span class="notice">${t.notice}</span> ` : '') + (t?.hint ?? '');
}

/**
 * After 30 minutes without input MVS logs a TSO user off (SMFPRM00 JWT=30: IEF450I <user> ...
 * ABEND S522). The TSO tab then shows the logon screen, and the reason was only on the Console tab. Say it on
 * every TSO tab (the message names the user, not the terminal) until the visitor presses a key there.
 */
const tsoLogoffs: { user: string; at: number; line: string }[] = [];
const tsoLogoffKeys = new Set<string>();
function tsoTimedOut(user: string, line: string): void {
  // The same message comes back as another distinct screen line when its prefix changes ('00- IEF450I' while it is
  // the newest line, '  - IEF450I' later): count it once (the key is the text from IEF450I on, with its TIME=).
  const key = line.slice(line.indexOf('IEF450I')).trim();
  if (tsoLogoffKeys.has(key)) return;
  tsoLogoffKeys.add(key);
  if (tsoLogoffKeys.size > 200) tsoLogoffKeys.clear();
  tsoLogoffs.push({ user, at: Math.round(performance.now()), line: line.trim() });
  if (tsoLogoffs.length > 50) tsoLogoffs.shift();
  const msg = `MVS logged <b>${user}</b> off after 30 minutes without input (ABEND S522). Press <kbd>Enter</kbd> and log on again.`;
  for (const t of tabs.values()) if (t.id.startsWith('tso')) t.notice = msg;
  dlog(`[tso] ${user} logged off by MVS after 30 minutes without input (S522)`);
  renderHint(tabs.get(active));
}

function placeholder(t: Tab, html: string): void {
  let p = t.el.querySelector<HTMLElement>('.placeholder');
  if (!p) { p = document.createElement('div'); p.className = 'placeholder'; t.el.appendChild(p); }
  p.innerHTML = html;
  p.hidden = html === '';
}

// ------------------------------------------------------------------ status line
const ipl = { started: 0, tso: 0, consoleIkt: 0, switched: 0, switchReason: '' };
function status(s: string): void { const e = $('ipl-status'); e.textContent = s; e.title = s; dlog(`[status] ${s}`); }

// ------------------------------------------------------------------ loader
function loader(text: string, frac?: number): void {
  $('loader-text').textContent = text;
  const bar = $('loader-bar');
  if (frac === undefined) bar.classList.add('indeterminate');
  else { bar.classList.remove('indeterminate'); bar.style.width = `${Math.round(frac * 100)}%`; }
}
function fmtMB(n: number): string { return (n / 1048576).toFixed(1); }
function onProgress(p: Progress): void {
  if (p.phase === 'dasd') { dasdStatus(p); return; }
  if (p.phase === 'download') {
    const t = p.total ? ` / ${fmtMB(p.total)} MB` : ' MB';
    loader(`Downloading system: ${fmtMB(p.loaded ?? 0)}${t}${p.detail ? ` (${p.detail})` : ''}`, p.total ? (p.loaded ?? 0) / p.total : undefined);
  } else if (p.phase === 'prepare') loader(`Preparing volumes${p.detail ? `: ${p.detail}` : ''}`);
  else loader(`Starting Hercules${p.detail ? ` (${p.detail})` : ''}`);
}
// Lazy DASD: the IPL starts while the rest of the boot working set still loads; show it in the header.
let dasdHide = 0;
function dasdStatus(p: Progress): void {
  const e = document.getElementById('dasd-status');
  if (!e) return;
  const t = p.total ? ` / ${fmtMB(p.total)} MB` : ' MB';
  e.textContent = p.done ? `System ${fmtMB(p.total ?? p.loaded ?? 0)} MB ${p.detail ?? 'loaded'}` : `System: ${fmtMB(p.loaded ?? 0)}${t}`;
  e.hidden = false;
  clearTimeout(dasdHide);
  if (p.done) dasdHide = window.setTimeout(() => { e.hidden = true; }, 5000);
}

// ------------------------------------------------------------------ terminals
let atlas: Atlas;
function newView(t: Tab, ttype: string): TermView {
  const v = new TermView(t.el, atlas, { terminalType: ttype, connect: async () => {
    const raw = await machine.openTerminal();
    t.raw = raw;
    raw.setScreenSource?.(() => v.readBufferImage());     // the screen is saved with each snapshot
    return toConnection(raw);
  } });
  t.view = v;
  // Soft keyboard: mobile browsers open it only for a focus() inside the tap's own gesture, and the
  // compatibility mousedown that follows a tap moves the focus to <body> (keyboard slides down) unless
  // it is cancelled. Mouse: focus on pointerdown. Touch/pen: focus on pointerup (the end of the tap).
  v.canvas.addEventListener('mousedown', (e) => e.preventDefault());
  v.canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') focusTerminal(true); });
  v.canvas.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') focusTerminal(true); });
  v.canvas.addEventListener('click', () => { if (document.activeElement !== capture()) focusTerminal(true); });
  v.session.on('disconnect', () => dlog(`[${t.id}] disconnected`));
  v.session.on('connect', () => dlog(`[${t.id}] connected as ${ttype}`));
  return v;
}

let tsoCount = 0;
function addTso(): Tab {
  tsoCount++;
  const id = `tso${tsoCount}`;
  const hint = tsoCount === 1
    ? 'TSO: press <kbd>Enter</kbd>, then type <b>LOGON MVSCE02</b> and <kbd>Enter</kbd>. Password: <b>PASS4U</b>. At <b>READY</b>, <b>KICKS</b> starts KICKS for TSO, <b>CARDDEMO</b> the CardDemo application. End with <b>LOGOFF</b>.'
    : `TSO session ${tsoCount}: one user ID can be logged on only once. Use <b>MVSCE01</b> / <b>CUL8TR</b> here if MVSCE02 is in use.`;
  const t = makeTab(id, tsoCount === 1 ? 'TSO' : `TSO ${tsoCount}`, hint);
  return t;
}

async function connectTso(t: Tab): Promise<void> {
  if (t.view) return;
  placeholder(t, '');
  const v = newView(t, TTYPE);
  try { await v.connect(); } catch (e) { placeholder(t, `Could not connect: ${String(e)}`); throw e; }
}

// ------------------------------------------------------------------ keyboard
const capture = (): HTMLTextAreaElement => $<HTMLTextAreaElement>('kbd-capture');
function focusTerminal(soft = false): void {
  if (document.activeElement && (document.activeElement as HTMLElement).closest?.('#debug, dialog')) return;
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (coarse && !soft) return;            // do not pop up the soft keyboard unasked
  capture().focus({ preventScroll: true });
}
function act(a: Action): void {
  const t = tabs.get(active), v = t?.view;
  if (!v) return;
  if (t.notice) { t.notice = undefined; renderHint(t); }
  v.action(a);
}
document.addEventListener('keydown', (e) => {
  const tgt = e.target as HTMLElement;
  if (tgt.closest('#debug, dialog, input:not(#kbd-capture)')) return;
  const a = actionForKey(e);
  if (!a) return;
  e.preventDefault();
  act(a);
});
// Soft keyboards (Android: keydown key === 'Unidentified') deliver text through input events.
// The capture box keeps one placeholder character so a soft-keyboard backspace on an "empty" box still
// produces an input event (deleteContentBackward); Enter arrives as insertLineBreak / a newline.
const PAD_CHAR = ' ';
function wireCapture(): void {
  const c = capture();
  const resetBox = (): void => { c.value = PAD_CHAR; c.setSelectionRange(1, 1); };
  resetBox();
  c.addEventListener('focus', resetBox);
  c.addEventListener('beforeinput', (e) => {
    const t = e.inputType;
    if (t === 'insertLineBreak' || t === 'insertParagraph') { e.preventDefault(); act({ kind: 'enter' }); resetBox(); }
    else if (t === 'deleteContentBackward') { e.preventDefault(); act({ kind: 'backspace' }); resetBox(); }
    else if (t === 'deleteContentForward') { e.preventDefault(); act({ kind: 'delete' }); resetBox(); }
  });
  c.addEventListener('input', () => {
    let s = c.value;
    if (s.startsWith(PAD_CHAR)) s = s.slice(PAD_CHAR.length);
    const parts = s.split(/\r?\n/);
    resetBox();
    parts.forEach((p, i) => { if (i > 0) act({ kind: 'enter' }); if (p) act({ kind: 'type', text: p }); });
  });
  document.addEventListener('paste', (e) => {
    const tgt = e.target as HTMLElement;
    if (tgt.closest('#debug, dialog')) return;
    const s = e.clipboardData?.getData('text/plain') ?? '';
    if (!s) return;
    e.preventDefault();
    act({ kind: 'type', text: s.split(/\r?\n/)[0]! });
  });
}

function buildKeypad(): void {
  const pad = $('keypad');
  const row = (keys: typeof PAD_MAIN, cls: string): void => {
    const r = document.createElement('div'); r.className = `padrow ${cls}`;
    for (const k of keys) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = k.label; b.dataset.label = k.label;
      if (k.wide) b.classList.add('wide');
      // pointerdown + preventDefault keeps the focus (and the soft keyboard) where it is.
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); act(k.action); });
      b.addEventListener('click', (e) => { if (e.detail === 0) act(k.action); });   // keyboard activation
      r.appendChild(b);
    }
    pad.appendChild(r);
  };
  row(PAD_MAIN, 'main');
  row(PAD_PF.slice(0, 12), 'pf');
  row(PAD_PF.slice(12), 'pf');
  const coarse = matchMedia('(pointer: coarse)').matches;
  pad.hidden = !coarse;
  $('keys-btn').addEventListener('click', () => { pad.hidden = !pad.hidden; for (const t of tabs.values()) t.view?.paint(); });
  $('kbd-btn').addEventListener('click', () => focusTerminal(true));
}

// ------------------------------------------------------------------ debug pane
function appendLog(s: string): void {
  const pre = $('herclog');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.append(`${s}\n`);
  while (pre.childNodes.length > 4000) pre.removeChild(pre.firstChild!);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}
/** ?debug=1 state line: wasm heap (sbrk high-water vs memory size), log drops, terminal states, crash. */
function debugState(): void {
  const st = machine.stats?.() as { sbrk?: number; sbrkPeak?: number; heapUsed?: number; memoryBytes?: number; logDropped?: number; threads?: number; crashed?: unknown } | null;
  const mb = (n?: number): string => (n == null ? '?' : (n / 1048576).toFixed(1));
  const term = [...tabs.values()].filter((t) => t.view).map((t) => `${t.id}:${t.view!.unlocked() ? 'U' : 'L'}`).join(' ');
  const parts = [
    st ? `heap ${mb(st.sbrk)}/${mb(st.memoryBytes)} MB (peak ${mb(st.sbrkPeak)}, in use ${mb(st.heapUsed)})` : 'heap ?',
    st ? `log drop ${st.logDropped ?? 0}` : '', st?.threads != null ? `threads ${st.threads}` : '',
    `terminals ${term || '-'}`, crashInfo ? `CRASHED: ${crashInfo.line.slice(0, 80)}` : '',
  ];
  $('dbgstat').textContent = parts.filter(Boolean).join('  |  ');
}
function setupDebug(): void {
  if (!DEBUG) return;
  $('debug').hidden = false;
  window.setInterval(debugState, 2000);
  $('hcmd-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const i = $<HTMLInputElement>('hcmd');
    const c = i.value.trim(); i.value = '';
    if (c) { dlog(`[herc cmd] ${c}`); void machine.command(c).catch((err) => dlog(`[herc cmd] failed: ${String(err)}`)); }
  });
}

// ------------------------------------------------------------------ about / shutdown
let operator: ConsoleOperator | undefined;
let disabledWaitSeen = false;
function setupAbout(): void {
  const d = $<HTMLDialogElement>('about');
  $('about-btn').addEventListener('click', () => d.showModal());
  $('about-close').addEventListener('click', () => d.close());
  $('shutdown-btn').addEventListener('click', () => { d.close(); void shutdown(); });
}
async function shutdown(): Promise<void> {
  if (!operator || operator.shuttingDown || herculesStopped) return;
  (document.activeElement as HTMLElement | null)?.blur?.();
  userPicked = true; select('console');
  setButtons('shutting');
  status('Shutting down MVS on the master console ...');
  // no checkpoint of a machine that is shutting down, and no resume of it later (also if the shutdown stops
  // half way: VTAM or JES2 may be down already; the next load IPLs)
  machine.snapshot?.pause('shutdown');
  void machine.snapshot?.discard('shut down');
  try {
    await operator.shutdown();
    status('QUIESCE: waiting for the disabled wait ...');
    const end = performance.now() + 20000;
    while (performance.now() < end && !disabledWaitSeen) await new Promise((r) => setTimeout(r, 300));
    await new Promise((r) => setTimeout(r, 1500));
    await machine.powerOff();
    const p = machine.persist;
    if (p) {
      const ok = await p.waitStopped(30000);
      if (ok) p.markClean();
      herculesStopped = ok;
      persistState.cleanShutdown = ok;
    } else herculesStopped = true;
    status(p?.info()?.enabled
      ? 'MVS is shut down. Disks saved in this browser. Reload to IPL again.'
      : 'MVS is shut down. Reload to IPL again.');
    setButtons('stopped');
    (window as unknown as { mvsState: string }).mvsState = 'off';
  } catch (e) { status(`Shutdown problem: ${String(e)}`); setButtons('running'); }
}

// ------------------------------------------------------------------ crash
/**
 * A Hercules thread trapped or aborted (wasm "unreachable", e.g. Aborted(OOM)). That thread is gone, often
 * with a lock held, so MVS and the terminals stop for good. Say so, instead of leaving the terminals at
 * X SYSTEM: status line, a dialog with Reload, and every terminal disconnected (OIA "X Disconnected").
 */
let crashInfo: { at: number; line: string } | undefined;
function crashed(line: string): void {
  if (crashInfo) { if (/Aborted\(OOM\)/.test(line)) crashInfo.line = line; return; }
  crashInfo = { at: performance.now(), line };
  window.setTimeout(() => {               // the "Aborted(...)" and "worker sent an error" lines come together
    const why = /Aborted\(OOM\)/.test(crashInfo!.line) ? 'the emulator ran out of memory' : 'an internal error in the emulator';
    dlog(`[crash] ${crashInfo!.line}`);
    status(`MVS has stopped: ${why}. Reload the page to start again.`);
    $('crash-text').textContent = `Hercules stopped: ${why} (${crashInfo!.line.slice(0, 160)}). MVS and the terminals do not respond any more. `
      + (machine.persist?.info()?.enabled ? 'Reload the page to start again (your saved disks are used again; changes from the last seconds can be lost).'
        : 'Reload the page to start again.');
    const d = $<HTMLDialogElement>('crash-dialog');
    $('crash-reload').onclick = () => location.reload();
    $('crash-close').onclick = () => d.close();
    if (!d.open) d.showModal();
    for (const t of tabs.values()) { try { t.view?.session.disconnect(); } catch { /* already closed */ } }
    herculesStopped = true;
    setButtons('stopped');
    (window as unknown as { mvsState: string }).mvsState = 'crashed';
  }, 200);
}

// ------------------------------------------------------------------ persistence
let herculesStopped = false;
const persistState = { resetOffered: '' as string, resetAccepted: false, cleanShutdown: false, lockedScreen: false };
function setButtons(mode: 'running' | 'shutting' | 'stopped' | 'off'): void {
  const sd = $<HTMLButtonElement>('shutdown-top'), rs = $<HTMLButtonElement>('reset-btn');
  const persisted = !!machine.persist?.info()?.enabled;
  sd.hidden = mode === 'off'; sd.disabled = mode !== 'running';
  rs.hidden = !persisted; rs.disabled = mode !== 'stopped';
  rs.title = mode === 'stopped' ? 'Delete the saved disks and start again from the original MVS/CE system'
    : 'Shut down first: the disks can only be reset while the machine is stopped';
}
function doReset(why: string): void {
  persistState.resetAccepted = true;
  machine.persist?.requestReset(why);
  status('Resetting the machine: the page reloads and starts from the original disks ...');
  window.setTimeout(() => location.reload(), 300);
}
function setupPersist(): void {
  $('shutdown-top').addEventListener('click', () => { void shutdown(); });
  $('reset-btn').addEventListener('click', () => { if (herculesStopped) $<HTMLDialogElement>('reset-dialog').showModal(); });
  $('reset-yes').addEventListener('click', () => { $<HTMLDialogElement>('reset-dialog').close(); doReset('user'); });
  $('reset-no').addEventListener('click', () => $<HTMLDialogElement>('reset-dialog').close());
  $('offer-reset').addEventListener('click', () => { $<HTMLDialogElement>('reset-offer').close(); doReset(`auto: ${persistState.resetOffered}`); });
  $('offer-wait').addEventListener('click', () => $<HTMLDialogElement>('reset-offer').close());
  machine.persist?.onState((s, info) => {
    if (s === 'iplfail') offerReset(String(info.reason ?? 'the IPL did not complete'), !!info.dirtyStart);
    if (s === 'stopped' && !herculesStopped && !operator?.shuttingDown) {
      // Hercules ended without the page's shutdown: clean only if MVS reached the QUIESCE wait (000A0000 00000CCC)
      herculesStopped = true;
      if (disabledWaitSeen) { machine.persist?.markClean(); persistState.cleanShutdown = true; }
      setButtons('stopped');
      status(disabledWaitSeen ? 'MVS is shut down (QUIESCE). Your disks are saved in this browser.' : 'Hercules has stopped (MVS was not shut down).');
    }
  });
}
/** The IPL failed (or Hercules did not start). After a dirty start this is the expected symptom of damaged disks. */
function offerReset(reason: string, dirty: boolean): void {
  if (persistState.resetOffered || !machine.persist?.info()?.enabled) return;
  persistState.resetOffered = reason;
  dlog(`[persist] reset offer: ${reason} (dirty start: ${dirty})`);
  $('offer-text').textContent = dirty
    ? `MVS did not come up (${reason}). The last session was closed without "Shut down", so the saved disks may be damaged. Reset the machine to start again from the original disks (your changes are lost), or keep waiting.`
    : `MVS did not come up (${reason}). You can reset the machine to start again from the original disks (your changes are lost), or keep waiting.`;
  const d = $<HTMLDialogElement>('reset-offer');
  if (!d.open) d.showModal();
  if (AUTORESET) window.setTimeout(() => { if (d.open) { d.close(); doReset(`auto: ${reason}`); } }, 500);
}
function lockedScreen(msg: string): void {
  persistState.lockedScreen = true;
  $('loader').hidden = false;
  $('loader-bar').classList.remove('indeterminate');
  $('loader-bar').style.width = '0%';
  $('loader-text').textContent = `${msg}. Only one tab can run the machine, because its disks are saved in this browser. Close the other tab (use "Shut down" there to keep your work safe), then try again.`;
  const a = $('loader-actions'); a.hidden = false;
  $('loader-retry').addEventListener('click', () => location.reload());
  (window as unknown as { mvsState: string }).mvsState = 'locked';
}

// ------------------------------------------------------------------ save state
/**
 * CCKD writes a changed track to the saved disks (OPFS shadow files) only at its next hardener pass (CCKD
 * dhint=1 in persist mode: within about 1 s). After the IPL the page asks for an immediate pass (hw_cckd_flush)
 * as soon as it sees unsaved data. If data stays unsaved longer than SAVING_SHOW_MS, the header shows "Saving...",
 * then "Saved". When the page is hidden or unloaded it asks for an immediate pass too, and a
 * reload / close while data is not yet written gets the browser's "Leave page?" prompt (beforeunload), so the
 * visitor can wait. Both only after TSO is ready (the IPL writes all the time and nothing of the visitor's is
 * at risk then; a flush in the middle of the IPL makes a closed tab leave a half-written IPL on the disks), and
 * never after Hercules has stopped.
 */
/** "Saving..." only when unsaved data stays longer than this (a normal write is on the disk in about 0.3 s). */
const SAVING_SHOW_MS = Number(q.get('savingms') ?? 400);
const saveInfo = { autoFlushes: 0, iplWindowMs: 0, prompts: 0, flushes: [] as { why: string; at: number; dirty: number }[], windows: [] as number[], shownSaving: 0, maxWindowMs: 0,
  /** after TSO ready: 100 ms samples in which each device had unsaved data, and all samples */
  devSamples: {} as Record<string, number>, hardSamples: {} as Record<string, number>, samples: 0 };
function setupSaveState(): void {
  const p = machine.persist;
  if (!p?.info()?.enabled || !p.saveState().supported) return;
  const el = $('save-status');
  let dirtyAt = 0, savedTimer = 0, lastAuto = 0;
  // unsaved data that the visitor can lose: written after TSO ready (the IPL's own writes stay in the CCKD cache
  // until TSO ready, then they are flushed once; see web/runtime wrthru for a reload before that)
  const visitorDirty = (): boolean => !!dirtyAt && !!ipl.tso && dirtyAt >= ipl.tso;
  const show = (text: string, cls: string, title: string): void => { el.textContent = text; el.className = cls; el.title = title; el.hidden = false; };
  window.setInterval(() => {
    if (herculesStopped) { el.hidden = true; return; }
    const s = p.saveState();
    const now = performance.now();
    if (ipl.tso) {
      saveInfo.samples++;
      for (const d of s.devs ?? []) saveInfo.devSamples[d] = (saveInfo.devSamples[d] ?? 0) + 1;
      for (const d of s.unhardened ?? []) saveInfo.hardSamples[d] = (saveInfo.hardSamples[d] ?? 0) + 1;
    }
    // the indicator and the prompt count only the visitor's data (userDirty: not PAGE00, see runtime scratchDevs)
    const user = s.userDirty ?? s.dirty;
    // After the IPL: do not wait for the next hardener pass (dhint, 1 s), ask for one now (at most every 300 ms).
    // MVS writes something every few seconds even when idle (measured: MVS000 every 10 s, PAGE00), so this keeps
    // the window in which a reload loses data short for every write, not only for the visitor's saves.
    if (s.dirty && ipl.tso && now - lastAuto > 300) { lastAuto = now; if (p.flushNow('dirty')) saveInfo.autoFlushes++; }
    if (user) {
      if (!dirtyAt) dirtyAt = s.since || now;
      if (visitorDirty() && now - dirtyAt > SAVING_SHOW_MS && el.className !== 'saving') {
        window.clearTimeout(savedTimer);
        saveInfo.shownSaving++;
        show('Saving…', 'saving', 'Writing your changes to the disks saved in this browser. Wait for "Saved" before you reload or close the page.');
      }
    } else if (dirtyAt) {
      const w = Math.round(now - dirtyAt);
      // windows that began after TSO ready (write-through on); one that began during the IPL (CCKD cache) is
      // counted apart (ipl), it ends with the flush at TSO ready
      const afterReady = !!ipl.tso && dirtyAt >= ipl.tso;
      dirtyAt = 0;
      if (afterReady) { saveInfo.windows.push(w); if (saveInfo.windows.length > 200) saveInfo.windows.shift(); saveInfo.maxWindowMs = Math.max(saveInfo.maxWindowMs, w); }
      else saveInfo.iplWindowMs = w;
      if (el.className === 'saving') {
        show('Saved', 'saved', 'All changes are written to the disks saved in this browser.');
        savedTimer = window.setTimeout(() => { el.hidden = true; el.className = ''; }, 2500);
      }
    }
  }, 100);
  const flush = (why: string): void => {
    if (herculesStopped || !ipl.tso) return;           // never during the IPL (the runtime refuses it too)
    const d = p.saveState().dirty;
    if (p.flushNow(why)) { saveInfo.flushes.push({ why, at: Math.round(performance.now()), dirty: d }); if (saveInfo.flushes.length > 100) saveInfo.flushes.shift(); }
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush('hidden'); });
  window.addEventListener('pagehide', () => flush('pagehide'));
  window.addEventListener('beforeunload', (e) => {
    if (herculesStopped || !ipl.tso) return;
    const st = p.saveState();
    if (!(st.userDirty ?? st.dirty) || !visitorDirty()) { if (st.dirty) flush('beforeunload'); return; }
    flush('beforeunload');
    saveInfo.prompts++;
    e.preventDefault();
    e.returnValue = '';                  // (older browsers need a value to show the prompt)
  });
}

// ------------------------------------------------------------------ boot
/** /embed (X player card): a sandboxed frame without top navigation, so links open a new tab. */
const EMBED = document.documentElement.classList.contains('embed');
if (EMBED) for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href^="http"]')) { a.target = '_blank'; a.rel = 'noopener'; }

/**
 * coi-serviceworker: on a host without COOP/COEP it registers on the first visit and then reloads
 * the page. Do not open any terminal before that reload (a console connection would be dropped in
 * the middle of the telnet negotiation). Returns false if the page is about to reload.
 */
async function coiSettled(): Promise<boolean> {
  if (self.crossOriginIsolated || EMBED) return true;   // in a frame the service worker cannot isolate the page
  const sw = navigator.serviceWorker;
  if (!window.isSecureContext || !sw) return true;
  if (sw.controller) return true;            // controlled but not isolated: the SW cannot help (old browser)
  loader('Enabling cross-origin isolation (one reload) ...');
  // index.html reloads when the service worker is active (navigator.serviceWorker.ready). Wait for that
  // (at most 15 s: slow link), then up to 4 s for the reload itself; then go on (the boot fails with the
  // isolation error if the reload did not come).
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  await Promise.race([sw.ready, sleep(15000)]);
  await sleep(4000);
  return true;
}

async function boot(): Promise<void> {
  await coiSettled();
  if (BACKEND === 'wasm' && !self.crossOriginIsolated && EMBED) {
    // Phones and most in-app browsers cannot isolate a page inside the post's frame (Document-Isolation-Policy
    // is desktop Chrome/Edge 137+ only), but they can run the full site: offer that instead of an error.
    $('loader-text').textContent = 'This browser cannot run MVS inside the post. It runs on the full site (phones too):';
    $('loader-bar').parentElement!.hidden = true;
    $('loader-open').classList.add('big');
    $<HTMLAnchorElement>('loader-open').querySelector('a')!.textContent = 'Open webmvs.com';
    (window as unknown as { mvsState: string }).mvsState = 'needs-full-site';
    return;
  }
  if (BACKEND === 'wasm' && !self.crossOriginIsolated) {
    throw new Error(EMBED ? 'this browser cannot run MVS inside the post (it needs desktop Chrome or Edge 137+). Open the full site instead'
      : 'this browser did not enable cross-origin isolation (SharedArrayBuffer is needed)');
  }
  setupDebug(); setupAbout(); buildKeypad(); wireCapture(); setupHistory();
  $('add-tso').addEventListener('click', () => { const t = addTso(); userPicked = true; select(t.id); void connectTso(t); });
  machine.onLog((l, historic) => {
    hercLines.push([performance.now(), l]);
    if (hercLines.length > 20000) hercLines.splice(0, 2000);
    if (DEBUG) appendLog(l);
    if (historic) return;
    if (/HHC00809I.*disabled wait state 000A0000 00000CCC/.test(l)) disabledWaitSeen = true;
    if (/^Aborted\(|worker sent an error!/.test(l)) crashed(l);
    if (ipl.started) operator?.external(l);
    if (CONSOLE_MODE === 'late' && /^\d\d:\d\d:\d\d \/ /.test(l)) lateConsoleLine(l.slice(11));
  });
  loader('Loading terminal font ...');
  atlas = await loadAtlas('./3270.bdf');
  try {
    await machine.load(onProgress);
  } catch (e) {
    if (e instanceof LockedError) { lockedScreen(e.message); return; }
    // A start that fails on saved disks (for example a damaged shadow file) can also be reset.
    if (machine.persist?.info()?.enabled) { setupPersistOfferOnly(); offerReset(`Hercules did not start: ${e instanceof Error ? e.message : String(e)}`, !!machine.persist.info()?.dirtyStart); }
    throw e;
  }
  setupPersist();
  setupSaveState();
  const pi = machine.persist?.info();
  if (pi?.enabled) {
    dlog(`[persist] ${JSON.stringify({ dirtyStart: pi.dirtyStart, reset: pi.reset, opfs: pi.opfs, lock: pi.lock })}`);
  } else if (pi?.why) dlog(`[persist] off: ${pi.why}`);
  setButtons('running');

  const con = makeTab('console', 'Console', 'MVS master console (0010). Type operator commands, e.g. <b>D T</b> or <b>D A,L</b>, then <kbd>Enter</kbd>.');
  const tso = addTso();
  placeholder(tso, 'TSO opens when MVS is ready (<b>IKT007I TCAS ACCEPTING LOGONS</b>).');
  $('add-tso').hidden = true;
  $('loader').hidden = true;
  $('app').hidden = false;
  select('console');
  // A new image replaced system volumes that had saved changes (runtime persist.upgrade): say it once.
  const up = pi?.upgrade;
  if (up && up.removed.length) {
    con.notice = tso.notice = UPDATE_NOTICE;
    renderHint(tabs.get(active));
    dlog(`[persist] new image: removed ${up.removed.join(', ')}; kept ${up.kept.join(', ') || '-'}`);
  }

  if (CONSOLE_MODE === 'early') {
    loader('Connecting the master console ...');
    const v = newView(con, CONSOLE_TTYPE);
    operator = new ConsoleOperator(v, dlog);
    await v.connect();
    // Wait for console.c to finish the TTYPE negotiation and draw the logo on 0010.
    const ok = await until(() => v.text().trim() !== '', 15000);
    if (!ok) dlog('[console] no screen on 0010 within 15 s');
  } else {
    placeholder(con, '<pre class="latelog" id="latelog"></pre>');
  }
  if (operator) operator.t0 = performance.now();
  setupSnapshot();
  // a saved machine of this browser is resumed instead of an IPL (falls back to an IPL when that fails)
  const plan = machine.snapshot?.plan() ?? null;
  if (plan) dlog(`[snapshot] ${JSON.stringify({ resume: plan.resume, why: plan.why, gen: plan.gen, savedAt: plan.savedAt, terminals: plan.terminals })}`);
  if (plan?.resume && operator && CONSOLE_MODE === 'early') {
    operator.onLine((l) => { const s522 = /IEF450I (\S+) .*ABEND S522/.exec(l); if (s522) tsoTimedOut(s522[1]!, l); });
    await resumeFlow(plan, tso);
    return;
  }
  operator?.onTsoReady(() => void tsoReady(tso));
  operator?.onLine((l) => {
    const s522 = /IEF450I (\S+) .*ABEND S522/.exec(l);
    if (s522) tsoTimedOut(s522[1]!, l);
    // IPL progress only until TSO is ready (0010 shows the queued IPL lines some seconds after IKT007I)
    if (ipl.tso) return;
    if (/IEA101A/.test(l)) status('IPL: NIP, system parameters (IEA101A)');
    else if (/\$HASP493|\$HASP426/.test(l)) status('IPL: JES2 starting');
    else if (/IST020I|VTAM/.test(l)) status('IPL: VTAM starting');
  });

  ipl.started = performance.now();
  const pi2 = machine.persist?.info();
  // "saved disks" only when this browser has shadow files from an earlier visit (the loader lists them before
  // it writes the seed files; without that list: the machine marker of an earlier start). A first visit, or a
  // reset, starts from the original disks.
  const savedDisks = pi2?.opfs ? pi2.opfs.files.length > 0 : (pi2?.marker?.state ?? 'new') !== 'new';
  status(pi2?.enabled
    ? (pi2.upgrade?.removed.length && !pi2.reset ? 'IPL 150 from your saved disks, with the new system disks ...'
      : pi2.reset ? `IPL 150 from the original disks (${/^base image changed/.test(pi2.resetWhy ?? '') ? 'new MVS disk images' : 'machine reset'}) ...`
      : !savedDisks ? 'IPL 150 from the original disks (first visit) ...'
      : pi2.dirtyStart ? 'IPL 150 from your saved disks (last session not shut down) ...' : 'IPL 150 from your saved disks ...')
    : 'IPL 150 ...');
  if (q.get('noipl') !== '1') await machine.ipl();
  (window as unknown as { mvsState: string }).mvsState = 'ipl';
}

// ------------------------------------------------------------------ snapshot
/**
 * The runtime checkpoints the running machine (memory + disks) in this browser: when the page is hidden or closed,
 * and every minute while MVS is idle (web/runtime mvs-snapshot.js). The next load continues it without an IPL:
 * the page opens the terminals that were connected (0010 and the TSO devices, by device number) BEFORE the resume,
 * puts the saved console lines back (History), and the TSO session goes on. If the resume fails, the runtime
 * discards the snapshot and the page reloads: that load IPLs.
 */
const snapInfo = { resumed: '' as '' | 'resuming' | 'ok' | 'failed', reason: '', savedAt: 0, resumeMs: 0, gen: '' };
function fmtSaved(ms: number): string {
  const d = new Date(ms), now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}
function setupSnapshot(): void {
  const s = machine.snapshot;
  if (!s) return;
  // the page's part of every checkpoint: console lines (the restored screen shows only the last ones) and the tabs
  s.setPage(() => ({
    history: (operator?.seen ?? []).slice(-1000),
    tabs: [...tabs.values()].map((t) => ({ id: t.id, devnum: t.raw?.devnum ?? null })),
    active: tabs.get(active)?.raw?.devnum ?? active,
  }));
  $('fresh-btn').addEventListener('click', () => $<HTMLDialogElement>('fresh-dialog').showModal());
  $('fresh-no').addEventListener('click', () => $<HTMLDialogElement>('fresh-dialog').close());
  $('fresh-yes').addEventListener('click', () => { $<HTMLDialogElement>('fresh-dialog').close(); void startFresh(); });
}
async function startFresh(): Promise<void> {
  status('Start fresh: the saved machine is discarded, the page reloads and MVS is IPLed ...');
  machine.snapshot?.pause('start fresh');
  await machine.snapshot?.discard('user: start fresh');
  window.setTimeout(() => location.reload(), 300);
}
async function resumeFlow(plan: SnapshotPlan, tso1: Tab): Promise<boolean> {
  snapInfo.resumed = 'resuming'; snapInfo.savedAt = plan.savedAt ?? 0; snapInfo.gen = plan.gen ?? '';
  (window as unknown as { mvsState: string }).mvsState = 'resuming';
  status(`Resuming your saved machine (saved ${fmtSaved(plan.savedAt ?? Date.now())}) ...`);
  const page = (plan.page ?? {}) as { history?: string[]; active?: string };
  operator!.resumed(page.history ?? []);
  // the TSO devices that were connected at the checkpoint, each in its own tab, connected BEFORE the resume
  const devs = plan.terminals.map((t) => t.devnum).filter((d) => d !== '0010').sort();
  const tsoTabs: Tab[] = [];
  for (let i = 0; i < devs.length; i++) {
    const t = i === 0 ? tso1 : addTso();
    placeholder(t, '');
    const v = newView(t, `${TTYPE}@${devs[i]}`);
    try { await v.connect(); } catch (e) { dlog(`[snapshot] connect ${devs[i]}: ${String(e)}`); }
    await until(() => v.text().trim() !== '', 15000);
    tsoTabs.push(t);
  }
  const t0 = performance.now();
  const r = await machine.snapshot!.resume();
  snapInfo.resumeMs = Math.round(performance.now() - t0);
  if (!r.ok) {
    snapInfo.resumed = 'failed'; snapInfo.reason = r.reason ?? '';
    dlog(`[snapshot] resume failed: ${r.reason}`);
    status(`Could not continue the saved machine (${r.reason}). The page reloads and MVS is IPLed ...`);
    (window as unknown as { mvsState: string }).mvsState = 'resumefail';
    window.setTimeout(() => location.reload(), 2500);
    return false;
  }
  snapInfo.resumed = 'ok';
  ipl.started = t0; ipl.tso = performance.now(); ipl.switchReason = 'resumed';
  if (!tsoTabs.length) { try { await connectTso(tso1); } catch { /* shown in the tab */ } }
  $('add-tso').hidden = false;
  $('fresh-btn').hidden = false;
  const want = page.active === 'console' ? 'console' : [...tabs.values()].find((t) => t.raw?.devnum && t.raw.devnum === page.active)?.id;
  if (!userPicked) select(want ?? (tsoTabs[0]?.id ?? 'console'));
  status(`Resumed your saved machine (saved ${fmtSaved(plan.savedAt ?? Date.now())})`);
  (window as unknown as { mvsState: string }).mvsState = 'tso';
  return true;
}
/** Console history: the console lines of this machine, also the ones before the last resume (History button). */
function setupHistory(): void {
  const pane = $('history'), pre = $('history-text');
  const fill = (): void => {
    const lines = operator?.seen ?? [];
    $('history-count').textContent = `${lines.length} lines${operator?.restoredLines ? ` (${operator.restoredLines} from before the resume)` : ''}`;
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.textContent = lines.join('\n');
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  };
  let timer = 0;
  $('history-btn').addEventListener('click', () => {
    pane.hidden = !pane.hidden;
    window.clearInterval(timer);
    if (!pane.hidden) { fill(); pre.scrollTop = pre.scrollHeight; timer = window.setInterval(fill, 1000); }
    else focusTerminal();
  });
  $('history-close').addEventListener('click', () => { pane.hidden = true; window.clearInterval(timer); focusTerminal(); });
}

function setupPersistOfferOnly(): void {
  $('offer-reset').addEventListener('click', () => { $<HTMLDialogElement>('reset-offer').close(); doReset(`auto: ${persistState.resetOffered}`); });
  $('offer-wait').addEventListener('click', () => $<HTMLDialogElement>('reset-offer').close());
}

const lateLines: string[] = [];
let lateSeenReady = false;
function lateConsoleLine(l: string): void {
  lateLines.push(l);
  if (lateLines.length > 200) lateLines.splice(0, 100);   // only the last 23 are shown
  const pre = document.getElementById('latelog');
  if (pre) { pre.textContent = lateLines.slice(-23).join('\n'); }
  if (!lateSeenReady && /IKT007I/.test(l)) {
    lateSeenReady = true;
    void lateAttachConsole();
  }
}
async function lateAttachConsole(): Promise<void> {
  const con = tabs.get('console')!;
  placeholder(con, '');
  const v = newView(con, CONSOLE_TTYPE);
  operator = new ConsoleOperator(v, dlog);
  operator.enabled = false;
  await v.connect();
  await until(() => v.text().trim() !== '', 15000);
  await machine.command('/V 010,CONSOLE');
  operator.enabled = true;
  void tsoReady(tabs.get('tso1')!);
}

async function tsoReady(tso: Tab): Promise<void> {
  if (ipl.tso) return;
  ipl.tso = performance.now();
  status(`TSO ready: IKT007I ${((ipl.tso - ipl.started) / 1000).toFixed(1)} s after IPL`);
  (window as unknown as { mvsState: string }).mvsState = 'tso';
  try { await connectTso(tso); } catch { return; }
  $('add-tso').hidden = false;
  // Auto-switch once, unless the visitor already picked a tab during the IPL: SWITCH_DELAY after IKT007I
  // is on the 0010 screen, or SWITCH_MAX after TSO ready (no console, console=late, or 0010 is slow).
  let done = false;
  const go = (why: string): void => {
    if (done) return;
    done = true;
    ipl.switched = performance.now(); ipl.switchReason = why;
    // not while / after the visitor shuts down (Shut down selects the Console tab; a switch timer that was still
    // pending put the TSO tab back in front, seen in UI screenshots)
    if (operator?.shuttingDown || herculesStopped) { ipl.switchReason += ' (skipped: shutdown)'; dlog(`[tabs] auto-switch skipped (shutdown): ${why}`); return; }
    dlog(`[tabs] auto-switch to TSO: ${why}`);
    if (!userPicked || active === 'console') select(tso.id);
  };
  const max = window.setTimeout(() => go(`no IKT007I on 0010 within ${SWITCH_MAX / 1000} s`), SWITCH_MAX);
  const op = CONSOLE_MODE === 'early' ? operator : undefined;
  if (!op) { window.clearTimeout(max); go('console not used for IPL'); return; }
  op.onConsoleReady(() => {
    ipl.consoleIkt = op.consoleIktAt;
    window.setTimeout(() => { window.clearTimeout(max); go(`IKT007I on 0010 + ${SWITCH_DELAY} ms`); }, SWITCH_DELAY);
  });
}

function until(cond: () => boolean, ms: number): Promise<boolean> {
  return new Promise((ok) => {
    const end = performance.now() + ms;
    const tick = (): void => { if (cond()) ok(true); else if (performance.now() > end) ok(false); else setTimeout(tick, 100); };
    tick();
  });
}

// ------------------------------------------------------------------ test hooks (Playwright)
Object.assign(window, {
  mvs: {
    text: (id: string): string => tabs.get(id)?.view?.text() ?? '',
    oia: (id: string): string => tabs.get(id)?.view?.oiaText() ?? '',
    tabs: (): string[] => [...tabs.keys()],
    active: (): string => active,
    select,
    operator: () => operator,
    events: () => operator?.events ?? [],
    seen: () => operator?.seen ?? [],
    // seen() is a window of the newest lines; seenTotal() = lines since the IPL, seenSince(n) = lines from index n on
    seenTotal: () => operator?.seenTotal ?? 0,
    tsoLogoffs: () => tsoLogoffs.slice(),
    hint: () => $('hint').textContent ?? '',
    seenSince: (n: number) => operator?.seenSince(n) ?? [],
    unlocked: (id: string): boolean => tabs.get(id)?.view?.unlocked() ?? false,
    type: (id: string, s: string): boolean => tabs.get(id)?.view?.session.keyboard.typeString(s) ?? false,
    act: (id: string, a: Action): void => tabs.get(id)?.view?.action(a),
    /** keyboard / data-stream event log of a tab (bounded) and the typeahead counters. */
    kbdlog: (id: string) => tabs.get(id)?.view?.kbdlog.slice() ?? [],
    typeahead: (id: string) => tabs.get(id)?.view?.ahead_() ?? null,
    /** the unprotected fields of a tab (no contents: only how many cells hold a character) + the cursor. */
    fields: (id: string) => {
      const sc = tabs.get(id)?.view?.session.screen; if (!sc) return null;
      const out = sc.fields().filter((f) => !f.protected).map((f) => {
        let filled = 0; for (let i = 0, a = f.start; i < f.length; i++, a = sc.inc(a)) { const e = sc.cellAt(a).ebcdic; if (e !== 0 && e !== 0x40) filled++; }
        return { attr: f.attrAddr, start: f.start, len: f.length, hidden: f.hidden, mdt: f.modified, filled };
      });
      return { cursor: sc.cursor, fields: out };
    },
    addTso: async (): Promise<string> => { const t = addTso(); select(t.id); await connectTso(t); return t.id; },
    /** snapshot state (runtime stats + what the page did), a checkpoint now, the console history. */
    snapshot: () => ({ page: { ...snapInfo }, rt: machine.snapshot?.stats() ?? null }),
    checkpoint: (why = 'test') => machine.snapshot?.checkpoint(why) ?? Promise.resolve(null),
    history: () => (operator?.seen ?? []).slice(),
    shutdown,
    timings: () => ({ ...ipl }),
    log: () => logLines.slice(),
    herclog: (): [number, string][] => hercLines.slice(),
    backend: (): string => machine.kind,
    stats: (): unknown => machine.stats?.() ?? null,
    crossOriginIsolated: () => self.crossOriginIsolated,
    persist: () => ({ ...persistState, herculesStopped, info: machine.persist?.info() ?? null }),
    crash: () => crashInfo ?? null,
    /** save state now + what the page did about it (indicator, flush requests, beforeunload prompts, dirty windows). */
    saving: () => (machine.persist?.info()?.enabled ? { ...machine.persist.saveState(), shown: $('save-status').hidden ? '' : $('save-status').textContent, ...saveInfo, flushes: saveInfo.flushes.slice(-10), windows: saveInfo.windows.slice() } : null),
    hcmd: (c: string) => machine.command(c),
    shadows: async () => (await machine.persist?.shadows()) ?? [],
    /** base64 of one shadow file (tests; only while Hercules is stopped). */
    shadowB64: async (name: string): Promise<string> => {
      const b = await machine.persist!.shadowBytes(name);
      let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return btoa(s);
    },
  },
});

boot().catch((e: unknown) => {
  dlog(`[boot] ${String(e)}`);
  $('loader').hidden = false;
  $('loader-text').textContent = `Could not start: ${e instanceof Error ? e.message : String(e)}`;
  $('loader-bar').classList.remove('indeterminate');
  (window as unknown as { mvsState: string }).mvsState = 'error';
});
