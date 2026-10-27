// SPDX-License-Identifier: Apache-2.0
/**
 * Download and upload of MVS data sets with IND$FILE (3270 file transfer), from a TSO tab at READY.
 *
 * The page types "IND$FILE GET|PUT 'dsn' ..." for the visitor and runs the transfer with the vendored tn3270
 * engines (frontend/src/transferRun.ts: DFT, the structured-field protocol IND$FILE 2.0.5 speaks; CUT as its
 * fallback). The bytes stay in the page: a download becomes a browser file save, an upload is read from a file
 * picker. No server is involved; the host program is SYS2.CMDLIB(IND$FILE) (scripts/build.sh indfile).
 */
import type { Session } from '@tn3270/core';
import { TSO_DIALECT, type TransferFiles, type TransferRequest } from '../../vendor/tn3270/packages/frontend/src/transfer.js';
import { startTransfer } from '../../vendor/tn3270/packages/frontend/src/transferRun.js';

export type XferDirection = 'download' | 'upload';
export type XferFormat = 'text' | 'binary';
export type XferRecfm = 'F' | 'V' | 'U';

export interface XferOptions {
  direction: XferDirection;
  /** data set name as typed: SYS1.PARMLIB(IEASYS00), 'MVSCE02.TEST.DATA' (quotes optional: always fully qualified) */
  dsn: string;
  format: XferFormat;
  /** upload only */
  data?: Uint8Array;
  recfm?: XferRecfm;
  lrecl?: number;
  blksize?: number;
  /** primary space in tracks (upload of a new data set); default from the file size */
  tracks?: number;
  /** DFT frame size (advertised in the DDM query reply); default DFT_BUFFER */
  bufferSize?: number;
}

/**
 * DFT frame size. Measured on this system (TSO on MVS 3.8J VTAM): an upload frame of 10240 bytes ends the TSO
 * session (back to the logon screen, no message), 1000 bytes work. The engines' default of 16384 is too big for
 * the upload direction here.
 */
export const DFT_BUFFER = Number(new URLSearchParams(location.search).get('dftbuf') ?? 4096);

export interface XferResult { ok: boolean; bytes: number; data?: Uint8Array; error?: string; command?: string }

const QUAL = /^[A-Z#$@][A-Z0-9#$@-]{0,7}$/;
const MEMBER = /^[A-Z#$@][A-Z0-9#$@]{0,7}$/;

/** 'A.B(C)' from what the visitor typed, or an error text. */
export function normalizeDsn(raw: string): { dsn: string; name: string; member?: string } | { error: string } {
  let s = raw.trim().toUpperCase();
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) s = s.slice(1, -1);
  const m = /^([^()]+)(?:\(([^()]*)\))?$/.exec(s);
  if (!m) return { error: 'Enter a data set name like SYS1.PARMLIB(IEASYS00) or MVSCE02.TEST.DATA.' };
  const name = m[1]!, member = m[2];
  if (name.length > 44 || !name.split('.').every((q) => QUAL.test(q))) {
    return { error: `${name} is not a valid data set name (qualifiers of 1-8 letters, digits, #, $ or @, separated by dots; at most 44 characters).` };
  }
  if (member !== undefined && !MEMBER.test(member)) return { error: `${member} is not a valid member name (1-8 characters).` };
  return { dsn: member ? `${name}(${member})` : name, name, ...(member ? { member } : {}) };
}

/** A local file name for a downloaded data set: the member (or the last qualifiers), .txt or .bin */
export function localName(dsn: string, format: XferFormat): string {
  const n = normalizeDsn(dsn);
  const base = 'error' in n ? 'dataset' : (n.member ? `${n.name}.${n.member}` : n.name);
  return `${base.toLowerCase()}.${format === 'text' ? 'txt' : 'bin'}`;
}

/** TSO is at READY (line mode, keyboard free): the one place this types the command. */
export function atReady(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  return lines.length > 0 && /^\s*READY$/.test(lines[lines.length - 1]!);
}

/** The IND$FILE command and the request for the engines. */
export function buildCommand(o: XferOptions, dsn: string): { request: TransferRequest; command: string } {
  const up = o.direction === 'upload';
  const request: TransferRequest = {
    direction: up ? 'send' : 'receive', localFile: 'page', hostFile: `'${dsn}'`, host: 'tso',
    mode: o.format === 'text' ? 'ascii' : 'binary', cr: 'auto', exist: 'replace', bufferSize: o.bufferSize ?? DFT_BUFFER,
    ...(up ? {
      recfm: ({ F: 'fixed', V: 'variable', U: 'undefined' } as const)[o.recfm ?? (o.format === 'text' ? 'F' : 'U')],
      ...(o.lrecl ? { lrecl: o.lrecl } : {}),
      ...(o.blksize ? { blksize: o.blksize } : {}),
    } : {}),
  };
  let command = TSO_DIALECT.buildCommand(request);
  if (up) {
    // primary space for a new data set: the file size on 3350 tracks (about 13 KB a track with short blocks) and room to grow
    const tracks = o.tracks ?? Math.max(5, Math.ceil(((o.data?.length ?? 0) * 1.3) / 13000) + 2);
    command += ` TRACKS SPACE(${tracks},${Math.max(5, Math.ceil(tracks / 2))})`;
  }
  return { request, command };
}

/**
 * Run one transfer on a TSO session that is at READY. Resolves once, with the bytes for a download.
 * Errors that are found before anything is typed (not at READY, bad name) come back at once.
 */
export function runTransfer(session: Session, screenText: () => string, o: XferOptions, onProgress: (bytes: number) => void,
  setCancel?: (cancel: (() => void) | undefined) => void): Promise<XferResult> {
  const n = normalizeDsn(o.dsn);
  if ('error' in n) return Promise.resolve({ ok: false, bytes: 0, error: n.error });
  if (!session.isConnected()) return Promise.resolve({ ok: false, bytes: 0, error: 'The TSO terminal is not connected.' });
  if (!atReady(screenText())) {
    return Promise.resolve({ ok: false, bytes: 0, error: 'Go to TSO READY first: log on (LOGON MVSCE02, password PASS4U); in ISPF leave with =X, in KICKS with KSSF.' });
  }
  if (o.direction === 'upload' && !o.data) return Promise.resolve({ ok: false, bytes: 0, error: 'Choose a file to upload.' });
  const { request, command } = buildCommand(o, n.dsn);
  let received: Uint8Array | undefined;
  const files: TransferFiles = {
    exists: () => false,
    read: () => o.data!,
    write: (_p, b) => { received = b.slice(); },
    append: (_p, b) => { received = received ? new Uint8Array([...received, ...b]) : b.slice(); },
  };
  return new Promise((resolve) => {
    let watch: (() => void) | undefined;
    let finished = false, moved = 0, readyTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (r: XferResult): void => {
      if (finished) return;
      finished = true;
      if (watch) session.off('screen', watch);
      if (readyTimer !== undefined) clearTimeout(readyTimer);
      setCancel?.(undefined);
      resolve({ ...r, command });
    };
    // IND$FILE refuses some requests with a line and READY, not with a transfer frame (a data set that does not
    // exist: 'IND$FILE ended with RC=12'), and TSO answers a command it cannot find the same way. Stop at once
    // instead of the engines' 30 s frame timeout. The engines' cancel is NOT used here: at 24x80 it would answer
    // with a CUT abort (PF2) to a host that is already back at READY; the DFT registration is dropped instead,
    // and the abandoned run's own timers end it later without sending anything.
    const before = screenText();
    const fail = (error: string): void => { session.cancelDftTransfer(); done({ ok: false, bytes: 0, error }); };
    watch = (): void => {
      if (finished) return;
      const t = screenText();
      if (t === before) return;
      const tail = t.slice(Math.max(0, t.lastIndexOf('IND$FILE ')));
      const rc = /IND\$FILE ended with RC=(\d+)/i.exec(tail);
      if (rc) {
        const why = o.direction === 'download' ? `MVS could not read ${n.dsn}: check that it exists and that you may read it`
          : `MVS could not write ${n.dsn}: for a member, the library must exist; check the name and the attributes`;
        fail(`IND$FILE ended with RC=${rc[1]} (${why}).`); return;
      }
      const ikj = /IKJ\d{5}I [^\n]*/.exec(tail);
      if (ikj && /NOT FOUND|NOT AUTHORIZED|INVALID/.test(ikj[0])) { fail(ikj[0].trim()); return; }
      // back at READY with nothing transferred: give a late frame 3 s, then report what the screen says
      if (moved === 0 && readyTimer === undefined && atReady(tail.slice(tail.indexOf('\n') + 1))) {
        readyTimer = setTimeout(() => { if (!finished && moved === 0) fail(`IND$FILE ended without a transfer: ${tail.split('\n').map((l) => l.trim()).filter(Boolean).slice(1, -1).join(' ') || 'no message'}`); }, 3000);
      }
    };
    session.on('screen', watch);
    const run = startTransfer({
      session, files, request, command,
      onProgress: (s) => { const b = Number(/^(\d+)/.exec(s)?.[1] ?? 0); moved = b; onProgress(b); },
      onDone: (r) => {
        if (!r.ok) { done({ ok: false, bytes: r.bytes ?? 0, error: r.error ?? 'transfer failed' }); return; }
        done({ ok: true, bytes: r.bytes ?? 0, ...(o.direction === 'download' ? { data: received ?? new Uint8Array(0) } : {}) });
      },
    });
    if (!run.ok) { done({ ok: false, bytes: 0, error: run.error ?? 'could not start the transfer' }); return; }
    setCancel?.(run.cancel);
  });
}
