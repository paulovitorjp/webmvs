// SPDX-License-Identifier: Apache-2.0
// relogon.mjs -- TSO logon / logoff loop on one page (Playwright), to see if a logon stalls.
// Usage: node scripts/relogon.mjs <chromium|firefox> <url> <n> [--wait-s <s after IKT007I before the 1st logon>]
// Uses the page's test API (window.mvs.type/act/text), not keyboard events. Prints one line per logon:
// "LOGON i <ms from 'logon' Enter to READY>" and a final "RELOGON <browser> max=<ms> stalls(>30 s)=<k>".
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.join(here, '..', 'web', 'app'), 'package.json'));
const pw = require('playwright');
const [B, URL0, N = '10'] = process.argv.slice(2);
const i0 = process.argv.indexOf('--wait-s'); const WAIT_S = i0 > 0 ? Number(process.argv[i0 + 1]) : 0;
const br = await pw[B].launch(B === 'firefox' ? { firefoxUserPrefs: { 'dom.max_script_run_time': 0 } } : {});
const pg = await br.newPage();
const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(1);
await pg.goto(URL0);
await pg.waitForFunction(() => (window.mvs?.herclog?.() ?? []).some(([, l]) => /IKT007I/.test(l)), null, { timeout: 300000, polling: 200 });
console.log(`[${T()}] IKT007I`);
if (WAIT_S) await pg.waitForTimeout(WAIT_S * 1000);
const txt = () => pg.evaluate(() => window.mvs.text('tso1'));
const unl = () => pg.evaluate(() => window.mvs.unlocked('tso1'));
const typeEnter = (s) => pg.evaluate((x) => { window.mvs.type('tso1', x); window.mvs.act('tso1', { kind: 'enter' }); }, s);
async function waitT(re, ms) { const e = Date.now() + ms; for (;;) { const t = await txt(); if (re.test(t)) return t; if (Date.now() > e) return null; await pg.waitForTimeout(100); } }
async function waitU(ms) { const e = Date.now() + ms; while (Date.now() < e) { if (await unl()) return true; await pg.waitForTimeout(50); } return false; }
// read MVS storage with the hidden Hercules 'v' command (output from the page's Hercules log)
async function vread(addr, n) {
  const base = addr & ~15, out = [];
  await pg.evaluate((c) => globalThis.__mvsRuntime.command(c), `v ${base.toString(16)}.${(n + (addr - base) + 15) & ~15}`);
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const lines = await pg.evaluate(() => (window.mvs.herclog() ?? []).slice(-200).map(([, l]) => l));
    const words = {};
    for (const l of lines) { const m = /V:([0-9A-F]{8})((?:\s+[0-9A-F]{8}){1,4})/.exec(l); if (m) { const a0 = parseInt(m[1], 16); m[2].trim().split(/\s+/).forEach((w, j) => { words[a0 + 4 * j] = parseInt(w, 16); }); } }
    let ok = true; for (let a = base; a < addr + n; a += 4) if (words[a] === undefined) { ok = false; break; } else out[(a - base) / 4] = words[a];
    if (ok) return (o) => out[((addr - base) + o) / 4] >>> 0;
    await pg.waitForTimeout(200);
  }
  return null;
}
async function mvsDiag() {
  try {
    const cvt = (await vread(0x10, 4))(0) & 0x7FFFFFFF;
    const asvt = (await vread(cvt + 0x22C, 4))(0) & 0x7FFFFFFF;
    const maxu = (await vread(asvt + 0x204, 4))(0);
    for (let k = 0; k < Math.min(maxu, 16); k++) {
      const e = (await vread(asvt + 0x210 + 4 * k, 4))(0);
      if (e & 0x80000000 || !e) continue;
      const nm = (await vread(e + 0xB0, 4))(0) & 0x7FFFFFFF; if (!nm) continue;
      const nw = await vread(nm, 8); const name = [nw(0), nw(4)].map((x) => x.toString(16).padStart(8, '0')).join('');
      if (name !== 'd4e5e2c3c5f0f240') continue;     // 'MVSCE02 ' in EBCDIC
      const a = await vread(e, 0xC0); const oucb = a(0x90) & 0x7FFFFFFF; const o = await vread(oucb, 0x58);
      const hex = (f, off, len) => Array.from({ length: len / 4 }, (_, j) => f(off + 4 * j).toString(16).padStart(8, '0')).join(' ');
      return `ASCB ${e.toString(16)} +60: ${hex(a, 0x60, 16)} DPH ${(a(0x28) & 0xFFFF).toString(16)}; OUCB ${oucb.toString(16)} eye ${o(0).toString(16)} +10: ${hex(o, 0x10, 16)} +50: ${hex(o, 0x50, 8)}`;
    }
    return 'no ASCB for MVSCE02';
  } catch (e) { return `diag error ${e}`; }
}
let max = 0, stalls = 0;
for (let i = 1; i <= +N; i++) {
  let t = await waitT(/TSO Logon ===>|CLEAR the screen|LOGON/, 120000);
  if (t && !/TSO Logon ===>/.test(t)) { await waitU(30000); await pg.evaluate(() => window.mvs.act('tso1', { kind: 'enter' })); await waitT(/TSO Logon ===>/, 60000); }
  await waitU(30000); await pg.waitForTimeout(300);
  const a = Date.now(); await typeEnter('logon mvsce02');
  const pwp = await waitT(/ENTER CURRENT PASSWORD/, 300000);
  const b = Date.now();
  await waitU(30000);
  const typed = await pg.evaluate(() => window.mvs.type('tso1', 'PASS4U'));
  await pg.evaluate(() => window.mvs.act('tso1', { kind: 'enter' }));
  let r = await waitT(/READY\s*$|\*\*\*\s*$|IKJ56/m, 20000);
  if (!r) {   // stall: dump the MVS state of the TSO user (OUCB), then type the password again (input lost?)
    const d = await mvsDiag();
    console.log(`[${T()}] STALL logon ${i}: typeString=${typed} oia=${JSON.stringify(await pg.evaluate(() => window.mvs.oia('tso1')))} ${d}`);
    const typed2 = await pg.evaluate(() => window.mvs.type('tso1', 'PASS4U')); await pg.evaluate(() => window.mvs.act('tso1', { kind: 'enter' }));
    const t2 = Date.now(); r = await waitT(/READY\s*$|\*\*\*\s*$|IKJ56/m, 280000);
    console.log(`[${T()}] after retyping the password (typeString=${typed2}): ${r ? `progress after ${Date.now() - t2} ms` : 'still nothing'}; ${await mvsDiag()}`);
  }
  for (let k = 0; k < 40 && r && !/READY\s*$/m.test(r); k++) { await waitU(30000); await pg.evaluate(() => window.mvs.act('tso1', { kind: 'enter' })); await pg.waitForTimeout(300); r = await waitT(/READY\s*$|\*\*\*\s*$/m, 300000); }
  const c = Date.now(), ms = c - a;
  max = Math.max(max, ms); if (ms > 30000 || !r) stalls++;
  console.log(`[${T()}] LOGON ${i} to-password ${pwp ? b - a : 'TIMEOUT'} ms, password-to-READY ${r ? c - b : 'TIMEOUT'} ms, total ${ms} ms`);
  await waitU(30000); await pg.evaluate(() => window.mvs.act('tso1', { kind: 'clear' })); await waitU(30000);
  await typeEnter('logoff');
  await pg.waitForTimeout(2000);
}
const st = await pg.evaluate(() => window.mvs.stats()?.srmTune ?? null);
console.log(`RELOGON ${B} ${URL0} srmTune=${JSON.stringify(st)} max=${max} stalls(>30 s)=${stalls}`);
await br.close();
