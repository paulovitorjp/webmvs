// SPDX-License-Identifier: Apache-2.0
// idlecpu.mjs -- host CPU time used by an IDLE MVS page (after TSO ready), Linux only.
// Usage: node scripts/idlecpu.mjs <chromium|firefox> <url> [settle-s 60] [measure-s 120]
// Sums utime+stime of all descendant processes of this node process (the browser) from /proc, over measure-s
// seconds that start settle-s seconds after IKT007I; prints "IDLECPU <browser> <url> cpu_s=<x> pct=<x/measure*100>".
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.join(here, '..', 'web', 'app'), 'package.json'));
const pw = require('playwright');
const [B, URL0, SETTLE = '60', MEAS = '120'] = process.argv.slice(2);
const HZ = 100;
function tree() {
  const kids = new Map(), cpu = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const s = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const r = s.slice(s.lastIndexOf(')') + 2).split(' ');
      const ppid = +r[1]; (kids.get(ppid) || kids.set(ppid, []).get(ppid)).push(+d); cpu.set(+d, (+r[11] + +r[12]) / HZ); } catch { /* gone */ }
  }
  let sum = 0; const st = [process.pid];
  while (st.length) { const p = st.pop(); for (const c of kids.get(p) || []) { sum += cpu.get(c) || 0; st.push(c); } }
  return sum;
}
const br = await pw[B].launch(B === 'firefox' ? { firefoxUserPrefs: { 'dom.max_script_run_time': 0 } } : {});
const pg = await br.newPage();
await pg.goto(URL0);
await pg.waitForFunction(() => (window.mvs?.herclog?.() ?? []).some(([, l]) => /IKT007I/.test(l)), null, { timeout: 300000, polling: 500 });
await pg.waitForTimeout(+SETTLE * 1000);
const st = await pg.evaluate(() => window.mvs.stats()?.srmTune ?? null);
const c0 = tree(), t0 = Date.now();
await pg.waitForTimeout(+MEAS * 1000);
const c1 = tree(), dt = (Date.now() - t0) / 1000;
console.log(`IDLECPU ${B} ${URL0} srmTune=${JSON.stringify(st)} cpu_s=${(c1 - c0).toFixed(2)} wall_s=${dt.toFixed(0)} pct=${((c1 - c0) / dt * 100).toFixed(1)}`);
await br.close();
