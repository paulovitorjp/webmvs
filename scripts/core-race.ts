// SPDX-License-Identifier: Apache-2.0
// core-race.ts -- the page's own 3270 terminal code (the vendored @tn3270/core
// Session, as web/app/src/termview.ts uses it, without the canvas) against a NATIVE Hercules 3270 port, with an exact
// delay between the password prompt and the password. Same query reply, same Read Modified as the page.
// Build + run (on the host, from the repo):
//   web/app/node_modules/.bin/esbuild scripts/core-race.ts --bundle --platform=node --format=esm \
//     --alias:@tn3270/core=./web/vendor/tn3270/packages/core/src/index.ts --outfile=/tmp/core-race.mjs
//   node /tmp/core-race.mjs <host:port> <delays-ms> <logons per delay> [--user U --pw P]
import net from 'node:net';
import { Session, AID, type Connection } from '@tn3270/core';

const [HP, DL = '0', PER = '5'] = process.argv.slice(2);
const arg = (k: string, d: string): string => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const USER = arg('user', 'MVSCE02'), PW = arg('pw', 'PASS4U');
const [host, port] = HP!.split(':');
const t0 = performance.now();
const recs: string[] = [];
const hex = (b: Uint8Array, n: number): string => Array.from(b.subarray(0, n), (x) => x.toString(16).padStart(2, '0')).join('');
const session = new Session({
  terminalType: 'IBM-3278-2-E', tn3270e: false,
  connect: () => new Promise<Connection>((ok, no) => {
    const s = net.connect(+port!, host!);
    const c: Connection = { write: (b) => { s.write(b); }, close: () => { s.end(); }, onData: undefined, onClose: undefined, onError: undefined };
    s.on('data', (d) => c.onData?.(new Uint8Array(d)));
    s.on('close', () => c.onClose?.());
    s.on('error', (e) => c.onError?.(e));
    s.once('connect', () => ok(c)); s.once('error', no);
  }),
});
// the same record log as the page's TermView (web/app/src/termview.ts hookRecords)
const ss = session as unknown as { executeRecord: (b: Uint8Array, w: unknown) => void; sendInbound: (p: Uint8Array) => void };
const ex = ss.executeRecord, se = ss.sendInbound;
ss.executeRecord = (b, w) => { const k0 = session.oia.keyboard; ex.call(session, b, w); recs.push(`${(performance.now() - t0).toFixed(1)} host ${hex(b, 20)} len=${b.length} ${k0}->${session.oia.keyboard}`); };
ss.sendInbound = (p) => { recs.push(`${(performance.now() - t0).toFixed(1)} send ${hex(p, 6)} len=${p.length}`); se.call(session, p); };
const listeners = new Set<() => void>();
session.on('screen', () => { for (const l of [...listeners]) l(); });
const text = (): string => { const r: string[] = []; for (let i = 1; i <= session.screen.rows; i++) r.push(session.screen.rowText(i)); return r.join('\n'); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function waitRe(re: RegExp, ms: number): Promise<boolean> {
  return new Promise((ok) => {
    if (re.test(text())) return ok(true);
    const f = (): void => { if (re.test(text())) { listeners.delete(f); clearTimeout(to); ok(true); } };
    listeners.add(f);
    const to = setTimeout(() => { listeners.delete(f); ok(false); }, ms);
  });
}
async function unlocked(ms = 30000): Promise<boolean> { const e = Date.now() + ms; while (Date.now() < e) { if (!session.oia.isInhibited()) return true; await sleep(2); } return false; }
function typeEnter(s: string): void { session.keyboard.typeString(s); session.sendAID(AID.ENTER); }
async function toLogon(): Promise<boolean> {
  for (let k = 0; k < 6; k++) {
    if (/TSO Logon ===>/.test(text())) return true;
    await unlocked();
    if (/READY\s*$/m.test(text())) { session.sendAID(AID.CLEAR); await unlocked(); typeEnter('logoff'); await sleep(1500); continue; }
    session.sendAID(AID.CLEAR); await waitRe(/TSO Logon ===>|CLEAR the screen/, 5000);
    if (!/TSO Logon ===>/.test(text())) { await unlocked(); session.sendAID(AID.ENTER); await waitRe(/TSO Logon ===>/, 5000); }
  }
  return /TSO Logon ===>/.test(text());
}
await session.connect(host!, +port!, { tn3270e: false });
await waitRe(/CLEAR the screen|TSO Logon ===>|Hercules/, 15000);
const total = { logons: 0, stalls: 0 };
for (const d of DL.split(',').map(Number)) {
  let st = 0, n = 0;
  for (let i = 1; i <= +PER; i++) {
    if (!await toLogon()) { console.log(`no logon screen: ${text().split('\n').slice(0, 3).join('|')}`); process.exit(2); }
    await unlocked();
    const r0 = recs.length;
    typeEnter(`logon ${USER.toLowerCase()}`);
    if (!await waitRe(/ENTER CURRENT PASSWORD/, 60000)) { console.log('no prompt'); continue; }
    const shown = performance.now();
    if (d > 0) await sleep(d);
    const lockedAtType = session.oia.isInhibited();
    await unlocked();
    const typed = performance.now();
    typeEnter(PW); n++; total.logons++;
    let ok = await waitRe(/READY\s*$|\*\*\*\s*$/m, 15000); let res = 'ok';
    if (!ok) {
      st++; total.stalls++; res = 'STALL';
      console.log(`STALL d=${d} i=${i}: screen ${text().split('\n').slice(0, 4).map((l) => l.trim()).join('|')}`);
      for (const l of recs.slice(r0)) console.log(`   ${l}`);
      await unlocked(); typeEnter(PW); ok = await waitRe(/READY\s*$|\*\*\*\s*$/m, 30000); res += ok ? ' retyped-ok' : ' retyped-stuck';
    }
    for (let k = 0; k < 8 && !/READY\s*$/m.test(text()); k++) { await unlocked(); session.sendAID(AID.ENTER); await waitRe(/READY\s*$|\*\*\*\s*$/m, 15000); }
    console.log(`LOGON d=${d} i=${i} typed ${(typed - shown).toFixed(1)} ms after the prompt${lockedAtType ? ' (keyboard was locked)' : ''}: ${res}`);
    await unlocked(); session.sendAID(AID.CLEAR); await unlocked(); typeEnter('logoff'); await sleep(1500);
  }
  console.log(`DELAY d=${d} logons=${n} stalls=${st}`);
}
console.log(`CORERACE ${JSON.stringify(total)}`);
process.exit(0);
