// SPDX-License-Identifier: Apache-2.0
/**
 * Machine backends: where Hercules runs and how the page reaches it.
 *
 *   ?backend=native  native Hercules on the dev host (UI development only),
 *                    terminals through websockify (?ws=, default ws://<page host>:8213/), hidden
 *                    Hercules commands and log through the dev server (/dev/cmd, /dev/log).
 *   ?backend=wasm    (default) Hercules compiled to WebAssembly in this page. The runtime module
 *                    (?runtime=, default ./runtime/mvs-runtime.js) must export createRuntime(),
 *                    see WasmRuntime below (the integration contract).
 */
import { openWebSocket, type RawTerminal } from './transport.js';

export interface Progress {
  /** 'dasd' (lazy DASD): boot working set progress after the loader phase (the IPL runs meanwhile). */
  phase: 'download' | 'prepare' | 'start' | 'dasd';
  /** Bytes done / total for 'download' and 'dasd' (lazy DASD: total = boot working set); undefined total = unknown. */
  loaded?: number;
  total?: number;
  /** Lazy DASD: bytes that came from the browser cache (Cache Storage) instead of the network. */
  cached?: number;
  /** 'dasd': the boot working set is complete. */
  done?: boolean;
  detail?: string;
}

export interface Machine {
  readonly kind: string;
  /** Download / prepare everything that is needed before the IPL. Resolves when terminals can be opened. */
  load(onProgress: (p: Progress) => void): Promise<void>;
  /** Open one terminal connection. The TTYPE (with @devnum suffix) is sent in-band by the tn3270 session. */
  openTerminal(): Promise<RawTerminal>;
  /** Start the IPL (after the 0010 console session is negotiated). */
  ipl(): Promise<void>;
  /** Hidden Hercules command (debug pane, power off). */
  command(cmd: string): Promise<void>;
  /** Hercules log lines (debug pane, IKT007I/HHC00809I fallbacks). historic = written before the page started. */
  onLog(cb: (line: string, historic: boolean) => void): void;
  /** Hercules quit after the MVS shutdown reached its disabled wait. */
  powerOff(): Promise<void>;
  /** Optional runtime statistics (wasm: heap peak, memory size, Worker count); for tests and ?debug=1. */
  stats?(): unknown;
  /** Persistence (wasm backend with a runtime that has it; undefined otherwise). */
  persist?: PersistApi;
  /** Snapshots: resume the saved running machine instead of an IPL (wasm runtime with snapshots; else undefined). */
  snapshot?: SnapshotApi;
}

/** what this load does (web/runtime mvs-runtime.js snapshotPlan()). */
export interface SnapshotPlan {
  enabled: boolean;
  /** true: open the terminals (TTYPE '<type>@<devnum>'), then resume() instead of ipl(). */
  resume: boolean;
  why: string;
  gen: string | null;
  savedAt: number | null;
  terminals: { devnum: string; ttype: string }[];
  /** The page's own data saved with the checkpoint (setPage()). */
  page: Record<string, unknown> | null;
}
export interface SnapshotApi {
  plan(): SnapshotPlan | null;
  resume(): Promise<{ ok: boolean; reason?: string; ms?: number }>;
  setPage(fn: () => unknown): void;
  pause(why: string): void;
  discard(why: string): Promise<unknown>;
  checkpoint(why: string): Promise<unknown>;
  stats(): unknown;
}

/** the machine is kept in this browser (OPFS shadow files, Web Lock, dirty marker). */
export interface PersistInfo {
  enabled: boolean;
  why?: string;
  dirtyStart: boolean;
  reset: boolean;
  resetWhy?: string;
  opfs?: { files: { name: string; size: number }[]; seeded: { name: string; size: number }[]; reset: boolean; waitMs: number; retries: number } | null;
  marker?: Record<string, unknown> | null;
  iplFail?: { reason: string; dirtyStart: boolean } | null;
  diskErrors?: string[];
  lock?: { ok: boolean; waitedMs: number } | null;
}
export interface PersistApi {
  info(): PersistInfo | null;
  /** Runtime state changes ('iplfail' {reason, dirtyStart}, 'stopped', 'ready', ...). */
  onState(cb: (state: string, info: Record<string, unknown>) => void): void;
  /** After a clean MVS shutdown + Hercules quit. */
  markClean(): void;
  /** The next load deletes the shadow files before Hercules starts. */
  requestReset(why: string): void;
  /** Resolves when Hercules has ended (false on timeout). */
  waitStopped(ms: number): Promise<boolean>;
  shadows(): Promise<{ name: string; size: number | null }[]>;
  /** Bytes of one shadow file (tests: copy out for cckdcdsk); only while Hercules is stopped. */
  shadowBytes(name: string): Promise<Uint8Array>;
  /** CCKD data not yet on the shadow files (dirty > 0), since when (performance.now()). */
  saveState(): SaveState;
  /** ask CCKD for an immediate flush + harden (page hidden / unload). false = not possible (old runtime, stopped). */
  flushNow(why: string): boolean;
}
export interface SaveState { dirty: number; userDirty?: number; since: number; flushes: number; devs?: string[]; unhardened?: string[]; supported: boolean }

/** Native Hercules on the dev host (scripts/ui-dev.sh + web/app/devserver.py). */
export class NativeDevMachine implements Machine {
  readonly kind = 'native';
  private logCbs: ((l: string, historic: boolean) => void)[] = [];
  private logOff = -1;
  private logTimer: number | undefined;
  constructor(private readonly wsUrl: string, private readonly devBase = '/dev') {}

  async load(onProgress: (p: Progress) => void): Promise<void> {
    onProgress({ phase: 'start', detail: 'native Hercules (dev)' });
    const r = await fetch(`${this.devBase}/status`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`dev server: /dev/status ${r.status}`);
    const s = await r.json() as { hercules: boolean; logSize: number };
    if (!s.hercules) throw new Error('native Hercules is not running (scripts/ui-dev.sh herc-start)');
  }
  openTerminal(): Promise<RawTerminal> { return openWebSocket(this.wsUrl); }
  async ipl(): Promise<void> { await this.command('ipl 150'); }
  async command(cmd: string): Promise<void> {
    const r = await fetch(`${this.devBase}/cmd`, { method: 'POST', body: cmd });
    if (!r.ok) throw new Error(`dev server: /dev/cmd ${r.status}`);
  }
  async powerOff(): Promise<void> {
    const r = await fetch(`${this.devBase}/quit`, { method: 'POST' });
    if (!r.ok) throw new Error(`dev server: /dev/quit ${r.status}`);
  }
  onLog(cb: (line: string, historic: boolean) => void): void {
    this.logCbs.push(cb);
    if (this.logTimer === undefined) this.logTimer = window.setInterval(() => { void this.pollLog(); }, 700);
  }
  private polling = false;
  private async pollLog(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      // First poll: start 64 KB before the end, so the debug pane shows recent history.
      const r = await fetch(`${this.devBase}/log?off=${this.logOff}`, { cache: 'no-store' });
      if (!r.ok) return;
      const next = Number(r.headers.get('X-Log-Next') ?? '0');
      const text = await r.text();
      const historic = this.logOff < 0;
      this.logOff = next;
      if (text) for (const l of text.split('\n')) if (l) for (const cb of this.logCbs) cb(l, historic);
    } catch { /* dev server gone */ } finally { this.polling = false; }
  }
}

/**
 * INTEGRATION CONTRACT with the wasm runtime (web/runtime/mvs-runtime.js).
 *
 * The runtime module is an ES module that exports
 *   createRuntime(opts: { onProgress(p: Progress): void, debug: boolean }): Promise<WasmRuntime>
 * createRuntime() resolves when the module is instantiated, the DASD chunks are in /dasd, the
 * config is in /conf, and Hercules' impl() has been started (or is ready to start) so that
 * hw_term_open() works. openTerminal() may be called BEFORE ipl(): wasmsock queues the connection
 * and the console thread accepts it on its first pselect.
 */
export interface WasmRuntime {
  /** hw_term_open("") + output drain on rAF; returns the RawTerminal shape {write, onData, onClose?, close}. */
  openTerminal(): RawTerminal | Promise<RawTerminal>;
  /** Start the IPL: hw_panel_command("ipl 150") (rc without IPL) or a no-op if the rc file IPLs. */
  ipl(): Promise<void> | void;
  /** hw_panel_command(cmd). */
  command(cmd: string): Promise<void> | void;
  /** Hercules log lines (log callback ring). */
  onLog?(cb: (line: string) => void): void;
  /** Optional statistics (web/runtime/mvs-runtime.js: heapPeak, sbrkPeak, memoryBytes, workersCreated, ...). */
  stats?(): unknown;
  /** Persistence (web/runtime/mvs-runtime.js with createRuntime({persist: true})). */
  persist?: PersistInfo | null;
  onState?(cb: (state: string, info: Record<string, unknown>) => void): void;
  markClean?(): unknown;
  requestReset?(why: string): unknown;
  waitState?(state: string, ms: number): Promise<unknown>;
  shadows?(): Promise<{ name: string; size: number | null }[]>;
  shadowBytes?(name: string): Promise<Uint8Array>;
  saveState?(): SaveState;
  flushNow?(why: string): boolean;
  state?: string;
  /** Snapshots (web/runtime/mvs-runtime.js with createRuntime({ persist: true }); off with ?snap=0). */
  snapshotPlan?(): SnapshotPlan | null;
  resumeMachine?(): Promise<{ ok: boolean; reason?: string; ms?: number }>;
  setSnapshotPage?(fn: () => unknown): void;
  snapshotPause?(why: string): void;
  snapshotDiscard?(why: string): Promise<unknown>;
  checkpoint?(why: string): Promise<unknown>;
  snapStats?(): unknown;
}

/** createRuntime() failed because another tab of this origin runs the machine (Web Lock 'mvs-machine'). */
export class LockedError extends Error { readonly code = 'locked'; }


export class WasmMachine implements Machine {
  readonly kind = 'wasm';
  private rt: WasmRuntime | undefined;
  private pendingLog: ((l: string, historic: boolean) => void)[] = [];
  persist?: PersistApi;
  snapshot?: SnapshotApi;
  private stateCbs: ((state: string, info: Record<string, unknown>) => void)[] = [];
  /** persist: keep the machine in this browser; false = memory shadows only (?persist=0). */
  constructor(private readonly runtimeUrl: string, private readonly debug: boolean, private readonly persistOn = true) {}
  async load(onProgress: (p: Progress) => void): Promise<void> {
    const mod = await import(/* @vite-ignore */ this.runtimeUrl) as {
      createRuntime(o: { onProgress(p: Progress): void; debug: boolean; persist?: boolean; onRuntime?(rt: WasmRuntime): void }): Promise<WasmRuntime>;
    };
    try {
      this.rt = await mod.createRuntime({ onProgress, debug: this.debug, persist: this.persistOn, onRuntime: (rt) => this.attach(rt) });
    } catch (e) {
      if ((e as { code?: string }).code === 'locked') throw new LockedError((e as Error).message);
      throw e;
    }
    this.attach(this.rt);
    for (const cb of this.pendingLog.splice(0)) this.rt.onLog?.((l) => cb(l, false));
  }
  private attached?: WasmRuntime;
  /** Called as soon as the runtime object exists (before the start), so that a failed start can still offer a reset. */
  private attach(rt: WasmRuntime): void {
    if (this.attached === rt || !rt.requestReset) return;
    this.attached = rt;
    rt.onState?.((s, i) => { for (const cb of this.stateCbs) cb(s, i); });
    this.persist = {
      info: () => rt.persist ?? null,
      onState: (cb) => { this.stateCbs.push(cb); },
      markClean: () => { rt.markClean?.(); },
      requestReset: (why) => { rt.requestReset?.(why); },
      waitStopped: async (ms) => { try { await rt.waitState?.('stopped', ms); return true; } catch { return false; } },
      shadows: async () => (await rt.shadows?.()) ?? [],
      shadowBytes: async (name) => { if (!rt.shadowBytes) throw new Error('no shadowBytes'); return rt.shadowBytes(name); },
      saveState: () => rt.saveState?.() ?? { dirty: 0, since: 0, flushes: 0, supported: false },
      flushNow: (why) => rt.flushNow?.(why) ?? false,
    };
    if (rt.snapshotPlan) {
      this.snapshot = {
        plan: () => rt.snapshotPlan?.() ?? null,
        resume: async () => (await rt.resumeMachine?.()) ?? { ok: false, reason: 'no resume in this runtime' },
        setPage: (fn) => rt.setSnapshotPage?.(fn),
        pause: (why) => rt.snapshotPause?.(why),
        discard: async (why) => rt.snapshotDiscard?.(why),
        checkpoint: async (why) => rt.checkpoint?.(why),
        stats: () => rt.snapStats?.() ?? null,
      };
    }
  }
  private need(): WasmRuntime { if (!this.rt) throw new Error('runtime not loaded'); return this.rt; }
  async openTerminal(): Promise<RawTerminal> { return await this.need().openTerminal(); }
  async ipl(): Promise<void> { await this.need().ipl(); }
  async command(cmd: string): Promise<void> { await this.need().command(cmd); }
  async powerOff(): Promise<void> { await this.need().command('quit'); }
  stats(): unknown { return this.rt?.stats?.() ?? null; }
  onLog(cb: (line: string, historic: boolean) => void): void { if (this.rt) this.rt.onLog?.((l) => cb(l, false)); else this.pendingLog.push(cb); }
}
