// SPDX-License-Identifier: Apache-2.0
// mvs-persist.js -- the visitor's machine is kept in this browser.
//
// What is persistent: the CCKD shadow files (sf=) of all volumes, on the WasmFS OPFS backend
// (mounted by wasm_main --opfs=/opfs; files in the OPFS directory 'shadow/'). The base volumes are
// read-only and are never written.
//
// Pieces in this module (used by mvs-runtime.js; the page uses them through the runtime):
//   acquireMachineLock()  Web Lock 'mvs-machine': only one tab per origin runs the machine (OPFS
//                         sync access handles are exclusive, and two Hercules on the same shadows
//                         would destroy them). A second tab gets { ok: false } and must not start.
//   MachineMarker         the dirty-start marker in localStorage: 'running' from the moment Hercules
//                         opens the shadows until a clean shutdown; a load that finds 'running'
//                         is a dirty start (the last session ended without 'Shut down').
//                         Also: resetPending ('Reset machine' asked; done by the next load before
//                         Hercules starts) and counters.
//   opfsAvailable(), listShadows(), readShadow()   small helpers (debug pane, tests).

export const LOCK_NAME = 'mvs-machine';
export const MARKER_KEY = 'mvs-machine-state';

// Take the machine lock for the life of this page. Returns { ok, waitedMs, release, api }.
// First try ifAvailable. If the lock is held, wait up to waitMs: after a reload, the old page in
// the same tab can hold it for a short time while it is being torn down. A tab that is really
// running MVS holds it for its whole life, so the wait then times out.
export async function acquireMachineLock({ waitMs = 3000, name = LOCK_NAME } = {}) {
  const t0 = performance.now();
  if (!globalThis.navigator || !navigator.locks) return { ok: true, waitedMs: 0, release: () => {}, api: false };
  let release;
  const held = new Promise((r) => { release = r; });
  const got = await new Promise((resolve) => {
    navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return undefined; }
      resolve(true);
      return held;                                   // held until release() or the page ends
    }).catch(() => resolve(false));
  });
  if (got) return { ok: true, waitedMs: 0, release, api: true };
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), waitMs);
  const got2 = await new Promise((resolve) => {
    navigator.locks.request(name, { signal: ac.signal }, () => { clearTimeout(to); resolve(true); return held; })
      .catch(() => resolve(false));
  });
  const waitedMs = Math.round(performance.now() - t0);
  return got2 ? { ok: true, waitedMs, release, api: true } : { ok: false, waitedMs, api: true };
}

const DEFAULT_MARKER = {
  v: 1,
  state: 'new',            // 'new' | 'running' | 'clean'
  sessions: 0,             // Hercules starts on these shadows (since the last reset)
  cleanShutdowns: 0,
  dirtyStarts: 0,          // starts that found state 'running'
  resets: 0,               // shadows deleted ('Reset machine'), all time
  autoResets: 0,           // of these: accepted from the automatic offer after a failed IPL
  resetPending: false,
  resetWhy: '',
  lastStart: 0, lastIplOk: 0, lastClean: 0, updated: 0,
};

export class MachineMarker {
  constructor(key = MARKER_KEY, storage = globalThis.localStorage) { this.key = key; this.storage = storage; }
  read() {
    try { return { ...DEFAULT_MARKER, ...JSON.parse(this.storage.getItem(this.key) || '{}') }; } catch { return { ...DEFAULT_MARKER }; }
  }
  write(patch) {
    const m = { ...this.read(), ...(typeof patch === 'function' ? patch(this.read()) : patch), updated: Date.now() };
    try { this.storage.setItem(this.key, JSON.stringify(m)); } catch { /* storage full or blocked */ }
    return m;
  }
  clear() { try { this.storage.removeItem(this.key); } catch { /* ignore */ } }
}

// True if OPFS works in this context (it does not in some private windows).
export async function opfsAvailable() {
  try { if (!navigator.storage || !navigator.storage.getDirectory) return false; await navigator.storage.getDirectory(); return true; } catch { return false; }
}

// [{ name, size }] of the files in OPFS <dir> (sizes only for files that no access handle holds).
export async function listShadows(dir = 'shadow') {
  const out = [];
  try {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle(dir);
    for await (const [name, h] of d.entries()) {
      if (h.kind !== 'file') continue;
      let size = null;
      try { size = (await h.getFile()).size; } catch { /* busy */ }
      out.push({ name, size });
    }
  } catch { /* no dir */ }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Bytes of one shadow file (tests: copy the shadows out for cckdcdsk). Only while Hercules is stopped.
export async function readShadow(name, dir = 'shadow') {
  const root = await navigator.storage.getDirectory();
  const d = await root.getDirectoryHandle(dir);
  const f = await (await d.getFileHandle(name)).getFile();
  return new Uint8Array(await f.arrayBuffer());
}
