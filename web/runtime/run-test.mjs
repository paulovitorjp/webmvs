#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// run-test.mjs -- open web/runtime/test.html in headless Chromium or Firefox (Playwright) and
// collect its report. Runs on the build host.
// Usage: node run-test.mjs <browser> <url> <logfile> [timeout-s]
//   browser: chromium | firefox.  Writes every console line (with +ms since navigation) to
//   <logfile>, samples the RSS of the browser process tree every 500 ms, prints a summary
//   (RESULT json + rss peak) and exits 0 if the page reported ok.
import { chromium, firefox } from 'playwright';
import fs from 'node:fs';

const [, , bname, url, logfile, toS = '900'] = process.argv;
const engines = { chromium, firefox };
if (!engines[bname] || !url || !logfile) { console.error('usage: run-test.mjs chromium|firefox <url> <logfile> [timeout-s]'); process.exit(2); }
const out = fs.createWriteStream(logfile);
const t0 = Date.now();
const w = (s) => out.write(`+${String(Date.now() - t0).padStart(7)} ${s}\n`);

// RSS of all descendants of this node process (the browser and its children), from /proc.
function treeRss() {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(d));
    } catch { /* gone */ }
  }
  let sum = 0, max = 0, n = 0;
  const walk = (p) => { for (const c of kids.get(p) || []) {
    try { const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${c}/status`, 'utf8')); const kb = m ? Number(m[1]) : 0; sum += kb; max = Math.max(max, kb); n++; } catch {}
    walk(c); } };
  walk(process.pid);
  return { sumKB: sum, maxKB: max, procs: n };
}

const opts = bname === 'firefox'
  ? { firefoxUserPrefs: { 'dom.max_script_run_time': 0, 'dom.max_chrome_script_run_time': 0 } } : {};
const browser = await engines[bname].launch(opts);
w(`BROWSER ${bname} ${browser.version()}`);
const page = await browser.newPage();
let peak = { sumKB: 0, maxKB: 0, procs: 0 };
const sampler = setInterval(() => { const r = treeRss(); if (r.sumKB > peak.sumKB) peak = { ...r, atMs: Date.now() - t0 }; if (r.maxKB > (peak.maxProcKB || 0)) peak.maxProcKB = r.maxKB; }, 500);

let result = null;
const done = new Promise((resolve) => {
  page.on('console', (m) => {
    const t = m.text();
    w(t);
    if (t.startsWith('RESULT ')) { try { result = JSON.parse(t.slice(7)); } catch (e) { result = { ok: false, error: 'bad RESULT json' }; } resolve(); }
  });
  page.on('pageerror', (e) => { w(`PAGEERROR ${e.message}`); });
  page.on('crash', () => { w('PAGE CRASH'); result = { ok: false, error: 'page crash' }; resolve(); });
});
await page.goto(url);
const to = setTimeout(() => { w('TIMEOUT'); result = result || { ok: false, error: `timeout ${toS} s` }; }, Number(toS) * 1000);
await Promise.race([done, new Promise((r) => { const i = setInterval(() => { if (result) { clearInterval(i); r(); } }, 500); })]);
clearTimeout(to); clearInterval(sampler);
const summary = { browser: `${bname} ${browser.version()}`, url, ok: !!(result && result.ok), rssPeak: peak, result };
w('SUMMARY ' + JSON.stringify(summary));
console.log(JSON.stringify(summary, null, 1));
await browser.close();
out.end();
process.exit(summary.ok ? 0 : 1);
