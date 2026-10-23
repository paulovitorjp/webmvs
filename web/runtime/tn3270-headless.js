// SPDX-License-Identifier: Apache-2.0
// tn3270-headless.js -- small TN3270 pieces without a UI.
//   TelnetDecoder  splits a telnet byte stream into commands and IAC EOR records
//   Screen3270     3270 buffer model (Write/Erase Write orders, fields, MDT, cursor) + text()
//   HeadlessTerminal  a client for tests and automation: plain TN3270 negotiation (TTYPE,
//                  BINARY, EOR; no TN3270E), screen, type(), enter(), clear(), pf(), waitFor()
// mvs-runtime.js uses TelnetDecoder + Screen3270 passively on the master console stream
// (IEA101A/IKT007I detection, consoleCommand()). The visitor page uses @tn3270/* for display.

// ---- EBCDIC (code page 037) ----------------------------------------------------------------
const CP037 =
  '\u0000\u0001\u0002\u0003\u009c\u0009\u0086\u007f\u0097\u008d\u008e\u000b\u000c\u000d\u000e\u000f' +
  '\u0010\u0011\u0012\u0013\u009d\u0085\u0008\u0087\u0018\u0019\u0092\u008f\u001c\u001d\u001e\u001f' +
  '\u0080\u0081\u0082\u0083\u0084\u000a\u0017\u001b\u0088\u0089\u008a\u008b\u008c\u0005\u0006\u0007' +
  '\u0090\u0091\u0016\u0093\u0094\u0095\u0096\u0004\u0098\u0099\u009a\u009b\u0014\u0015\u009e\u001a' +
  '  âäàáãåçñ¢.<(+|' +
  '&éêëèíîïìß!$*);¬' +
  '-/ÂÄÀÁÃÅÇÑ¦,%_>?' +
  'øÉÊËÈÍÎÏÌ`:#@\'="' +
  'Øabcdefghi«»ðýþ±' +
  '°jklmnopqrªºæ¸Æ¤' +
  'µ~stuvwxyz¡¿ÐÝÞ®' +
  '^£¥·©§¶¼½¾[]¯¨´×' +
  '{ABCDEFGHI­ôöòóõ' +
  '}JKLMNOPQR¹ûüùúÿ' +
  '\\÷STUVWXYZ²ÔÖÒÓÕ' +
  '0123456789³ÛÜÙÚ\u009f';
if (CP037.length !== 256) throw new Error('CP037 table length ' + CP037.length);
const TO_EBCDIC = new Map();
for (let i = 0x40; i < 256; i++) if (!TO_EBCDIC.has(CP037[i])) TO_EBCDIC.set(CP037[i], i);
export const ebcdicToChar = (b) => (b >= 0x40 ? CP037[b] : ' ');
export function toEbcdic(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = TO_EBCDIC.get(s[i]) ?? 0x6f;   // '?'
  return out;
}

// ---- 3270 addresses ------------------------------------------------------------------------
const ADDR6 = [0x40, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
  0x50, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
  0x60, 0x61, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f,
  0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f];
export const encodeAddr = (a) => (a < 4096 ? [ADDR6[(a >> 6) & 0x3f], ADDR6[a & 0x3f]] : [(a >> 8) & 0x3f, a & 0xff]);
const decodeAddr = (b1, b2) => ((b1 & 0xc0) === 0 ? ((b1 & 0x3f) << 8) | b2 : ((b1 & 0x3f) << 6) | (b2 & 0x3f));

// ---- telnet ---------------------------------------------------------------------------------
export const T = { IAC: 255, DONT: 254, DO: 253, WONT: 252, WILL: 251, SB: 250, SE: 240, EOR: 239,
  BINARY: 0, TTYPE: 24, OPT_EOR: 25, TN3270E: 40 };

// feed(bytes) -> calls onRecord(Uint8Array) for each 3270 record (IAC EOR), onCommand(cmd, opt)
// for WILL/WONT/DO/DONT, onSub(Uint8Array) for SB ... SE.
export class TelnetDecoder {
  constructor({ onRecord, onCommand, onSub } = {}) {
    this.onRecord = onRecord || (() => {}); this.onCommand = onCommand || (() => {}); this.onSub = onSub || (() => {});
    this.rec = []; this.sub = null; this.st = 0; this.cmd = 0;
  }
  feed(bytes) {
    for (const b of bytes) {
      switch (this.st) {
        case 0: if (b === T.IAC) this.st = 1; else (this.sub || this.rec).push(b); break;
        case 1:   // after IAC
          if (b === T.IAC) { (this.sub || this.rec).push(255); this.st = 0; }
          else if (b === T.EOR) { const r = Uint8Array.from(this.rec); this.rec = []; this.st = 0; this.onRecord(r); }
          else if (b >= T.WILL && b <= T.DONT) { this.cmd = b; this.st = 2; }
          else if (b === T.SB) { this.sub = []; this.st = 0; }
          else if (b === T.SE) { const s = Uint8Array.from(this.sub || []); this.sub = null; this.st = 0; this.onSub(s); }
          else this.st = 0;
          break;
        case 2: this.st = 0; this.onCommand(this.cmd, b); break;
      }
    }
  }
}

// ---- screen ---------------------------------------------------------------------------------
export class Screen3270 {
  constructor(rows = 24, cols = 80) { this.rows = rows; this.cols = cols; this.size = rows * cols; this.reset(); }
  reset() {
    this.buf = new Uint8Array(this.size);        // EBCDIC data (0 = null)
    this.fa = new Int16Array(this.size).fill(-1); // field attribute at position, else -1
    this.cursor = 0; this.writes = 0; this.locked = true;
  }
  // One outbound record (3270 command + data). Returns the command byte.
  process(r) {
    if (!r.length) return -1;
    const cmd = r[0];
    let i = 1;
    switch (cmd) {
      case 0xf5: case 0x05: case 0x7e: case 0x0d:          // EW, EWA
        this.buf.fill(0); this.fa.fill(-1); this.cursor = 0;   // fall through to Write
      case 0xf1: case 0x01: {                                // W
        const wcc = r[1] ?? 0; i = 2;
        if (wcc & 0x01) for (let p = 0; p < this.size; p++) if (this.fa[p] >= 0) this.fa[p] &= ~0x01;
        this.orders(r, i);
        if (wcc & 0x02) this.locked = false;
        this.writes++;
        break;
      }
      case 0x6f: case 0x0f:                                  // EAU
        for (let p = 0; p < this.size; p++) if (this.fa[p] < 0 && !this.protectedAt(p)) this.buf[p] = 0;
        for (let p = 0; p < this.size; p++) if (this.fa[p] >= 0) this.fa[p] &= ~0x01;
        this.locked = false; this.writes++;
        break;
      default: break;                                        // RB/RM/RMA/WSF: ignored here
    }
    return cmd;
  }
  orders(r, i) {
    let pos = this.cursor;
    const adv = () => { pos = (pos + 1) % this.size; };
    const put = (c) => { this.buf[pos] = c; this.fa[pos] = -1; adv(); };
    while (i < r.length) {
      const b = r[i++];
      switch (b) {
        case 0x1d: this.fa[pos] = r[i++]; this.buf[pos] = 0; adv(); break;              // SF
        case 0x29: { const n = r[i++]; let a = 0;                                          // SFE
          for (let k = 0; k < n; k++) { const t = r[i++], v = r[i++]; if (t === 0xc0) a = v; }
          this.fa[pos] = a; this.buf[pos] = 0; adv(); break; }
        case 0x2c: { const n = r[i++]; i += 2 * n; break; }                               // MF
        case 0x11: pos = decodeAddr(r[i], r[i + 1]) % this.size; i += 2; break;            // SBA
        case 0x28: i += 2; break;                                                          // SA
        case 0x13: this.cursor = pos; break;                                               // IC
        case 0x05: { const f = this.nextUnprotected(pos); pos = f < 0 ? 0 : f; break; }    // PT
        case 0x3c: { const to = decodeAddr(r[i], r[i + 1]) % this.size; i += 2;            // RA
          let c = r[i++]; if (c === 0x08) c = r[i++];
          do { put(c); } while (pos !== to); break; }
        case 0x12: { const to = decodeAddr(r[i], r[i + 1]) % this.size; i += 2;            // EUA
          do { if (this.fa[pos] < 0 && !this.protectedAt(pos)) this.buf[pos] = 0; adv(); } while (pos !== to); break; }
        case 0x08: put(r[i++]); break;                                                     // GE
        default: put(b); break;
      }
    }
  }
  fieldStart(p) {          // position of the attribute byte that controls p, or -1 (unformatted)
    for (let k = 0; k < this.size; k++) { const q = (p - k + this.size) % this.size; if (this.fa[q] >= 0) return q; }
    return -1;
  }
  protectedAt(p) { const f = this.fieldStart(p); return f >= 0 && (this.fa[f] & 0x20) !== 0; }
  fields() {               // [{start (attr pos), attr, data start, len}]
    const out = [];
    for (let p = 0; p < this.size; p++) if (this.fa[p] >= 0) out.push(p);
    return out.map((s, k) => {
      const e = out[(k + 1) % out.length];
      const len = ((e - s - 1 + this.size) % this.size) || (out.length === 1 ? this.size - 1 : 0);
      return { start: s, attr: this.fa[s], data: (s + 1) % this.size, len };
    });
  }
  nextUnprotected(from) {  // data start of the next unprotected field after 'from', or -1
    const fs = this.fields().filter((f) => !(f.attr & 0x20));
    if (!fs.length) return -1;
    const after = fs.find((f) => f.start >= from);
    return (after || fs[0]).data;
  }
  text() {
    let cur = this.fieldStart(this.size - 1);           // attribute in effect at position 0
    let attr = cur >= 0 ? this.fa[cur] : 0;
    const lines = [];
    for (let r = 0; r < this.rows; r++) {
      let s = '';
      for (let c = 0; c < this.cols; c++) {
        const p = r * this.cols + c;
        if (this.fa[p] >= 0) { attr = this.fa[p]; s += ' '; continue; }
        s += (attr & 0x0c) === 0x0c ? ' ' : ebcdicToChar(this.buf[p]);   // non-display field
      }
      lines.push(s.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }
  // Type text at the cursor into unprotected fields; sets MDT. Returns false if protected.
  type(str) {
    for (const ch of toEbcdic(str)) {
      if (this.fa[this.cursor] >= 0) { const n = this.nextUnprotected(this.cursor); if (n < 0) return false; this.cursor = n; }
      const f = this.fieldStart(this.cursor);
      if (f >= 0 && (this.fa[f] & 0x20)) return false;
      this.buf[this.cursor] = ch;
      if (f >= 0) this.fa[f] |= 0x01;
      this.cursor = (this.cursor + 1) % this.size;
    }
    return true;
  }
  // Inbound Read Buffer record: AID, cursor, then every buffer position (SF + attribute for a
  // field attribute position, else the character; nulls included).
  readBuffer(aid) {
    const out = [aid, ...encodeAddr(this.cursor)];
    for (let p = 0; p < this.size; p++) { if (this.fa[p] >= 0) out.push(0x1d, this.fa[p]); else out.push(this.buf[p]); }
    return Uint8Array.from(out);
  }
  // Inbound Read Modified record for an AID (without IAC EOR). Short read for CLEAR/PA keys.
  readModified(aid) {
    const out = [aid];
    if (aid === 0x6d || aid === 0x6c || aid === 0x6e || aid === 0x6b) return Uint8Array.from(out);
    out.push(...encodeAddr(this.cursor));
    const fs = this.fields();
    if (!fs.length) { for (const b of this.buf) if (b) out.push(b); return Uint8Array.from(out); }
    for (const f of fs) {
      if (!(f.attr & 0x01)) continue;
      out.push(0x11, ...encodeAddr(f.data));
      for (let k = 0; k < f.len; k++) { const b = this.buf[(f.data + k) % this.size]; if (b) out.push(b); }
    }
    return Uint8Array.from(out);
  }
}

// Wrap one inbound 3270 record for the wire: double IAC bytes, append IAC EOR.
export function frameRecord(rec) {
  const out = [];
  for (const b of rec) { out.push(b); if (b === 255) out.push(255); }
  out.push(T.IAC, T.EOR);
  return Uint8Array.from(out);
}

export const AID = { ENTER: 0x7d, CLEAR: 0x6d, PA1: 0x6c, PA2: 0x6e,
  PF: [0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0x7a, 0x7b, 0x7c] };

// WSF with a Read Partition (SF id 01) of type Query (02) or Query List (03)?
function isQuery(r) {
  for (let i = 1; i + 2 < r.length;) {
    const len = (r[i] << 8) | r[i + 1];
    if (r[i + 2] === 0x01 && (r[i + 4] === 0x02 || r[i + 4] === 0x03)) return true;
    if (len < 3) break; i += len;
  }
  return false;
}
// Minimal query reply (AID 0x88): Summary, Usable Area (12/14-bit addressing), Implicit Partition.
function queryReply(rows, cols) {
  const b2 = (n) => [(n >> 8) & 0xff, n & 0xff];
  return Uint8Array.from([0x88,
    0x00, 0x07, 0x81, 0x80, 0x80, 0x81, 0xa6,
    0x00, 0x17, 0x81, 0x81, 0x01, 0x00, ...b2(cols), ...b2(rows), 0x01, 0x00, 0x0a, 0x02, 0xe5, 0x00, 0x02, 0x00, 0x6f,
    0x09, 0x0c, ...b2(rows * cols),
    0x00, 0x11, 0x81, 0xa6, 0x00, 0x00, 0x0b, 0x01, 0x00, ...b2(cols), ...b2(rows), ...b2(cols), ...b2(rows)]);
}

// ---- headless client --------------------------------------------------------------------------
// conn: { write(Uint8Array), onData(cb), close() } (mvs-runtime openTerminal()).
export class HeadlessTerminal {
  constructor(conn, ttype, { rows = 24, cols = 80 } = {}) {
    this.conn = conn; this.ttype = ttype; this.screen = new Screen3270(rows, cols);
    this.listeners = new Set(); this.negotiated = false; this.closed = false;
    this.dec = new TelnetDecoder({
      onCommand: (c, o) => this.onCommand(c, o),
      onSub: (s) => { if (s[0] === T.TTYPE && s[1] === 1) this.send([T.IAC, T.SB, T.TTYPE, 0, ...new TextEncoder().encode(ttype), T.IAC, T.SE]); },
      onRecord: (r) => {
        const cmd = this.screen.process(r);
        if ((cmd === 0xf3 || cmd === 0x11) && isQuery(r))          // WSF Read Partition Query
          this.conn.write(frameRecord(queryReply(this.screen.rows, this.screen.cols)));
        else if (cmd === 0xf2 || cmd === 0x02)                      // Read Buffer: whole buffer
          this.conn.write(frameRecord(this.screen.readBuffer(0x60)));
        else if (cmd === 0xf6 || cmd === 0x06 || cmd === 0x6e || cmd === 0x0e)   // Read Modified (All)
          this.conn.write(frameRecord(this.screen.readModified(0x60)));
        this.negotiated = true;
        for (const l of this.listeners) l(this.screen);
      },
    });
    conn.onData((bytes) => this.dec.feed(bytes));
    if (conn.onClose) conn.onClose(() => { this.closed = true; for (const l of this.listeners) l(this.screen); });
  }
  send(arr) { this.conn.write(Uint8Array.from(arr)); }
  onCommand(c, o) {
    const ok = o === T.TTYPE || o === T.BINARY || o === T.OPT_EOR;
    if (c === T.DO) this.send([T.IAC, ok ? T.WILL : T.WONT, o]);
    else if (c === T.WILL) this.send([T.IAC, ok ? T.DO : T.DONT, o]);
  }
  onScreen(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  text() { return this.screen.text(); }
  sendAid(aid) {
    this.conn.write(frameRecord(this.screen.readModified(aid)));
    this.screen.locked = true;
    if (aid === AID.CLEAR) { this.screen.buf.fill(0); this.screen.fa.fill(-1); this.screen.cursor = 0; }
  }
  type(s) { return this.screen.type(s); }
  enter() { this.sendAid(AID.ENTER); }
  clear() { this.sendAid(AID.CLEAR); }
  pf(n) { this.sendAid(AID.PF[n]); }
  // Resolve when test(text) is true (checked on every screen update), reject after ms.
  waitFor(test, ms = 60000) {
    const f = typeof test === 'function' ? test : (t) => test.test(t);
    return new Promise((resolve, reject) => {
      if (f(this.text())) return resolve(this.text());
      const off = this.onScreen(() => { if (f(this.text())) { off(); clearTimeout(to); resolve(this.text()); } });
      const to = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${test}; screen:\n${this.text()}`)); }, ms);
    });
  }
  close() { this.closed = true; this.conn.close(); }
}
