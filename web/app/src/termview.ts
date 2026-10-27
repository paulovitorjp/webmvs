// SPDX-License-Identifier: Apache-2.0
/**
 * One 3270 terminal: a @tn3270/core Session plus its own canvas.
 *
 * The upstream canvas renderer.ts is a singleton (one #screen canvas, one window.tn3270 bridge,
 * window-level key handler), so the page cannot use it for two tabs. This view uses the same
 * upstream building blocks (drawList, blit, bestScale/center, the BDF atlas) once per tab.
 */
import { Session, resolve, KeyboardState, cp037, Color, buildReadBuffer, AID, type Connection, type Oia } from '@tn3270/core';
import { applyAction, resolveScheme, schemeRgb, type Action, type Scheme } from '@tn3270/frontend';
import { drawList, type DrawList } from '../../vendor/tn3270/packages/canvas/src/drawlist.js';
import { blit, blankColumns, tintKey, rgbCss, type Ctx2D } from '../../vendor/tn3270/packages/canvas/src/blit.js';
import { parseBdf } from '../../vendor/tn3270/packages/canvas/src/bdf.js';
import { ebcdicToCg, column } from '../../vendor/tn3270/packages/canvas/src/cg.js';
import type { AtlasGeometry, DrawCell } from '../../vendor/tn3270/packages/canvas/src/geometry.js';
import { normalizeRect, isEmptyRect, extractText, type CellAddr, type CellRect } from '../../vendor/tn3270/packages/canvas/src/selection.js';
import type { Rgb } from '@tn3270/core';

/** terminal width (CSS px) below which the rows may be stretched vertically, and the most they stretch */
const NARROW_PX = 700;
const STRETCH_MAX = 1.6;

/**
 * The cursor blinks (x3270 cursorBlink), every BLINK_MS, except with prefers-reduced-motion or ?blink=0. It is
 * solid while you type: each key starts a new 'on' phase.
 */
const BLINK = new URLSearchParams(location.search).get('blink') !== '0';
const BLINK_MS = 530;
/**
 * Selection (x3270 style, rectangular: a 3270 screen is columns): drag with the mouse; on a touch screen hold a
 * finger still for LONG_PRESS_MS, then drag. Ctrl+C / Cmd+C or the Copy button copies the text (hidden fields as
 * blanks). A click or a tap without a drag moves the cursor to that position.
 */
const LONG_PRESS_MS = 450;
const TOUCH_SLOP_PX = 10;

/** ?oia=0 hides the status line under the screen (default: shown, 3270 style). */
const SHOW_OIA = new URLSearchParams(location.search).get('oia') !== '0';
/**
 * Typeahead. ?typeahead=0 = no typeahead (for comparisons).
 * While the HOST holds the keyboard (X SYSTEM after an AID, the enter-inhibit after a Query reply, the wait for the
 * first write), the vendored Keyboard refuses every typed character (returns false, nothing kept), but
 * Session.sendAID() has no lock check, so an Enter typed at the same time still goes to the host, with a Read Modified
 * that lacks the refused characters. This is how a TSO password was lost. Like x3270 (kybd.c
 * enq_ta), the view now keeps every keystroke that arrives while the host holds the keyboard, in order, and plays
 * them back when the host gives the keyboard back; an AID in the queue locks it again, and the rest waits for the
 * next unlock. Reset clears the queue (x3270: flush_ta). Operator errors (protected field, numeric, overflow) are not
 * host locks: those keys go through at once as before.
 */
const TYPEAHEAD = new URLSearchParams(location.search).get('typeahead') !== '0';
/**
 * Lost TSO password. ?pwresend=0 = off.
 * Measured: now and then MVS 3.8 TSO answers the Enter of a password with a bare keyboard-unlock Write (WCC restore,
 * only SBA/SF/IC orders, no data: VTAM takes the line as typeahead because the logon's read is not active yet), and
 * the logon then never uses that line: the prompt stays, the keyboard is unlocked, nothing more comes (seen only with
 * the SRM tune of the runtime: Playwright Firefox 4 of 50 logons, Chromium 0 of 50, native Hercules 1 of about 300).
 * The bytes the page sent were right (AID, cursor, SBA, the 6 characters of the non-display field). The line is not
 * lost: TSO keeps it queued and hands it to its next read (sending the password again made the logon go on, and then
 * the queued copy ran as a command: 'COMMAND PASS4U NOT FOUND').
 * So when an Enter carried a modified NON-DISPLAY field (a password), the host's first answer is that bare unlock
 * write and then nothing comes for PW_RESEND_MS while the visitor types nothing and the screen still asks for a
 * PASSWORD, the view sends one Enter WITHOUT a modified field ('nudge', the default): TSO then hands its queue out in
 * order, the logon gets the queued password line, and the empty line goes to the first TSO read after the logon.
 * ?pwresend=resend (tests only) sends the password again instead; ?pwresend=0 = off. Nothing is stored or shown.
 */
const PW_MODE = ((): 'nudge' | 'resend' | 'off' => { const v = new URLSearchParams(location.search).get('pwresend'); return v === '0' ? 'off' : v === 'resend' ? 'resend' : 'nudge'; })();
const PW_RESEND = PW_MODE !== 'off';
const PW_RESEND_MS = Number(new URLSearchParams(location.search).get('pwresendms') ?? 1500);
const AHEAD_MAX = 512;
/**
 * Keyboard hold after a Query.
 * Root cause of the rare 'PASSWORD NOT AUTHORIZED': after 'LOGON <user>' TSO sends
 * a Read Partition Query (the page answers; enter-inhibit), then the prompt in TWO records: an Erase/Write with WCC
 * X'C1' (no keyboard restore: the prompt text) and, a few ms later, a Write with WCC X'C3' (restore) that defines the
 * non-display password field (SBA, SF X'4C') and moves the cursor to it (IC). The vendored core follows x3270: any
 * Write releases the enter-inhibit, so the keyboard was 'unlocked' between the two records (the runtime drains the
 * terminal ring every 8 ms, so the two records can arrive one tick apart). A key typed in that gap went to the old
 * cursor position, the second record then overwrote it with the field attribute and put the cursor back to the field
 * start: the password reached MVS with its first character missing (trace build 0016: 'recv n=11' = 5 characters
 * instead of 6; page field 'filled 5'). Now a write that releases the enter-inhibit WITHOUT a WCC keyboard restore
 * keeps the keyboard held for the host until a write with restore (or EAU) comes, at most HOLD_MS after the last host
 * record; keys typed meanwhile wait in the typeahead queue and are played back after the restore.
 */
const KBD_HOLD = new URLSearchParams(location.search).get('kbdhold') !== '0';
const HOLD_MS = Number(new URLSearchParams(location.search).get('kbdholdms') ?? 1000);
/** Keyboard and data-stream event log of one view (bounded; window.mvs.kbdlog(id)). */
export interface KbdEvent { t: number; ev: string; kb: string; d?: string }
const KBDLOG_MAX = 400;
const CMD_NAMES: Record<number, string> = { 0xf1: 'W', 0xf5: 'EW', 0x7e: 'EWA', 0x6f: 'EAU', 0xf3: 'WSF', 0xf2: 'RB', 0xf6: 'RM', 0x6e: 'RMA',
  0x01: 'W', 0x05: 'EW', 0x0d: 'EWA', 0x0f: 'EAU', 0x11: 'WSF', 0x02: 'RB', 0x06: 'RM', 0x0e: 'RMA' };

/**
 * The Operator Information Area as a 3270 shows it, on its own row under the 24x80 screen, below a
 * separator line (the upstream drawList printed Oia.toText(), "4 A", in white
 * directly under row 24, which looked like stray screen text):
 *   col 0      '4' in reverse video (the boxed 4: ready, connected to the host)
 *   col 1      'A' underlined (3270 mode, TN3270E off), or ' ' before the host switched to 3270 mode
 *   col 8      input inhibit: X SYSTEM / X Wait / X Protected / X Numeric / X PROGnnn ..., or X Disconnected
 *   col 52     '^' insert mode
 *   last 7     cursor position rrr/ccc (x3270 style)
 * All in the scheme's blue; drawn with the same atlas as the screen (no system font).
 */
export function oiaCells(oia: Oia, cursor: number, cols: number, y: number, atlas: AtlasGeometry, scheme: Scheme): { text: string; cells: DrawCell[] } {
  const fg = schemeRgb(scheme, Color.BLUE);
  const bg = schemeRgb(scheme, Color.NEUTRAL_BLACK);
  const line = new Array<{ ch: string; rev?: boolean; ul?: boolean }>(cols).fill({ ch: ' ' });
  const put = (col: number, text: string, f: { rev?: boolean; ul?: boolean } = {}): void => {
    [...text].forEach((ch, i) => { if (col + i >= 0 && col + i < cols) line[col + i] = { ch, ...f }; });
  };
  let lock = '';
  if (!oia.connected) lock = 'X Disconnected';
  else {
    put(0, '4', { rev: true });
    if (oia.tn3270Mode) put(1, 'A', { ul: true });
    // Oia.toText() is "4 A" or "4" followed by the lock parts, joined by two spaces; keep the lock parts.
    lock = oia.toText().replace(/^4( A)?/, '').replace(/\s*\^$/, '').trim();
  }
  put(8, lock);
  if (oia.insertMode) put(52, '^');
  if (oia.connected && cursor >= 0) {
    const r = Math.floor(cursor / cols) + 1, c = (cursor % cols) + 1;
    put(cols - 7, `${String(r).padStart(3, '0')}/${String(c).padStart(3, '0')}`);
  }
  const cells = line.map((cell, i): DrawCell => ({
    x: i * atlas.cellWidth, y,
    glyph: column(atlas, ebcdicToCg(cp037.fromUnicode(cell.ch))),
    fg: cell.rev ? bg : fg, bg: cell.rev ? fg : bg,
    cursor: false, underline: !!cell.ul, blink: false, intensify: false,
  }));
  return { text: line.map((c) => c.ch).join('').trimEnd(), cells };
}

export interface Atlas { geometry: AtlasGeometry; coverage: Uint8Array; blank: ReadonlySet<number> }

/** Bake the atlas from 3270.bdf, as canvas/scripts/build-atlas.mjs does at build time. */
export async function loadAtlas(url: string): Promise<Atlas> {
  const font = parseBdf(await (await fetch(url)).text());
  const codes = [...font.glyphs.keys()].sort((a, b) => a - b);
  const index: Record<number, number> = {};
  codes.forEach((c, i) => { index[c] = i; });
  const cols = codes.length;
  const stride = cols * font.width;
  const coverage = new Uint8Array(stride * font.height);
  codes.forEach((code, i) => {
    const g = font.glyphs.get(code)!;
    for (let y = 0; y < font.height; y++) {
      const row = g.rows[y]!;
      for (let x = 0; x < font.width; x++) coverage[y * stride + i * font.width + x] = row[x] ? 255 : 0;
    }
  });
  const geometry = { cellWidth: font.width, cellHeight: font.height, cols, index } as unknown as AtlasGeometry;
  return { geometry, coverage, blank: blankColumns(coverage, geometry) };
}

/** One tinted copy of the atlas per color, shared by all views (bounded by the palette). */
const tints = new Map<string, ImageBitmap>();
const building = new Map<string, Promise<void>>();
function tintOf(atlas: Atlas, color: Rgb, repaint: () => void): ImageBitmap | undefined {
  const key = tintKey(color);
  const got = tints.get(key);
  if (got) return got;
  if (!building.has(key)) {
    const w = atlas.geometry.cols * atlas.geometry.cellWidth;
    const h = atlas.geometry.cellHeight;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < atlas.coverage.length; i++) {
      data[i * 4] = color[0]; data[i * 4 + 1] = color[1]; data[i * 4 + 2] = color[2]; data[i * 4 + 3] = atlas.coverage[i]!;
    }
    building.set(key, createImageBitmap(new ImageData(data, w, h)).then((bmp) => { tints.set(key, bmp); }));
  }
  void building.get(key)!.then(repaint);   // repaint is coalesced by the caller (one rAF per view)
  return undefined;
}

export interface TermViewOptions {
  /** Telnet TERMINAL-TYPE, e.g. IBM-3278-2-E or IBM-3278-2-E@0010 (console.c device suffix). */
  terminalType: string;
  /** Opens a fresh Connection (called again on reconnect). */
  connect: () => Promise<Connection>;
}

export class TermView {
  readonly session: Session;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: Ctx2D;
  private last: DrawList | undefined;
  private rafPending = false;
  private screenCbs: (() => void)[] = [];
  private scheme = resolveScheme();
  connectedOnce = false;
  private repaintPending = false;
  /** One repaint per frame at most, however many cells were waiting for a tinted atlas. */
  private readonly repaintSoon = (): void => {
    if (this.repaintPending) return;
    this.repaintPending = true;
    requestAnimationFrame(() => { this.repaintPending = false; this.paint(); });
  };

  /** Keystrokes kept while the host holds the keyboard (see TYPEAHEAD). */
  private ahead: Action[] = [];
  private drainPending = false;
  /** Counters for tests and diagnosis: kept (queued), played back, refused characters, AIDs sent while locked. */
  readonly kbd = { queued: 0, replayed: 0, refusedChars: 0, aidWhileLocked: 0, flushed: 0, maxQueue: 0, pwBareUnlock: 0, pwResends: 0, holds: 0, holdTimeouts: 0 };
  /** The host released the enter-inhibit without a keyboard restore: hold the keyboard (see KBD_HOLD). */
  private hold: { timer: number } | null = null;
  /** An Enter that carried a modified non-display field: watch the host's answer (PW_RESEND). */
  private pw: { attr: number; records: number; timer?: number; resent: boolean } | null = null;
  readonly kbdlog: KbdEvent[] = [];
  /** the selection (cells), anchor where the drag began; null: none */
  private sel: { anchor: CellAddr; focus: CellAddr } | null = null;
  /** the pointer that is down on the screen: a mouse drag selects at once, a touch after a long press */
  private drag: { id: number; touch: boolean; x: number; y: number; cell: CellAddr; timer: number; selecting: boolean } | null = null;
  /** the last pointer gesture selected (or began to): main.ts then does not open the soft keyboard */
  lastPointerSelected = false;
  /** the text last put on the clipboard (tests) */
  lastCopy = '';
  readonly copyBtn: HTMLButtonElement;
  private blinkOn = true;
  private blinkTimer = 0;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private log(ev: string, d?: string): void {
    this.kbdlog.push({ t: Math.round(performance.now()), ev, kb: this.session.oia.keyboard, ...(d !== undefined ? { d } : {}) });
    if (this.kbdlog.length > KBDLOG_MAX) this.kbdlog.splice(0, this.kbdlog.length - KBDLOG_MAX);
  }

  constructor(readonly host: HTMLElement, private readonly atlas: Atlas, readonly opts: TermViewOptions) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'screen';
    host.appendChild(this.canvas);
    const c = this.canvas.getContext('2d');
    if (!c) throw new Error('no 2D canvas context');
    this.ctx = c as unknown as Ctx2D;
    this.session = new Session({ connect: () => opts.connect(), terminalType: opts.terminalType, tn3270e: false });
    this.session.on('screen', () => this.changed());
    this.session.on('connect', () => { this.connectedOnce = true; this.changed(); });
    this.session.on('disconnect', () => { this.holdEnd(''); if (this.ahead.length) { this.kbd.flushed += this.ahead.length; this.ahead = []; } this.changed(); });
    this.hookRecords();
    new ResizeObserver(() => this.paint()).observe(host);
    this.copyBtn = document.createElement('button');
    this.copyBtn.className = 'term-copy';
    this.copyBtn.type = 'button';
    this.copyBtn.textContent = 'Copy';
    this.copyBtn.title = 'Copy the selected text (Ctrl+C)';
    this.copyBtn.hidden = true;
    this.copyBtn.addEventListener('pointerdown', (e) => e.preventDefault());   // keep the focus (and soft keyboard) where it is
    this.copyBtn.addEventListener('click', () => { void this.copySelection(); });
    host.appendChild(this.copyBtn);
    this.wirePointer();
    this.reducedMotion.addEventListener?.('change', () => { this.startBlink(); this.paint(); });
    this.startBlink();
  }

  // ------------------------------------------------------------ selection
  /** The cell under a viewport point; clamp: the nearest screen cell (a drag that runs off the screen). */
  private cellAt(clientX: number, clientY: number, clamp: boolean): CellAddr | null {
    const list = this.last;
    if (!list) return null;
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const g = this.atlas.geometry;
    const cols = Math.floor(list.width / g.cellWidth), rows = Math.floor((list.oia?.y ?? list.height) / g.cellHeight);
    let col = Math.floor(((clientX - r.left) / r.width) * list.width / g.cellWidth);
    let row = Math.floor(((clientY - r.top) / r.height) * list.height / g.cellHeight);
    if (clamp) { col = Math.min(cols - 1, Math.max(0, col)); row = Math.min(rows - 1, Math.max(0, row)); }
    else if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
    return { row, col };
  }

  /** The viewport point at the middle of a cell (tests). */
  cellCenter(row: number, col: number): { x: number; y: number } | null {
    const list = this.last;
    if (!list) return null;
    const r = this.canvas.getBoundingClientRect(), g = this.atlas.geometry;
    return { x: r.left + ((col + 0.5) * g.cellWidth / list.width) * r.width, y: r.top + ((row + 0.5) * g.cellHeight / list.height) * r.height };
  }

  private selRect(): CellRect | null {
    if (!this.sel) return null;
    const rect = normalizeRect(this.sel.anchor, this.sel.focus);
    return isEmptyRect(rect) ? null : rect;
  }

  hasSelection(): boolean { return this.selRect() !== null; }

  /** The selected text, rows joined by newlines, trailing blanks trimmed, hidden fields (passwords) as blanks. */
  selectionText(): string {
    const rect = this.selRect();
    if (!rect) return '';
    const snap = this.session.screen.snapshot();
    return extractText(resolve(snap), snap.cols, rect);
  }

  clearSelection(): void {
    if (!this.sel) return;
    this.sel = null;
    this.copyBtn.hidden = true;
    this.paint();
  }

  private setSelection(anchor: CellAddr, focus: CellAddr): void {
    this.sel = { anchor, focus };
    this.copyBtn.hidden = !this.hasSelection();
    this.copyBtn.textContent = 'Copy';
    this.paint();
  }

  /** Put the selection on the clipboard (Async Clipboard API, else a copy command on a scratch text box). */
  async copySelection(): Promise<boolean> {
    const text = this.selectionText();
    if (!text) return false;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* not allowed here: the fallback */ }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      const had = document.activeElement as HTMLElement | null;
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove(); had?.focus?.({ preventScroll: true });
    }
    this.lastCopy = ok ? text : this.lastCopy;
    this.log('copy', `${ok ? 'ok' : 'failed'} ${text.length} chars`);
    this.copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
    window.setTimeout(() => { this.copyBtn.textContent = 'Copy'; }, 1500);
    return ok;
  }

  /** A click or tap without a drag: the cursor goes there (local, like the arrow keys; not while the host holds the keyboard). */
  private clickAt(cell: CellAddr): void {
    if (!this.session.isConnected() || this.hostLocked() || this.ahead.length) return;
    const cols = this.session.screen.snapshot().cols;
    this.session.keyboard.moveCursor(cell.row * cols + cell.col);
    this.startBlink();
    this.changed();
  }

  private wirePointer(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (this.drag) { window.clearTimeout(this.drag.timer); this.drag = null; }   // a pointer whose end we missed
      const cell = this.cellAt(e.clientX, e.clientY, false);
      this.log('pointer', `down ${e.pointerType} ${cell ? `${cell.row},${cell.col}` : 'off'}`);
      if (!cell) return;
      const touch = e.pointerType !== 'mouse';
      this.lastPointerSelected = false;
      const d = { id: e.pointerId, touch, x: e.clientX, y: e.clientY, cell, timer: 0, selecting: !touch };
      this.drag = d;
      if (touch) {
        d.timer = window.setTimeout(() => {
          if (this.drag !== d) return;
          d.selecting = true; this.lastPointerSelected = true;
          try { c.setPointerCapture(d.id); } catch { /* gone */ }
          (navigator as Navigator & { vibrate?: (ms: number) => boolean }).vibrate?.(10);
          this.setSelection(cell, cell);
        }, LONG_PRESS_MS);
      } else {
        this.clearSelection();   // a new drag (or a click) starts over
        try { c.setPointerCapture(e.pointerId); } catch { /* gone */ }
      }
    });
    c.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      if (!d.selecting) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TOUCH_SLOP_PX) { window.clearTimeout(d.timer); this.drag = null; }   // a scroll
        return;
      }
      const cell = this.cellAt(e.clientX, e.clientY, true);
      if (!cell) return;
      const anchor = this.sel?.anchor ?? d.cell;
      if (this.sel && this.sel.focus.row === cell.row && this.sel.focus.col === cell.col) return;
      if (!this.sel && cell.row === d.cell.row && cell.col === d.cell.col) return;
      this.lastPointerSelected = true;
      this.setSelection(anchor, cell);
    });
    const end = (e: PointerEvent, cancel: boolean): void => {
      const d = this.drag;
      this.log('pointer', `${cancel ? 'cancel' : 'up'} ${d ? (d.selecting ? 'selecting' : 'click') : 'none'}`);
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      window.clearTimeout(d.timer);
      if (cancel) return;
      if (d.selecting && this.hasSelection()) { this.lastPointerSelected = true; return; }   // keep it for Copy
      if (d.selecting && d.touch) { this.clearSelection(); return; }                         // a long press without a drag
      this.clearSelection();
      this.clickAt(d.cell);
    };
    c.addEventListener('pointerup', (e) => end(e, false));
    c.addEventListener('pointercancel', (e) => end(e, true));
    // a touch drag that selects must not scroll the page or open the long-press menu
    c.addEventListener('touchmove', (e) => { if (this.drag?.selecting) e.preventDefault(); }, { passive: false });
    c.addEventListener('contextmenu', (e) => { if (this.drag || this.sel) e.preventDefault(); });
  }

  // ------------------------------------------------------------ cursor blink
  blinking(): boolean { return BLINK && !this.reducedMotion.matches; }

  /** A new 'on' phase (solid while typing), then the blink, if enabled. */
  private startBlink(): void {
    window.clearInterval(this.blinkTimer);
    const wasOff = !this.blinkOn;
    this.blinkOn = true;
    if (wasOff) this.paint();
    if (!this.blinking()) return;
    this.blinkTimer = window.setInterval(() => {
      if (document.hidden || !this.host.isConnected || this.host.offsetParent === null) return;   // not shown: no repaints
      this.blinkOn = !this.blinkOn;
      this.paint();
    }, BLINK_MS);
  }

  /** Blink state (tests). */
  blink_(): { enabled: boolean; on: boolean; ms: number } { return { enabled: this.blinking(), on: this.blinkOn, ms: BLINK_MS }; }

  async connect(): Promise<void> {
    // host/port are informational: the injected connect() ignores them.
    await this.session.connect('mvs', 0, { tn3270e: false });
  }

  onScreen(cb: () => void): void { this.screenCbs.push(cb); }

  /**
   * Log each host record (command, WCC, length, keyboard state before -> after) and each record we send (AID or
   * Query reply). Diagnosis only: wraps two methods of this Session instance, behaviour unchanged.
   */
  private hookRecords(): void {
    const s = this.session as unknown as { executeRecord?: (b: Uint8Array, w: unknown) => void; sendInbound?: (p: Uint8Array) => void };
    const exec = s.executeRecord, send = s.sendInbound;
    if (typeof exec === 'function') {
      s.executeRecord = (body: Uint8Array, wants: unknown): void => {
        const before = this.session.oia.keyboard;
        exec.call(this.session, body, wants);
        const c = body[0] ?? -1;
        const name = CMD_NAMES[c] ?? `x${c.toString(16)}`;
        const wcc = (name === 'W' || name === 'EW' || name === 'EWA') && body.length > 1 ? ` wcc=${body[1]!.toString(16)}` : '';
        const q = name === 'WSF' && body.length > 5 ? ` sf=${Array.from(body.subarray(3, 6), (x) => x.toString(16).padStart(2, '0')).join('')}` : '';
        const hex = Array.from(body.subarray(0, 24), (x) => x.toString(16).padStart(2, '0')).join('');
        this.log('host', `${name}${wcc}${q} len=${body.length} ${before}->${this.session.oia.keyboard} ${hex}${body.length > 24 ? '..' : ''}`);
        this.holdWatch(name, body, before);
        this.pwWatch(body);
      };
    }
    if (typeof send === 'function') {
      s.sendInbound = (p: Uint8Array): void => {
        const aid = p[0] ?? 0;
        // 0x88 = a structured field (Query reply); else the AID byte of a Read Modified / short read
        // AID, cursor and the first SBA only: never the field data (a password)
        this.log('send', `${aid === 0x88 ? 'SF(query reply)' : `aid=${aid.toString(16)} ${Array.from(p.subarray(0, 6), (x) => x.toString(16).padStart(2, '0')).join('')}`} len=${p.length}`);
        send.call(this.session, p);
      };
    }
  }

  /** KBD_HOLD: start, extend or end the hold after each host record. */
  private holdWatch(name: string, body: Uint8Array, before: string): void {
    if (!KBD_HOLD) return;
    const write = name === 'W' || name === 'EW' || name === 'EWA';
    const restore = (write && body.length > 1 && (body[1]! & 0x02) !== 0) || name === 'EAU';
    if (this.hold) {
      if (restore) { this.holdEnd('restore'); return; }
      window.clearTimeout(this.hold.timer);
      this.hold.timer = window.setTimeout(() => { this.kbd.holdTimeouts++; this.holdEnd('timeout'); }, HOLD_MS);
      return;
    }
    if (write && !restore && before === KeyboardState.EnterInhibit && this.session.oia.keyboard === KeyboardState.Unlocked) {
      this.kbd.holds++;
      this.hold = { timer: window.setTimeout(() => { this.kbd.holdTimeouts++; this.holdEnd('timeout'); }, HOLD_MS) };
      this.log('hold', `${name} without keyboard restore after enter-inhibit`);
    }
  }

  private holdEnd(why: string): void {
    if (!this.hold) return;
    window.clearTimeout(this.hold.timer);
    this.hold = null;
    if (why) this.log('hold-end', why);
    this.changed();   // plays back keys typed during the hold
  }

  /** A Write with keyboard restore whose orders put no character on the screen (SBA, SF, SFE, IC only). */
  private static bareUnlock(b: Uint8Array): boolean {
    if (b.length < 3 || (b[0] !== 0xf1 && b[0] !== 0x01) || !(b[1]! & 0x02)) return false;
    for (let i = 2; i < b.length;) {
      const o = b[i]!;
      if (o === 0x11) i += 3; else if (o === 0x1d) i += 2; else if (o === 0x13) i += 1;
      else if (o === 0x29) i += 2 + 2 * (b[i + 1] ?? 0);
      else return false;
    }
    return true;
  }

  /** Remember an Enter whose Read Modified carries a modified non-display field (see PW_RESEND). */
  private pwArm(): void {
    if (this.pw?.timer) window.clearTimeout(this.pw.timer);
    this.pw = null;
    const sc = this.session.screen;
    for (const f of sc.fields()) {
      if (f.protected || !f.hidden || !f.modified || f.length === 0) continue;
      let filled = 0; for (let i = 0, a = f.start; i < f.length; i++, a = sc.inc(a)) { const e = sc.cellAt(a).ebcdic; if (e !== 0 && e !== 0x40) filled++; }
      if (filled) { this.pw = { attr: f.attrAddr, records: 0, resent: false }; return; }
    }
  }

  private pwWatch(body: Uint8Array): void {
    const p = this.pw;
    if (!p) return;
    if (p.timer) { window.clearTimeout(p.timer); p.timer = undefined; }
    p.records++;
    if (p.records > 1 || !TermView.bareUnlock(body)) { this.pw = null; return; }   // the host answered: nothing to do
    this.kbd.pwBareUnlock++;
    this.log('pw-bare-unlock', p.resent ? 'after the resend' : '');
    if (p.resent || !PW_RESEND) { this.pw = null; return; }
    p.timer = window.setTimeout(() => {
      if (this.pw !== p) return;
      this.pw = null;
      const sc = this.session.screen, f = sc.fields().find((x) => x.attrAddr === p.attr);
      // only for a password prompt (TSO: 'ENTER CURRENT PASSWORD FOR <user>-'), never for other non-display input
      if (!this.session.isConnected() || this.hostLocked() || !f || !f.hidden || f.protected || !/PASSWORD/i.test(this.text())) { this.log('pw-resend-skipped'); return; }
      // 'nudge' (default): an Enter with no modified field. MVS keeps the password line in its typeahead queue; a new
      // input makes TSO hand the queue out in order, so the logon gets the password line and the empty line goes to
      // the first TSO read after the logon (an empty line does nothing there). 'resend' (test only): the password
      // again; then the queued copy reaches TSO after the logon as a command ('COMMAND PASS4U NOT FOUND').
      if (PW_MODE === 'resend') sc.setMDT(p.attr);
      this.kbd.pwResends++;
      this.log('pw-resend', PW_MODE);
      this.session.sendAID(AID.ENTER);
      this.pw = { attr: p.attr, records: 0, resent: true };   // watch the answer to the resend too (counted, not resent again)
      this.changed();
    }, PW_RESEND_MS);
  }

  /** The host holds the keyboard (not an operator error, which the next key may correct). */
  private hostLocked(): boolean {
    const o = this.session.oia;
    return this.session.isConnected() && ((o.isInhibited() && !o.isOperatorError()) || this.hold !== null);
  }

  private drain(): void {
    while (this.ahead.length && !this.hostLocked()) {
      const a = this.ahead.shift()!;
      this.kbd.replayed++;
      this.log('replay', a.kind === 'type' ? `type ${a.text.length}` : a.kind);
      this.apply(a);
    }
  }

  private changed(): void {
    if (this.ahead.length && !this.drainPending) {
      this.drainPending = true;
      queueMicrotask(() => { this.drainPending = false; this.drain(); });
    }
    for (const cb of this.screenCbs) cb();
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => { this.rafPending = false; this.render(); });
  }

  private render(): void {
    const snap = this.session.screen.snapshot();
    const base = drawList(snap, resolve(snap), this.atlas.geometry, this.scheme);
    if (!SHOW_OIA) { this.last = base; this.paint(); return; }
    // One OIA row under the screen; the separator line is drawn in its top pixel rows by paint().
    const y = snap.rows * this.atlas.geometry.cellHeight;
    const oia = this.session.oia;
    this.last = {
      ...base,
      oia: { y, ...oiaCells(oia, snap.cursor, snap.cols, y, this.atlas.geometry, this.scheme) },
      height: base.height + this.atlas.geometry.cellHeight,
    };
    this.paint();
  }

  /** Draw at an integer scale (pixel-exact glyphs), then let CSS fit the canvas into the tab. */
  paint(): void {
    const list = this.last;
    if (!list) { this.render(); return; }
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, this.host.clientWidth), bh = Math.max(1, this.host.clientHeight);
    const fit = Math.min(bw / list.width, bh / list.height);
    const scale = Math.max(1, Math.floor(fit * dpr));
    const W = list.width * scale, H = list.height * scale;
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    // fractional CSS fit (contain). On a narrow portrait screen the width limits the fit and leaves black space
    // above and below: the rows then grow taller (up to STRETCH_MAX times), which makes the text easier to read.
    const fitY = bh / list.height;
    const cssY = bw < NARROW_PX && fitY > fit ? Math.min(fitY, fit * STRETCH_MAX) : fit;
    this.canvas.style.width = `${Math.floor(list.width * fit)}px`;
    this.canvas.style.height = `${Math.floor(list.height * cssY)}px`;
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const opts = {
      atlas: this.atlas.geometry, scale, offsetX: 0, offsetY: 0, blank: this.atlas.blank,
      tinted: (color: Rgb): unknown | undefined => tintOf(this.atlas, color, this.repaintSoon),
    };
    blit(ctx, this.blinkOn ? list : { ...list, cells: list.cells.map((c) => (c.cursor ? { ...c, cursor: false } : c)) }, opts);
    if (list.oia) {
      blit(ctx, { cells: list.oia.cells, width: list.width, height: list.height }, opts);
      // separator line between the screen and the OIA (one font pixel, at the top of the OIA row)
      ctx.fillStyle = rgbCss(schemeRgb(this.scheme, Color.BLUE));
      ctx.fillRect(0, list.oia.y * scale, W, scale);
    }
    // the selection: inverse video over the cells (difference: works with every color scheme), as upstream renderer.ts
    const rect = this.selRect();
    if (rect) {
      const g = this.atlas.geometry;
      ctx.save();
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(rect.left * g.cellWidth * scale, rect.top * g.cellHeight * scale,
        (rect.right - rect.left + 1) * g.cellWidth * scale, (rect.bottom - rect.top + 1) * g.cellHeight * scale);
      ctx.restore();
    }
  }

  /** The OIA row as drawn, as text (tests); '' when hidden (?oia=0). */
  oiaText(): string { return this.last?.oia?.text ?? ''; }

  action(a: Action): void {
    if (a.kind === 'copy') { this.setSelection({ row: a.rect.top, col: a.rect.left }, { row: a.rect.bottom, col: a.rect.right }); void this.copySelection(); return; }
    if (a.kind === 'quit' || a.kind === 'toggleKeypad' || a.kind === 'transferForm') return;
    this.clearSelection();   // a key ends the selection (x3270, upstream renderer.ts)
    this.startBlink();       // solid while typing
    if (this.pw?.timer) { window.clearTimeout(this.pw.timer); this.pw = null; this.log('pw-resend-cancelled', a.kind); }
    if (a.kind === 'reset') {          // x3270: Reset also drops the typeahead
      this.holdEnd('reset');
      if (this.ahead.length) { this.kbd.flushed += this.ahead.length; this.log('flush', String(this.ahead.length)); this.ahead = []; }
    } else if (TYPEAHEAD && a.kind !== 'attn' && (this.ahead.length > 0 || this.hostLocked())) {
      if (this.ahead.length < AHEAD_MAX) {
        this.ahead.push(a); this.kbd.queued++; this.kbd.maxQueue = Math.max(this.kbd.maxQueue, this.ahead.length);
        this.log('queue', a.kind === 'type' ? `type ${a.text.length}` : a.kind);
      } else this.log('queue-full', a.kind);
      this.changed();
      return;
    }
    this.apply(a);
  }

  private apply(a: Action): void {
    const locked = this.hostLocked();
    if (a.kind === 'type') {
      // Keyboard.typeString stops at the first refused character: count what was lost (only with ?typeahead=0,
      // or an operator error such as a protected field)
      const k = this.session.keyboard;
      let n = 0;
      for (const ch of a.text) { if (!k.type(ch)) break; n++; }
      if (n < [...a.text].length) { this.kbd.refusedChars += [...a.text].length - n; this.log('refused', `${[...a.text].length - n} of ${[...a.text].length} chars`); }
    } else {
      if (locked && (a.kind === 'enter' || a.kind === 'clear' || a.kind === 'pf' || a.kind === 'pa')) { this.kbd.aidWhileLocked++; this.log('aid-locked', a.kind); }
      if (a.kind === 'enter' && !locked) this.pwArm();
      applyAction(this.session, a);
    }
    this.changed();
  }

  /** Typeahead state (tests). */
  ahead_(): { queued: number; pending: number; enabled: boolean; pwResend: string; held: boolean; kbdHold: boolean } & TermView['kbd'] {
    return { ...this.kbd, pending: this.ahead.length, enabled: TYPEAHEAD, pwResend: PW_MODE, held: this.hold !== null, kbdHold: KBD_HOLD };
  }

  /** Screen as text rows (non-display fields blanked). */
  text(): string {
    const snap = this.session.screen.snapshot();
    const r = resolve(snap);
    const rows: string[] = [];
    for (let y = 0; y < snap.rows; y++) {
      rows.push(r.slice(y * snap.cols, (y + 1) * snap.cols).map((c) => (c.hidden ? ' ' : c.text)).join(''));
    }
    return rows.join('\n');
  }

  /** the screen as a Read Buffer image (AID 0x60, cursor, buffer with SF orders), saved with each snapshot. */
  readBufferImage(): Uint8Array { return buildReadBuffer(this.session.screen, 0x60); }
  unlocked(): boolean { return this.session.isConnected() && this.session.oia.keyboard === KeyboardState.Unlocked && this.hold === null; }

  /** Operator-style input: cursor to the first input field, erase it, type, Enter. */
  typeCommand(cmd: string): boolean {
    if (!this.unlocked()) return false;
    const k = this.session.keyboard;
    k.home();
    k.eraseEOF();
    if (!k.typeString(cmd)) return false;
    this.action({ kind: 'enter' });
    return true;
  }
}
