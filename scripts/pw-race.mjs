// SPDX-License-Identifier: Apache-2.0
// pw-race.mjs -- TSO logon loop against a NATIVE Hercules 3270 port with an exact
// delay between the password prompt on the screen and the password + Enter (no x3270if process overhead), to find the
// time window in which MVS loses the password. Uses the headless TN3270 client of web/runtime/tn3270-headless.js
// (it answers the Query like the page does).
// Usage: node scripts/pw-race.mjs <host:port> <delays-ms comma list> <logons per delay> [--user U --pw P] [--trace]
// Prints "LOGON d=<ms> i=<n> ok|STALL ..." per logon, "DELAY d=<ms> logons=<n> stalls=<k>" per delay and on a stall
// the host records (command, WCC, length, hex prefix) from the 'logon' Enter on.
import net from 'node:net';
import { HeadlessTerminal } from '../web/runtime/tn3270-headless.js';
const [HP, DL = '0', PER = '5'] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const USER = arg('user', 'MVSCE02'), PW = arg('pw', 'PASS4U'), EARLY = process.argv.includes('--early');
const [host, port] = HP.split(':');
const sock = net.connect(+port, host);
await new Promise((ok, no) => { sock.once('connect', ok); sock.once('error', no); });
const conn = { write: (b) => sock.write(b), onData: (cb) => sock.on('data', (d) => cb(new Uint8Array(d))), close: () => sock.end(), onClose: (cb) => sock.on('close', cb) };
const term = new HeadlessTerminal(conn, 'IBM-3278-2-E');
// record log: wrap the decoder's record callback
const recs = []; const t0 = performance.now();
const origOn = term.dec.onRecord;
term.dec.onRecord = (r) => { recs.push(`${(performance.now() - t0).toFixed(1)} host ${Array.from(r.subarray(0, 20), (x) => x.toString(16).padStart(2, '0')).join('')} len=${r.length}`); origOn(r); };
const origWrite = conn.write;
conn.write = (b) => { recs.push(`${(performance.now() - t0).toFixed(1)} send ${Array.from(b.subarray(0, 4), (x) => x.toString(16).padStart(2, '0')).join('')} len=${b.length}`); origWrite(b); };
term.conn = conn;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = () => term.text();
const waitRe = (re, ms) => term.waitFor(re, ms).then(() => true, () => false);
async function toLogonScreen() {
  for (let k = 0; k < 5; k++) {
    if (/TSO Logon ===>/.test(txt())) return true;
    if (/READY\s*$/m.test(txt())) { term.clear(); await sleep(300); term.type('logoff'); term.enter(); await sleep(1500); continue; }
    term.clear(); if (await waitRe(/TSO Logon ===>|CLEAR the screen/, 5000)) { if (/TSO Logon ===>/.test(txt())) return true; term.enter(); await waitRe(/TSO Logon ===>/, 5000); }
  }
  return /TSO Logon ===>/.test(txt());
}
await waitRe(/CLEAR the screen|TSO Logon ===>|Hercules/, 15000);
const total = { logons: 0, stalls: 0 };
for (const d of DL.split(',').map(Number)) {
  let st = 0, n = 0;
  for (let i = 1; i <= +PER; i++) {
    if (!await toLogonScreen()) { console.log(`no logon screen: ${txt().split('\n').slice(0, 3).join('|')}`); process.exit(2); }
    const r0 = recs.length;
    term.type(`logon ${USER.toLowerCase()}`); term.enter();
    // --early: type the password at the first keyboard unlock after the Enter (the blank Erase/Write before the
    // Query and the prompt), i.e. BEFORE the prompt: shows what MVS does with input that arrives before its TGET.
    if (EARLY) {
      const w0 = term.screen.writes;
      const at = await new Promise((ok) => {
        const off = term.onScreen(() => { if (term.screen.writes > w0 && !term.screen.locked) { off(); ok(performance.now()); } });
        setTimeout(() => { off(); ok(null); }, 30000);
      });
      term.type(PW); term.enter(); n++; total.logons++;
      const got = await waitRe(/ENTER CURRENT PASSWORD|READY\s*$/m, 15000);
      await sleep(3000);
      const t = txt(); const st2 = /READY\s*$|\*\*\*\s*$/m.test(t) ? 'logged on' : /ENTER CURRENT PASSWORD/.test(t) ? 'prompt shown, early password not used' : 'other';
      console.log(`EARLY i=${i} typed at the first unlock (${at ? 'ok' : 'none'}): ${st2}; screen ${t.split('\n').slice(0, 3).map((l) => l.trim()).join('|')}`);
      for (const l of recs.slice(r0)) console.log(`   ${l}`);
      if (!/READY\s*$/m.test(t)) { if (/ENTER CURRENT PASSWORD/.test(t)) { term.type(PW); term.enter(); } await waitRe(/READY\s*$|\*\*\*\s*$/m, 30000);
        for (let k = 0; k < 8 && !/READY\s*$/m.test(txt()); k++) { term.enter(); await waitRe(/READY\s*$|\*\*\*\s*$/m, 15000); } }
      term.clear(); await sleep(300); term.type('logoff'); term.enter(); await sleep(1500);
      continue;
    }
    // react on the screen update that shows the prompt (same tick for d=0)
    const shown = await new Promise((ok) => {
      if (/ENTER CURRENT PASSWORD/.test(txt())) return ok(performance.now());
      const off = term.onScreen(() => { if (/ENTER CURRENT PASSWORD/.test(txt())) { off(); ok(performance.now()); } });
      setTimeout(() => { off(); ok(null); }, 60000);
    });
    if (shown === null) { console.log('no password prompt'); continue; }
    if (d > 0) await sleep(d);
    const typed = performance.now();
    term.type(PW); term.enter(); n++; total.logons++;
    let ok = await waitRe(/READY\s*$|\*\*\*\s*$/m, 15000), res = 'ok';
    if (!ok) {
      st++; total.stalls++; res = 'STALL';
      console.log(`STALL d=${d} i=${i}: screen ${txt().split('\n').slice(0, 4).map((l) => l.trim()).join('|')}`);
      for (const l of recs.slice(r0)) console.log(`   ${l}`);
      term.type(PW); term.enter(); ok = await waitRe(/READY\s*$|\*\*\*\s*$/m, 30000); res += ok ? ' retyped-ok' : ' retyped-stuck';
    }
    for (let k = 0; k < 8 && !/READY\s*$/m.test(txt()); k++) { term.enter(); await waitRe(/READY\s*$|\*\*\*\s*$/m, 15000); }
    console.log(`LOGON d=${d} i=${i} typed ${(typed - shown).toFixed(1)} ms after the prompt: ${res}`);
    term.clear(); await sleep(300); term.type('logoff'); term.enter(); await sleep(1500);
  }
  console.log(`DELAY d=${d} logons=${n} stalls=${st}`);
}
console.log(`PWRACE ${JSON.stringify(total)}`);
term.close(); process.exit(0);
