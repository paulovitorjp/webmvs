// SPDX-License-Identifier: Apache-2.0
// logon-loop.mjs -- TSO logons with real keyboard events, as scripts/e2e.mjs types
// them (wait for the prompt and for the keyboard unlock, page.keyboard.type with 15 ms per key, Enter), to count lost
// passwords, and the WORK00 check in the browser.
// Usage: node scripts/logon-loop.mjs <chromium|firefox|webkit> <url> <out-dir> <tag> [options]
//   --pages P         fresh browser contexts (cold: every page IPLs), default 10
//   --per-page K      logons per page, default 5 (the first one right after TSO ready, like the e2e)
//   --users U,U       user/password pairs used in turn, default MVSCE02/PASS4U
//   --stall-s S       a logon whose password prompt is still on the screen S s after the Enter is a stall
//                     (lost password); the script then types the password again and counts it (default 20)
//   --work00          per logon also: no ISP.PROF / IEF238D message, ISPF primary menu, =X, ALLOC NEW without
//                     volume, LISTCAT shows the data set on WORK00, DELETE
//   --query Q         appended to the URL (e.g. "?typeahead=0")
//   --pw-delay-ms D   wait D ms after the password prompt before typing the password (default 0, like the e2e)
// Output: one line per logon "LOGON ..." and the final "LOGONLOOP {json}" (also <out>/logonloop-<tag>.json).
// A stall saves the page's keyboard / data-stream log (window.mvs.kbdlog), the fields and the screen.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.join(here, '..', 'web', 'app'), 'package.json'));
const pw = require('playwright');
const [B, URL0, OUT, TAG] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const PAGES = +arg('pages', 10), PER = +arg('per-page', 5), STALL_S = +arg('stall-s', 20);
const USERS = arg('users', 'MVSCE02/PASS4U').split(',').map((x) => x.split('/'));
const WORK00 = process.argv.includes('--work00');
const PW_DELAY = +arg('pw-delay-ms', 0);   // extra wait after the password prompt (a visitor reads it first)
const URL1 = URL0 + (arg('query', '') || '');
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(1);
const res = { browser: B, url: URL1, pages: PAGES, perPage: PER, logons: 0, ok: 0, stalls: 0, retypes: 0, failures: [], times: [],
  typeahead: [], work00: [], stallDiag: [], kbdlogs: [] };
const br = await pw[B].launch(B === 'firefox' ? { firefoxUserPrefs: { 'dom.max_script_run_time': 0 } } : {});
for (let p = 1; p <= PAGES; p++) {
  const ctx = await br.newContext({ viewport: { width: 1280, height: 900 } });
  const pg = await ctx.newPage();
  const ev = (f, a) => pg.evaluate(f, a);
  const txt = () => ev(() => window.mvs.text('tso1'));
  async function waitT(re, ms) { const e = Date.now() + ms; for (;;) { const t = await txt().catch(() => ''); if (re.test(t)) return t; if (Date.now() > e) return null; await pg.waitForTimeout(100); } }
  async function waitU(ms = 30000) { const e = Date.now() + ms; while (Date.now() < e) { if (await ev(() => window.mvs.unlocked('tso1'))) return true; await pg.waitForTimeout(25); } return false; }
  async function typeLine(s) { await waitU(); await pg.keyboard.type(s, { delay: 15 }); await pg.keyboard.press('Enter'); }
  try {
    await pg.goto(URL1);
    await pg.waitForFunction(() => window.mvs?.active?.() === 'tso1' && window.mvs.text('tso1').length > 0, null, { timeout: 300000, polling: 200 });
    await pg.click('canvas.screen').catch(() => {});   // focus as a visitor would (the page also captures keys on document)
    console.log(`[${T()}] page ${p}: TSO tab`);
    for (let k = 1; k <= PER; k++) {
      const [U, PWD] = USERS[(res.logons) % USERS.length];
      res.logons++;
      const n = res.logons;
      let t = await waitT(/CLEAR the screen or hit ENTER|TSO Logon ===>/, 120000);
      if (!t) throw new Error('no logon screen');
      if (!/TSO Logon ===>/.test(t)) { await waitU(); await pg.keyboard.press('Enter'); if (!await waitT(/TSO Logon ===>/, 60000)) throw new Error('no TSO Logon ===>'); }
      const seen0 = await ev(() => window.mvs.seenTotal());
      const tl0 = await ev(() => performance.now() - 50);   // kbdlog events from here on belong to this logon
      const a = Date.now();
      await typeLine(`logon ${U.toLowerCase()}`);
      if (!await waitT(new RegExp(`ENTER CURRENT PASSWORD FOR ${U}`), 120000)) throw new Error('no password prompt');
      const b = Date.now();
      if (PW_DELAY) await pg.waitForTimeout(PW_DELAY);
      await typeLine(PWD);
      let r = await waitT(/READY\s*$|^\s*\*\*\*\s*$|IKJ56\d{3}|IN USE|REJECTED|NOT AUTHORIZED/m, STALL_S * 1000);
      let retyped = 0;
      while (!r || (/ENTER CURRENT PASSWORD/.test(r) && !/READY|\*\*\*/.test(r))) {
        // stall: the prompt is still there. Save the evidence, then type the password again (a visitor would).
        if (retyped === 0) {
          res.stalls++;
          const diag = { logon: n, page: p, user: U, at: T(), screen: await txt(), oia: await ev(() => window.mvs.oia('tso1')),
            fields: await ev(() => (window.mvs.fields?.('tso1') ?? null)), typeahead: await ev(() => (window.mvs.typeahead?.('tso1') ?? null)),
            kbdlog: (await ev(() => (window.mvs.kbdlog?.('tso1') ?? []))).filter((e) => e.t >= tl0),
            console: await ev((s0) => window.mvs.seenSince(s0), seen0),
            herclog: (await ev(() => window.mvs.herclog())).slice(-40) };
          res.stallDiag.push(diag);
          fs.writeFileSync(path.join(OUT, `stall-${TAG}-${n}.json`), JSON.stringify(diag, null, 1));
          await pg.screenshot({ path: path.join(OUT, `stall-${TAG}-${n}.png`) }).catch(() => {});
          console.log(`[${T()}] STALL logon ${n} (page ${p}): ${JSON.stringify(diag.fields)} ${JSON.stringify(diag.typeahead)}`);
        }
        if (retyped >= 2) throw new Error('password lost 3 times');
        retyped++; res.retypes++;
        await typeLine(PWD);
        r = await waitT(/READY\s*$|^\s*\*\*\*\s*$|IKJ56\d{3}|IN USE|REJECTED/m, 60000);
      }
      if (/IN USE|REJECTED|NOT AUTHORIZED/.test(r)) throw new Error(`logon rejected: ${r.split('\n').find((l) => /IN USE|REJECTED|NOT AUTH/.test(l))}`);
      let seenText = r;
      for (let i = 0; i < 30 && !/READY\s*$/m.test(r); i++) { await waitU(); await pg.keyboard.press('Enter'); await pg.waitForTimeout(300); r = await waitT(/READY\s*$|^\s*\*\*\*\s*$/m, 90000) ?? ''; seenText += '\n' + r; }
      if (!/READY\s*$/m.test(r)) throw new Error('no READY');
      const c = Date.now();
      const logonScreen = r;
      // the password must never come back as a TSO command (a duplicate line: 'COMMAND PASS4U NOT FOUND')
      const echo = seenText.split('\n').filter((l) => /COMMAND \S+ NOT FOUND|PASSWORD (NOT AUTHORIZED|INVALID)|IKJ5642\dI/.test(l)).map((l) => l.trim());
      if (echo.length) { res.echo = (res.echo || 0) + 1; res.echoLines = [...(res.echoLines || []), { logon: n, lines: echo }]; console.log(`[${T()}] ECHO logon ${n}: ${JSON.stringify(echo)}`); }
      const lines = await ev((s0) => window.mvs.seenSince(s0), seen0);
      const w = { logon: n, user: U };
      if (WORK00) {
        w.screenProblems = logonScreen.split('\n').filter((l) => /NOT ALLOCATED|VOLUME NOT AVAILABLE|REQUEST CANCELED/.test(l)).map((l) => l.trim());
        await waitU(); await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
        await typeLine('ispf');
        const ispf = await waitT(/Primary Option Menu|PRIMARY OPTION MENU|NOT ALLOCATED|IKJ\d+I/, 60000);
        w.ispf = ispf ? (/Primary Option Menu|PRIMARY OPTION MENU/i.test(ispf) ? 'primary menu' : ispf.split('\n').find((l) => /NOT ALLOC|IKJ/.test(l))?.trim()) : 'TIMEOUT';
        await pg.waitForTimeout(500);
        await typeLine('=x');
        await waitT(/READY\s*$/m, 60000);
        await waitU(); await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
        await typeLine(`alloc f(nd) da('${U}.M6WNEW') new space(1,1) tracks catalog`);
        const al = await waitT(/READY\s*$/m, 60000);
        w.alloc = al ? al.split('\n').map((l) => l.trim()).filter((l) => l && !/^alloc /i.test(l) && l !== 'READY').slice(-2) : 'TIMEOUT';
        await waitU(); await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
        await typeLine('free f(nd)'); await waitT(/READY\s*$/m, 30000);
        await waitU(); await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
        await typeLine(`listcat entries('${U}.M6WNEW' '${U}.ISP.PROF') volume`);
        let lc = ''; for (let i = 0; i < 10; i++) { const s = await waitT(/READY\s*$|^\s*\*\*\*\s*$/m, 30000) ?? ''; lc += s; if (/READY\s*$/m.test(s)) break; await waitU(); await pg.keyboard.press('Enter'); await pg.waitForTimeout(300); }
        w.volumes = [...lc.matchAll(/VOLSER-+(\w+)/g)].map((m) => m[1]);
        await waitU(); await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
        await typeLine(`delete '${U}.M6WNEW'`); await waitT(/READY\s*$/m, 30000);
        const all = await ev((s0) => window.mvs.seenSince(s0), seen0);
        w.consoleProblems = all.filter((l) => /IEF238D|IEF244I|IEF489I|IEF247I/.test(l)).map((l) => l.trim());
        w.pass = w.screenProblems.length === 0 && w.consoleProblems.length === 0 && w.ispf === 'primary menu'
          && w.volumes.length >= 2 && w.volumes.every((v) => v === 'WORK00');
        res.work00.push(w);
        console.log(`[${T()}] WORK00 ${U}: ${JSON.stringify(w)}`);
      } else {
        w.consoleProblems = lines.filter((l) => /IEF238D|IEF244I/.test(l)).map((l) => l.trim());
      }
      res.ok++; res.times.push([n, b - a, c - b, retyped]);
      // the keyboard / data-stream events of this logon (from 'logon' Enter to READY), for the analysis
      res.kbdlogs.push({ logon: n, page: p, ev: (await ev(() => (window.mvs.kbdlog?.('tso1') ?? []))).filter((e) => e.t >= tl0 && e.t <= tl0 + 50 + (c - a)) });
      console.log(`[${T()}] LOGON ${n} ${U} page ${p}: to-prompt ${b - a} ms, password-to-READY ${c - b} ms${retyped ? `, RETYPED ${retyped}` : ''}`);
      await waitU(); await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
      await typeLine('logoff');
      await waitT(/LOGGED OFF|TSO Logon ===>|CLEAR the screen/, 60000);
      await pg.waitForTimeout(1000);
    }
    res.typeahead.push({ page: p, ...(await ev(() => (window.mvs.typeahead?.('tso1') ?? null))) });
  } catch (e) {
    res.failures.push({ page: p, at: T(), error: String(e), screen: await pg.evaluate(() => window.mvs.text('tso1')).catch(() => ''),
      kbdlog: await pg.evaluate(() => (window.mvs.kbdlog?.('tso1') ?? [])).catch(() => []),
      typeahead: await pg.evaluate(() => (window.mvs.typeahead?.('tso1') ?? null)).catch(() => null),
      console: await pg.evaluate(() => window.mvs.seen().slice(-30)).catch(() => []) });
    console.log(`[${T()}] FAIL page ${p}: ${e}`);
    await pg.screenshot({ path: path.join(OUT, `fail-${TAG}-${p}.png`) }).catch(() => {});
  }
  await ctx.close();
}
await br.close();
const pr = res.times.map((x) => x[2]).sort((x, y) => x - y);
res.passwordToReadyMs = pr.length ? { min: pr[0], median: pr[Math.floor(pr.length / 2)], max: pr[pr.length - 1] } : null;
fs.writeFileSync(path.join(OUT, `logonloop-${TAG}.json`), JSON.stringify(res, null, 1));
const sum = { tag: TAG, browser: B, url: URL1, logons: res.logons, ok: res.ok, stalls: res.stalls, retypes: res.retypes, failures: res.failures.length,
  passwordToReadyMs: res.passwordToReadyMs, queued: res.typeahead.reduce((a, x) => a + (x.queued || 0), 0),
  refusedChars: res.typeahead.reduce((a, x) => a + (x.refusedChars || 0), 0), aidWhileLocked: res.typeahead.reduce((a, x) => a + (x.aidWhileLocked || 0), 0),
  pwBareUnlock: res.typeahead.reduce((a, x) => a + (x.pwBareUnlock || 0), 0), pwResends: res.typeahead.reduce((a, x) => a + (x.pwResends || 0), 0),
  work00: WORK00 ? `${res.work00.filter((w) => w.pass).length}/${res.work00.length}` : undefined, echo: res.echo || 0 };
console.log(`LOGONLOOP ${JSON.stringify(sum)}`);
process.exit(res.failures.length || res.ok < res.logons ? 1 : 0);
