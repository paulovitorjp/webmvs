#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// hang-repro.mjs -- stress / idle harness for the "X SYSTEM on both terminals" hang.
// Runs on the build host (Playwright 1.56.1 from web/app/node_modules, or PLAYWRIGHT_DIR).
//
// Usage: node scripts/hang-repro.mjs <chromium|firefox> <page url> <out dir> <tag> [options]
//   --idle-s <s>        idle time after the TSO tab is ready (default 600)
//   --sample-s <s>      sample interval during the idle time (default 30)
//   --logon             log on to TSO (MVSCE02/PASS4U) before the idle time
//   --cmd <text>        console command typed after the idle time (default 'd r,l'); repeated by --cmds
//   --cmds <n>          type <n> console commands, one after the other (default 1)
//   --early-cmd <text>  also type this console command right after the TSO tab opens (before the idle)
//   --throttle <rate>   Chromium: CDP Emulation.setCPUThrottlingRate during the idle time
//   --hide <s>          during the idle time, a second tab is in front for <s> s (page hidden), then back
//   --reply-s <s>       how long to wait for each reply (default 45)
//   --timeout <s>       whole-run limit (default idle + 600)
// Result: <out>/hang-<tag>.json; stdout line "HANG-RESULT <tag> ok|HANG ..." ; exit 0 ok, 1 hang/fail.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.join(here, '..', 'web', 'app'), 'package.json'));
const { chromium, firefox } = require('playwright');

const argv = process.argv.slice(2);
const VALOPTS = ['--freeze', '--activity-s', '--herc-cmd', '--idle-s', '--sample-s', '--cmd', '--cmds', '--early-cmd', '--throttle', '--hide', '--reply-s', '--timeout'];
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const [B, URL0, OUT, TAG] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALOPTS.includes(argv[i - 1])));
if (!B || !URL0 || !OUT || !TAG) { console.error('usage: hang-repro.mjs <chromium|firefox> <url> <out> <tag> [options]'); process.exit(2); }
const IDLE_S = Number(opt('idle-s', 600)), SAMPLE_S = Number(opt('sample-s', 30)), REPLY_S = Number(opt('reply-s', 45));
const CMD = opt('cmd', 'd r,l'), NCMDS = Number(opt('cmds', 1)), EARLY = opt('early-cmd', null);
const THROTTLE = Number(opt('throttle', 0)), HIDE_S = Number(opt('hide', 0));
const FREEZE_S = Number(opt('freeze', 0));   // Chromium: CDP Page.setWebLifecycleState frozen for <s> s (no timers at all), then active
const HERC_CMD = opt('herc-cmd', null);
const ACT_S = Number(opt('activity-s', 0));   // --logon: every <s> s a TSO command (and a console D T) during the idle time   // with ?debug=1: Hercules command typed in the debug pane at every sample
const TIMEOUT_S = Number(opt('timeout', IDLE_S + 600));
fs.mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const res = { tag: TAG, browser: B, url: URL0, opts: { IDLE_S, SAMPLE_S, CMD, NCMDS, EARLY, THROTTLE, HIDE_S, logon: flag('logon') }, steps: [], samples: [], result: null };
const step = (what, x) => { const s = { t: Math.round((Date.now() - t0) / 1000), what, ...(x ? { x } : {}) }; res.steps.push(s); console.log(`[${s.t}s] ${what}${x ? ' ' + JSON.stringify(x).slice(0, 400) : ''}`); };
const save = () => fs.writeFileSync(path.join(OUT, `hang-${TAG}.json`), JSON.stringify(res, null, 1));
const killer = setTimeout(() => { res.result = 'TIMEOUT'; step('run timeout'); save(); console.log(`HANG-RESULT ${TAG} TIMEOUT`); process.exit(3); }, TIMEOUT_S * 1000);

const launchOpts = B === 'firefox' ? { firefoxUserPrefs: { 'dom.max_script_run_time': 0 } } : {};
const br = await ({ chromium, firefox })[B].launch(launchOpts);
const ctx = await br.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text().slice(0, 300)}`); });
const ev = (fn, a) => page.evaluate(fn, a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFn(fn, a, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await ev(fn, a).catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(250);
  }
}
const sample = async (label) => {
  if (HERC_CMD) await ev((c) => { const i = document.getElementById('hcmd'); if (!i) return; i.value = c; document.getElementById('hcmd-form').requestSubmit(); }, HERC_CMD).catch(() => {});
  const s = await ev(() => {
    const m = window.mvs; const h = m.herclog();
    let st = {}; try { st = m.stats() || {}; } catch (e) { st = { err: String(e) }; }
    return {
      herclog: h.length, lastLog: h.slice(-3).map(([, l]) => l.slice(0, 120)),
      consoleTail: m.text('console').split('\n').filter((l) => l.trim()).slice(-3),
      consoleUnlocked: m.unlocked('console'), tsoUnlocked: m.unlocked('tso1'),
      oiaCon: m.oia ? m.oia('console') : null, oiaTso: m.oia ? m.oia('tso1') : null, seen: m.seen().length,
      heapUsed: st.heapUsed, sbrk: st.sbrk, logDropped: st.logDropped, threads: st.threads,
      dbg: window.__hwdbg ? window.__hwdbg() : null, mem: st.memoryBytes, sbrkPeak: st.sbrkPeak,
      state: window.mvsState, crash: m.crash ? m.crash() : null, crashDialog: !!document.getElementById('crash-dialog')?.open,
      status: document.getElementById('ipl-status')?.textContent ?? null,
    };
  }).catch((e) => ({ err: String(e).slice(0, 200) }));
  s.t = Math.round((Date.now() - t0) / 1000); s.label = label;
  res.samples.push(s); save();
  if (s.err) console.log(`sample error ${s.err}`);
  console.log(`[${s.t}s] sample ${label}: state ${s.state}${s.crash ? ' CRASH dialog=' + s.crashDialog : ''} mem ${Math.round((s.mem || 0) / 1048576)} sbrk ${Math.round((s.sbrk || 0) / 1048576)} log ${s.herclog} seen ${s.seen} con ${s.consoleUnlocked ? 'U' : 'L'}(${s.oiaCon}) tso ${s.tsoUnlocked ? 'U' : 'L'} drop ${s.logDropped} | ${(s.lastLog || []).slice(-1)[0] || ''}${s.dbg ? ' | dbg ' + JSON.stringify(s.dbg).slice(0, 300) : ''}`);
  return s;
};
async function consoleCmd(text) {
  await page.click('button.tab[data-tab="console"]');
  await waitFn(() => window.mvs.unlocked('console'), null, 30000, 'console unlocked before command');
  const before = await ev(() => window.mvs.seen().length);
  await page.keyboard.press('Home');
  await page.keyboard.type(text, { delay: 20 });
  const tEnter = Date.now();
  await page.keyboard.press('Enter');
  const ok = await waitFn(() => window.mvs.unlocked('console'), null, REPLY_S * 1000, 'console reply').then(() => true).catch(() => false);
  await sleep(1500);
  const after = await ev(() => window.mvs.seen().slice(-6));
  return { ok, replyMs: ok ? Date.now() - tEnter : null, newLines: after, seenBefore: before };
}

let hang = null;
try {
  await page.goto(URL0);
  await waitFn(() => window.mvs && !document.getElementById('app').hidden, null, 300000, 'app visible');
  step('app visible');
  await waitFn(() => window.mvsState === 'tso', null, 300000, 'TSO tab (IKT007I)');
  step('TSO ready');
  await waitFn(() => window.mvs.unlocked('console'), null, 60000, 'console unlocked after IPL').catch(() => step('console still locked 60 s after TSO ready'));
  if (EARLY) { const r = await consoleCmd(EARLY); step(`early command '${EARLY}'`, r); if (!r.ok) hang = 'early command'; }
  if (flag('logon')) {
    await page.click('button.tab[data-tab="tso1"]');
    const unl = () => waitFn(() => window.mvs.unlocked('tso1'), null, 60000, 'tso unlocked');
    await unl(); await page.keyboard.press('Enter');
    await waitFn(() => /TSO Logon ===>|LOGON/.test(window.mvs.text('tso1')), null, 60000, 'logon screen');
    await unl(); await page.keyboard.type('logon mvsce02', { delay: 15 }); await page.keyboard.press('Enter');
    await waitFn(() => /PASSWORD/i.test(window.mvs.text('tso1')), null, 60000, 'password prompt');
    await unl(); await page.keyboard.type('PASS4U', { delay: 15 }); await page.keyboard.press('Enter');
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const t = await ev(() => window.mvs.text('tso1'));
      if (/READY\s*$/m.test(t)) break;
      if (await ev(() => window.mvs.unlocked('tso1'))) await page.keyboard.press('Enter');
    }
    step('TSO logged on', { tail: (await ev(() => window.mvs.text('tso1'))).split('\n').filter((l) => l.trim()).slice(-2) });
    await page.click('button.tab[data-tab="console"]');
  }
  // ---- idle ----
  let cdp = null;
  if (THROTTLE > 1 && B === 'chromium') { cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }); step(`CPU throttling x${THROTTLE}`); }
  let other = null;
  if (HIDE_S > 0) { other = await ctx.newPage(); await other.goto('about:blank'); await other.bringToFront(); step('second tab in front (page hidden)', { visibility: await ev(() => document.visibilityState) }); }
  if (FREEZE_S > 0 && B === 'chromium') {
    // While the console is busy: type a command first (roll mode output follows), then freeze the page.
    await page.click('button.tab[data-tab="console"]');
    await page.keyboard.press('Home'); await page.keyboard.type('d a,l', { delay: 10 }); await page.keyboard.press('Enter');
    const c = cdp || await ctx.newCDPSession(page);
    await c.send('Page.setWebLifecycleState', { state: 'frozen' });
    step(`page frozen for ${FREEZE_S} s (no timers: the output rings are not drained)`);
    await sleep(FREEZE_S * 1000);
    await c.send('Page.setWebLifecycleState', { state: 'active' });
    step('page active again');
    await sleep(3000);
  }
  const idleEnd = Date.now() + IDLE_S * 1000;
  let n = 0;
  let lastAct = Date.now(), nAct = 0;
  res.activity = { tso: 0, console: 0, fail: 0 };
  while (Date.now() < idleEnd) {
    await sample(`idle ${n++}`);
    if (ACT_S > 0 && flag('logon') && Date.now() - lastAct >= ACT_S * 1000 && !hang) {
      lastAct = Date.now(); nAct++;
      const cmd = ['time', 'listcat', 'status', 'lista st'][nAct % 4];
      await page.click('button.tab[data-tab="tso1"]');
      const ok1 = await waitFn(() => window.mvs.unlocked('tso1'), null, REPLY_S * 1000, 'tso unlocked').then(() => true).catch(() => false);
      if (ok1) {
        await page.keyboard.type(cmd, { delay: 10 }); await page.keyboard.press('Enter');
        const ok = await waitFn(() => window.mvs.unlocked('tso1') && /READY\s*$/m.test(window.mvs.text('tso1')), null, REPLY_S * 1000, 'READY').then(() => true).catch(() => false);
        // a full screen ends with *** (more): Enter until READY
        for (let k = 0; k < 10 && !ok && /\*\*\*\s*$/m.test(await ev(() => window.mvs.text('tso1'))); k++) { await page.keyboard.press('Enter'); await sleep(800); }
        const ready = ok || await ev(() => window.mvs.unlocked('tso1'));
        res.activity.tso++; if (!ready) { res.activity.fail++; hang = `tso activity '${cmd}'`; step(`TSO activity '${cmd}' got no reply`); }
      } else { res.activity.fail++; hang = 'tso locked during activity'; }
      if (!hang && nAct % 2 === 0) {
        const r = await consoleCmd('d t'); res.activity.console++;
        if (!r.ok) { res.activity.fail++; hang = 'console activity d t'; step('console D T got no reply'); }
      }
      await page.click('button.tab[data-tab="console"]');
      if (hang) break;
    }
    if (other && Date.now() - t0 > 0 && (Date.now() - (idleEnd - IDLE_S * 1000)) > HIDE_S * 1000) { await page.bringToFront(); await other.close(); other = null; step('page in front again', { visibility: await ev(() => document.visibilityState) }); }
    await sleep(Math.min(SAMPLE_S * 1000, Math.max(0, idleEnd - Date.now())));
  }
  if (other) { await page.bringToFront(); await other.close(); other = null; }
  if (cdp) { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); }
  await sample('after idle');
  // ---- the user's sequence ----
  for (let i = 0; i < NCMDS && !hang; i++) {
    const r = await consoleCmd(CMD);
    step(`console command ${i + 1} '${CMD}'`, r);
    if (!r.ok) hang = `console command ${i + 1}`;
  }
  await page.click('button.tab[data-tab="tso1"]');
  const tsoBefore = await ev(() => window.mvs.unlocked('tso1'));
  if (tsoBefore) {
    await page.keyboard.press('Enter');
    const ok = await waitFn(() => window.mvs.unlocked('tso1'), null, REPLY_S * 1000, 'tso reply').then(() => true).catch(() => false);
    step('TSO Enter', { ok });
    if (!ok && !hang) hang = 'tso enter';
    else if (!ok) hang += ' + tso enter';
  } else { step('TSO keyboard already locked before Enter', { oia: await ev(() => window.mvs.oia ? window.mvs.oia('tso1') : null) }); if (!hang) hang = 'tso locked'; }
  await sample('end');
} catch (e) {
  step(`error: ${String(e).slice(0, 300)}`);
  hang = hang || `error: ${String(e).slice(0, 120)}`;
}
try { await page.screenshot({ path: path.join(OUT, `hang-${TAG}.png`) }); } catch { /* ignore */ }
if (hang) {
  // post-mortem: Hercules state through the debug command line (only with ?debug=1)
  const hasCmd = await ev(() => !!document.getElementById('hcmd') && !document.getElementById('debug').hidden).catch(() => false);
  if (hasCmd) {
    for (const c of ['devlist 0010', 'devlist 0400', 'locks held', 'threads waiting', 'ipending']) {
      await ev((c) => { const i = document.getElementById('hcmd'); i.value = c; document.getElementById('hcmd-form').requestSubmit(); }, c).catch(() => {});
      await sleep(1500);
    }
    res.postmortemLog = await ev(() => window.mvs.herclog().slice(-200).map(([, l]) => l)).catch(() => null);
  }
}
res.herclogAll = HERC_CMD ? await ev(() => window.mvs.herclog().map(([t, l]) => `${Math.round(t)} ${l}`)).catch(() => null) : undefined;
res.herclogTail = await ev(() => window.mvs.herclog().slice(-80).map(([t, l]) => `${Math.round(t)} ${l}`)).catch(() => null);
res.consoleText = await ev(() => window.mvs.text('console')).catch(() => null);
res.tsoText = await ev(() => window.mvs.text('tso1')).catch(() => null);
res.events = await ev(() => window.mvs.events()).catch(() => null);
res.pageErrors = pageErrors;
res.result = hang ? `HANG ${hang}` : 'ok';
save();
console.log(`HANG-RESULT ${TAG} ${res.result}`);
clearTimeout(killer);
await br.close().catch(() => {});
process.exit(hang ? 1 : 0);
