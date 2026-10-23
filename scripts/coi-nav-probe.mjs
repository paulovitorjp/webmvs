#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// count page navigations until the page is cross-origin isolated through coi-serviceworker
// (server without COOP/COEP headers). Each iteration uses a fresh browser context (no service worker yet), so
// it is a first visit. Prints, per iteration, the navigations with the state of each document at its start
// (controlled by the service worker or not) and the coi-serviceworker console lines. Earlier tests saw
// 3 navigations (instead of 2) in some WebKit and Mac Chrome runs.
// Usage: node scripts/coi-nav-probe.mjs <chromium|firefox|webkit> <url> <iterations> [--settle ms] [--max ms] [--json file]
// scripts/coi-race-test.sh runs it against copies of the page whose service worker installs slowly (race test).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.join(here, '..', 'web', 'app'), 'package.json'));
const pw = require('playwright');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const [B, URL0, N] = argv;
const SETTLE = Number(opt('settle', 3000));
const MAXWAIT = Number(opt('max', 30000));
const br = await pw[B].launch();
const out = { browser: `${B} ${br.version()}`, url: URL0, runs: [] };
for (let i = 1; i <= Number(N); i++) {
  const ctx = await br.newContext();
  const page = await ctx.newPage();
  const t0 = Date.now(); const ev = [];
  const t = () => Date.now() - t0;
  await page.addInitScript(() => {
    console.log(`[probe] document start: controlled=${!!navigator.serviceWorker?.controller} isolated=${self.crossOriginIsolated}`);
  });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) ev.push([t(), 'nav']); });
  page.on('console', (m) => { const s = m.text(); if (/\[probe\]|COOP\/COEP|Service Worker/i.test(s)) ev.push([t(), s]); });
  let iso = false, err = '';
  try {
    await page.goto(URL0, { waitUntil: 'commit' });
    const end = Date.now() + MAXWAIT;
    while (Date.now() < end) {
      iso = await page.evaluate(() => self.crossOriginIsolated).catch(() => false);
      if (iso) break;
      await page.waitForTimeout(100);
    }
    if (iso) await page.waitForTimeout(SETTLE);   // a later reload would show up here
    iso = await page.evaluate(() => self.crossOriginIsolated).catch(() => false);
  } catch (e) { err = String(e).slice(0, 200); }
  const navs = ev.filter((e) => e[1] === 'nav').length;
  out.runs.push({ i, navs, iso, err, ev });
  console.log(`run ${i}: navigations=${navs} isolated=${iso}${err ? ` error=${err}` : ''}`);
  if (navs !== 2) for (const [ms, s] of ev) console.log(`    +${ms} ms ${s}`);
  await ctx.close();
}
await br.close();
const hist = {};
for (const r of out.runs) hist[r.navs] = (hist[r.navs] || 0) + 1;
out.histogram = hist;
console.log(`${out.browser}: navigations per first visit ${JSON.stringify(hist)}; isolated ${out.runs.filter((r) => r.iso).length}/${out.runs.length}`);
if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(out, null, 1));
