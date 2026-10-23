// SPDX-License-Identifier: Apache-2.0
/**
 * Byte transports for the 3270 sessions.
 *
 * The page never talks to a socket directly. Every terminal is a RawTerminal: a duplex byte
 * stream that carries the full telnet/TN3270 conversation (TTYPE negotiation included), exactly
 * the bytes a TCP connection to Hercules' CNSLPORT would carry. Two implementations:
 *
 *  - WebSocket (dev): binary WebSocket to websockify, which forwards to native Hercules.
 *  - wasm runtime: the runtime's openTerminal() (hw_term_open / hw_term_input /
 *    hw_term_read / hw_term_close in src/wasm/wasmsock.c), already shaped as a RawTerminal.
 *
 * toConnection() adapts a RawTerminal to the @tn3270/core Connection interface.
 */
import type { Connection } from '@tn3270/core';

/** Integration contract: what a machine backend hands the page for one terminal. */
export interface RawTerminal {
  /** Client -> Hercules bytes (telnet stream). Must not block; may queue. */
  write(bytes: Uint8Array): void;
  /** Register the (single) receiver for Hercules -> client bytes. Bytes must be a copy (not a SAB view). */
  onData(cb: (bytes: Uint8Array) => void): void;
  /** Optional: called once when Hercules closes the connection. */
  onClose?(cb: () => void): void;
  /** Client closes the connection (Hercules sees EOF). Idempotent. */
  close(): void;
  /** wasm runtime: the device number once known ('0010', '0400', ...). */
  readonly devnum?: string | null;
  /** wasm runtime: fn() returns the terminal's Read Buffer image; saved with each snapshot. */
  setScreenSource?(fn: () => Uint8Array): void;
}

/** Adapt a RawTerminal to the tn3270 Connection the Session expects. */
export function toConnection(raw: RawTerminal): Connection {
  let closed = false;
  const conn: Connection = {
    write: (b) => { if (!closed) raw.write(b); },
    close: () => { if (!closed) { closed = true; raw.close(); } },
    onData: undefined, onClose: undefined, onError: undefined,
  };
  raw.onData((b) => { if (!closed) conn.onData?.(b); });
  raw.onClose?.(() => { if (!closed) { closed = true; conn.onClose?.(); } });
  return conn;
}

/** RawTerminal over a binary WebSocket (websockify). Resolves when the socket is open. */
export function openWebSocket(url: string): Promise<RawTerminal> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url, ['binary']);
    ws.binaryType = 'arraybuffer';
    let dataCb: ((b: Uint8Array) => void) | undefined;
    let closeCb: (() => void) | undefined;
    const early: Uint8Array[] = [];
    let opened = false;
    const raw: RawTerminal = {
      write: (b) => { if (ws.readyState === WebSocket.OPEN) ws.send(b); },
      onData: (cb) => { dataCb = cb; for (const b of early.splice(0)) cb(b); },
      onClose: (cb) => { closeCb = cb; },
      close: () => { try { ws.close(); } catch { /* already closed */ } },
    };
    ws.onopen = () => { opened = true; ok(raw); };
    ws.onmessage = (e) => {
      const b = new Uint8Array(e.data as ArrayBuffer);
      if (dataCb) dataCb(b); else early.push(b);
    };
    ws.onerror = () => { if (!opened) fail(new Error(`WebSocket error: ${url}`)); };
    ws.onclose = () => { if (!opened) fail(new Error(`WebSocket closed before open: ${url}`)); else closeCb?.(); };
  });
}
