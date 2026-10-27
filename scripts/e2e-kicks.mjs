#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// KICKS, CardDemo and upgrade test of the visitor page (Playwright; Chromium, Firefox or WebKit). Runs on the
// build host.
//
// Usage: node scripts/e2e-kicks.mjs <chromium|firefox|webkit> <url> <out dir> <tag> [--profile <dir>]
//          [--prep] [--check-saved] [--expect-upgrade] [--no-kicks] [--carddemo] [--shutdown] [--mobile]
//   default      wait for TSO, log on MVSCE02, start KICKS, KSGM, Clear, INQ1 with customer 400001 (MCDONALD),
//                PF3 (Murach menu), PF3, BTC0 (TAC menu), PF12, Clear, KSSF (READY), LOGOFF
//   --prep       (no KICKS) save a member MVSCE02.CLIST(UPGTEST) and a new data set MVSCE02.UPGTEST.DATA, then
//                LOGOFF and shut down: saved state for --check-saved on a later bundle (same --profile and origin)
//   --check-saved      the member and the data set are still there (LIST, LISTCAT)
//   --expect-upgrade   the runtime removed the shadows of the changed volumes (persist.upgrade) and the page
//                      shows the update notice
//   --carddemo   after KICKS: CARDDEMO, sign on USER0001, account 00000000001 (Immanuel Kessler), a menu option
//                pending authorizations of 00000000013 (PF5 on the first marks it as fraud or not), bill payment of account 00000000001, PF3 to the sign-on
//                screen, PF3, KSSF; a card update, a transaction report (REVIEW shows it at READY), the interest job; then ADMIN001
//                adds user A0WEBMVS and the user list shows it, adds transaction type 50 and deletes it in the list;
//                --carddemo-only: the same without the KICKS samples
//   --mobile     iPhone-sized viewport with touch (layout sanity: no horizontal overflow, terminal visible)
// Output: <out>/kicks-<tag>.json, screenshots <out>/<tag>-<step>.png
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.join(here, '..', 'web', 'app'), 'package.json'));
const pw = require('playwright');
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const [B, URL0, OUT, TAG] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--profile', '--timeout'].includes(argv[i - 1])));
if (!['chromium', 'firefox', 'webkit'].includes(B) || !URL0 || !OUT || !TAG) { console.error('usage: e2e-kicks.mjs <browser> <url> <out> <tag> [options]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1);
const res = { browser: B, url: URL0, tag: TAG, date: new Date().toISOString(), steps: [], checks: {}, ok: false };
const step = (name, extra) => { res.steps.push({ t: Number(el()), name, ...(extra || {}) }); console.log(`[${el()}s] ${name}`, extra ? JSON.stringify(extra) : ''); };
const check = (name, pass, evidence) => { res.checks[name] = { pass: !!pass, evidence }; console.log(`  check ${pass ? 'ok  ' : 'FAIL'} ${name}`); if (!pass) throw new Error(`check failed: ${name}: ${JSON.stringify(evidence)}`); };
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, Number(opt('timeout', 900)) * 1000);

const MOBILE = flag('mobile');
const ctxOpts = MOBILE ? { ...pw.devices['iPhone 13'], defaultBrowserType: undefined } : { viewport: { width: 1280, height: 860 } };
if (B === 'firefox') delete ctxOpts.isMobile;
let br, ctx;
if (opt('profile')) ctx = await pw[B].launchPersistentContext(opt('profile'), ctxOpts);
else { br = await pw[B].launch(); ctx = await br.newContext(ctxOpts); }
const page = ctx.pages()[0] ?? await ctx.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
const ev = (fn, arg) => page.evaluate(fn, arg);
const sleep = (ms) => page.waitForTimeout(ms);
const text = () => ev(() => window.mvs?.text('tso1') ?? '').catch(() => '');
const shot = async (name) => { const f = path.join(OUT, `${TAG}-${name}.png`); await page.screenshot({ path: f }); res.shots = [...(res.shots || []), f]; };
async function waitFn(fn, arg, ms, what) {
  const end = Date.now() + ms;
  for (;;) { const v = await ev(fn, arg).catch(() => undefined); if (v) return v; if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await sleep(200); }
}
async function waitText(re, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const t = await text();
    if (re.test(t)) return t;
    if (Date.now() > end) { console.log(`--- tso1 screen:\n${t}`); throw new Error(`timeout waiting for ${what ?? re}`); }
    await sleep(200);
  }
}
const unlocked = () => waitFn(() => window.mvs.unlocked('tso1'), null, 30000, 'keyboard unlocked');
async function key(k) { await unlocked(); await page.keyboard.press(k); await sleep(300); }
async function typeLine(s) { await unlocked(); await page.keyboard.type(s, { delay: 15 }); await page.keyboard.press('Enter'); await sleep(300); }
// TSO line mode: wait for READY as the last line; '***' (screen full) -> Enter
async function ready(ms = 90000) {
  const end = Date.now() + ms;
  for (;;) {
    const t = await text();
    const l = t.split('\n').map((x) => x.trim()).filter(Boolean);
    const u = await ev(() => window.mvs.unlocked('tso1')).catch(() => false);
    if (u && l[l.length - 1] === 'READY') return t;
    if (u && l[l.length - 1] === '***') { await page.keyboard.press('Enter'); await sleep(400); continue; }
    if (Date.now() > end) { console.log(`--- tso1 screen:\n${t}`); throw new Error('timeout waiting for READY'); }
    await sleep(200);
  }
}
async function cmd(s, ms) { await key('Escape'); await typeLine(s); return ready(ms); }   // Clear, command, READY
// the lines of a member: EDIT ... OLD, LIST, END
async function memberText(dsn) {
  await key('Escape'); await typeLine(`edit '${dsn}' data old`);
  await waitText(/^\s*EDIT\s*$/m, 60000, 'EDIT mode');
  await key('Escape'); await typeLine('list');
  const t = await waitText(/END OF DATA/, 30000, 'LIST done');
  await typeLine('end'); await ready(60000);
  return t;
}

try {
  await page.goto(URL0, { waitUntil: 'load', timeout: 120000 });
  await waitFn(() => window.mvs && !document.getElementById('app').hidden, null, 180000, 'app visible');
  res.persist = (await ev(() => window.mvs.persist?.() ?? null))?.info ?? null;
  step('page up', { upgrade: res.persist?.upgrade ?? null, reset: res.persist?.reset, resetWhy: res.persist?.resetWhy, files: res.persist?.opfs?.files?.map((f) => f.name) });
  if (flag('expect-upgrade')) {
    const up = res.persist?.upgrade;
    check('upgrade: shadows of the changed volumes removed', up && up.removed.includes('mvsres_1.cckd') && up.removed.includes('mvs000_1.cckd'), up);
    check('upgrade: no full reset', !res.persist.reset, res.persist.resetWhy);
    check('upgrade: user volume shadows kept', ['pub000_1.cckd', 'work00_1.cckd'].every((f) => up.kept.includes(f)), up.kept);
    const hint = await ev(() => window.mvs.hint());   // the notice line and the tab hint
    check('upgrade: notice shown', /webmvs was updated/.test(hint), hint);
    await shot('upgrade-notice');
    await page.click('#notice-close');
    check('upgrade: the X closes the notice', await ev(() => document.getElementById('notice').hidden), null);
  }
  await waitFn(() => window.mvs.active() === 'tso1', null, 240000, 'TSO ready (auto-switch)');
  res.navToTsoS = Number(((await ev(() => performance.now())) / 1000).toFixed(1));
  res.console = await ev(() => window.mvs.seen()).catch(() => null);
  res.herclogIpl = (await ev(() => window.mvs.herclog()).catch(() => [])).filter(([, l]) => !/^HHC/.test(l)).slice(-80);
  let t = await waitText(/CLEAR the screen or hit ENTER|TSO Logon ===>|Logon ===>/, 60000, 'logon screen');
  if (!/Logon ===>/.test(t)) { await key('Enter'); await waitText(/Logon ===>/, 30000, 'Logon ===>'); }
  await typeLine('logon mvsce02');
  await waitText(/ENTER CURRENT PASSWORD FOR MVSCE02/, 60000, 'password prompt');
  await typeLine('PASS4U');
  await ready(120000);
  step('READY');
  if (MOBILE) {
    const lay = await ev(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      term: (() => { const r = document.querySelector('#views')?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null; })() }));
    check('mobile: no horizontal overflow', lay.sw <= lay.cw + 1, lay);
    check('mobile: terminal visible', lay.term && lay.term[0] > 200 && lay.term[1] > 150, lay);
    // small screen: credits behind (i), help behind (?), no footer or hint text under the terminal, no timing in the status
    const ui = await ev(() => ({ footer: getComputedStyle(document.querySelector('footer.attrib')).display, hint: getComputedStyle(document.getElementById('hint')).display,
      status: document.getElementById('ipl-status').textContent, tsoS: document.getElementById('ipl-status').dataset.tsoS,
      header: Math.round(document.querySelector('header').getBoundingClientRect().height) }));
    check('mobile: credits and hint text hidden, status without timing', ui.footer === 'none' && ui.hint === 'none' && ui.status === 'TSO ready' && Number(ui.tsoS) > 0 && ui.header < 70, ui);
    await page.click('#info-btn');
    const credits = await ev(() => document.getElementById('info-dialog').open ? document.getElementById('info-dialog').textContent : '');
    check('mobile: (i) shows the credits (KICKS by Mike Noel, CardDemo Apache-2.0)', /Mike Noel/.test(credits) && /CardDemo/.test(credits) && /Apache-2\.0/.test(credits), credits.replace(/\s+/g, ' ').slice(0, 300));
    await shot('mobile-credits');
    await page.click('#info-dialog .sheet-close');
    await page.click('#help-btn');
    const help = await ev(() => document.getElementById('help-dialog').open ? document.getElementById('help-dialog').textContent : '');
    check('mobile: (?) shows how to log on', /MVSCE02/.test(help) && /USER0001/.test(help), help.replace(/\s+/g, ' ').slice(0, 200));
    await page.click('#help-dialog .sheet-close');
    await shot('mobile-ready');
  }
  if (flag('prep')) {
    await key('Escape');
    await typeLine("edit 'mvsce02.clist(upgtest)' new data");
    await waitText(/^\s*00010\s*$/m, 60000, 'EDIT input mode');
    await page.keyboard.type('UPGRADE TEST LINE SAVED BEFORE THE KICKS UPDATE', { delay: 10 }); await page.keyboard.press('Enter');
    await waitText(/^\s*00020\s*$/m, 30000, 'line 20'); await page.keyboard.press('Enter');
    await waitText(/^\s*EDIT\s*$/m, 30000, 'EDIT mode');
    await typeLine('save'); await sleep(1500); await typeLine('end');
    await ready(60000);
    t = await cmd("alloc da('mvsce02.upgtest.data') new catalog space(1,1) tracks");
    t = await cmd("free da('mvsce02.upgtest.data')");
    t = await cmd("listcat level(mvsce02)");
    check('prep: data set and member cataloged', /UPGTEST\.DATA/.test(t) && /MVSCE02\.CLIST/.test(t), t.split('\n').filter((l) => /MVSCE02/.test(l)).map((l) => l.trim()));
    t = await cmd("listds 'mvsce02.clist' members");
    check('prep: member in the directory', /UPGTEST/.test(t), t.split('\n').filter((l) => l.trim()).slice(-8).map((l) => l.trim()));
    t = await memberText('mvsce02.clist(upgtest)');
    check('prep: member saved', /UPGRADE TEST LINE/.test(t), null);
  }
  if (flag('check-saved')) {
    t = await cmd('listcat level(mvsce02)');
    check('saved: data set still cataloged', /MVSCE02\.UPGTEST\.DATA/.test(t), t.split('\n').filter((l) => /MVSCE02/.test(l)).map((l) => l.trim()));
    t = await memberText('mvsce02.clist(upgtest)');
    check('saved: member still there', /UPGRADE TEST LINE SAVED BEFORE/.test(t), t.split('\n').filter((l) => l.trim()).slice(-6).map((l) => l.trim()));
    t = await cmd("listds 'mvsce02.upgtest.data'");
    check('saved: data set on its volume', !/NOT IN CATALOG|NOT FOUND/.test(t), t.split('\n').filter((l) => l.trim()).slice(-5).map((l) => l.trim()));
    await shot('saved');
  }
  if (!flag('no-kicks') && !flag('prep') && !flag('carddemo-only')) {
    await key('Escape');
    const tk = Date.now();
    await typeLine('kicks');
    for (let i = 0; ; i++) {     // module load list ('***' screens) until the KSGM sign-on map
      t = await text();
      if (/KSGM for tso user|CLEAR to continue/.test(t)) break;
      if (/^\s*\*\*\*\s*$/m.test(t) && await ev(() => window.mvs.unlocked('tso1'))) { await page.keyboard.press('Enter'); await sleep(500); continue; }
      if (/NOT FOUND|NOT IN CATALOG|ABEND|IKJ56/.test(t) || i > 600) { console.log(t); throw new Error('KICKS did not start'); }
      await sleep(250);
    }
    res.kicksStartS = Number(((Date.now() - tk) / 1000).toFixed(1));
    step('KICKS sign-on screen', { s: res.kicksStartS });
    await shot('kicks-ksgm');
    for (let i = 0; i < 5 && /KSGM for/.test(await text()); i++) { await sleep(1000); await key('Escape'); await sleep(1000); }   // Clear
    check('KICKS: Clear leaves the sign-on screen', !/KSGM for/.test(await text()), null);
    if (process.env.KDEBUG) console.log('--- after clear:\n' + (await text()).split('\n').filter((l) => l.trim()).join('\n'), await ev(() => window.mvs.oia?.('tso1')));
    await unlocked(); await page.keyboard.type('INQ1', { delay: 30 }); await sleep(500);
    if (process.env.KDEBUG) console.log('--- typed:\n' + (await text()).split('\n').filter((l) => l.trim()).join('\n'), await ev(() => window.mvs.oia?.('tso1')));
    await page.keyboard.press('Enter'); await sleep(2000);
    if (process.env.KDEBUG) console.log('--- entered:\n' + (await text()).split('\n').filter((l) => l.trim()).slice(0, 5).join('\n'));
    await waitText(/CUSTOMER|Customer/, 60000, 'INQ1 map');
    await unlocked(); await page.keyboard.type('400001', { delay: 20 }); await page.keyboard.press('Enter');
    t = await waitText(/MCDONALD/i, 60000, 'customer 400001 (MCDONALD)');
    check('KICKS INQ1 400001 shows MCDONALD', true, t.split('\n').filter((l) => /MCDONALD|400001/i.test(l)).map((l) => l.trim()));
    await shot('kicks-inq1-400001');
    await key('F3');
    t = await waitText(/Master Menu|MASTER MENU/, 30000, 'Murach master menu');
    await shot('kicks-murach-menu');
    await key('F3'); await sleep(1000);
    await key('Escape'); await typeLine('BTC0');
    await waitText(/MASTER MENU|TACMENU/, 60000, 'TAC menu');
    await shot('kicks-tac-menu');
    await key('F12'); await sleep(1500);
    await key('Escape'); await typeLine('KSSF');
    // KICKS ends with a blank screen; TSO shows READY after the next Enter
    await sleep(3000);
    res.afterKssf = (await text()).split('\n').filter((l) => l.trim()).map((l) => l.trim());
    if (!res.afterKssf.length) await key('Enter');
    await ready(60000);
    step('KSSF: back at READY', { blankAfterKssf: !res.afterKssf.length });
    check('KICKS ended (KSSF -> READY)', true, null);
  }
  if (flag('carddemo') || flag('carddemo-only')) {
    // CARDDEMO: KICKS with CardDemo's tables; its first transaction CC00 shows the sign-on screen
    const signon = async () => {
      await key('Escape');
      const tc = Date.now();
      await typeLine('carddemo');
      for (let i = 0; ; i++) {
        t = await text();
        if (/Type your User ID and Password/.test(t)) break;
        if (/^\s*\*\*\*\s*$/m.test(t) && await ev(() => window.mvs.unlocked('tso1'))) { await page.keyboard.press('Enter'); await sleep(500); continue; }
        if (/NOT FOUND|NOT IN CATALOG|ABEND|IKJ56|Abend/.test(t) || i > 600) { console.log(t); throw new Error('CardDemo did not start'); }
        await sleep(250);
      }
      return Number(((Date.now() - tc) / 1000).toFixed(1));
    };
    const leave = async () => {   // PF3 back to the sign-on screen, PF3 ends CardDemo, KSSF ends KICKS
      for (let i = 0; i < 4 && !/Type your User ID/.test(await text()); i++) { await key('F3'); await sleep(1500); }
      await key('F3'); await sleep(1500);
      await key('Escape'); await typeLine('KSSF'); await sleep(3000);
      // KICKS ends with a blank screen or 'KICKS is shutting down...': Enter (when the keyboard is free) until READY
      for (let i = 0; i < 30 && !/READY\s*$/m.test(await text()); i++) {
        if (await ev(() => window.mvs.unlocked('tso1'))) await page.keyboard.press('Enter');
        await sleep(2000);
      }
      await ready(60000);
    };
    res.carddemoStartS = await signon();
    step('CardDemo sign-on screen', { s: res.carddemoStartS });
    await shot('carddemo-signon');
    check('CardDemo: sign-on screen without a message', !/Invalid key/.test(await text()), null);
    await sleep(1500); await key('Home'); await page.keyboard.type('USER0001PASSWORD', { delay: 20 }); await page.keyboard.press('Enter');
    t = await waitText(/Main Menu/, 60000, 'CardDemo main menu');
    check('CardDemo: USER0001 signs on (main menu)', /Account View/.test(t), null);
    await shot('carddemo-menu');
    await typeLine('1');
    t = await waitText(/View Account|Account Number/, 60000, 'account view');
    await unlocked(); await page.keyboard.type('00000000001', { delay: 20 }); await page.keyboard.press('Enter');
    t = await waitText(/Kessler|KESSLER/, 60000, 'account 00000000001 (Immanuel Kessler)');
    check('CardDemo: account 00000000001 shows its customer', /Immanuel/.test(t), t.split('\n').filter((l) => /Kessler|Immanuel|00000000001/.test(l)).map((l) => l.trim()));
    await shot('carddemo-account');
    await key('F3');
    t = await waitText(/Main Menu/, 30000, 'main menu again');
    // pending authorizations (IMS and Db2 upstream, VSAM here): account 00000000013, S on the first one shows it,
    // PF5 marks it as fraud or takes the mark away (the detail is rewritten), and showing it again reads it back
    await typeLine('11');
    t = await waitText(/View Authorizations/, 30000, 'pending authorizations screen');
    await unlocked(); await page.keyboard.type('00000000013', { delay: 20 }); await page.keyboard.press('Enter');
    t = await waitText(/Approval #/, 30000, 'authorizations of account 00000000013');
    await sleep(1000); t = await text();
    const authRows = t.split('\n').filter((l) => /\d\d\/\d\d\/\d\d +\d\d:\d\d:\d\d/.test(l));
    check('CardDemo: pending authorizations of account 00000000013 listed', authRows.length >= 5, authRows.slice(0, 2).map((l) => l.trim()));
    await shot('carddemo-authorizations');
    const fraudOf = (s) => ((s.match(/Fraud Status: *(\S*)/) || [])[1] || '');
    const showFirst = async (what) => {
      await key('Home'); await key('Tab'); await page.keyboard.type('S', { delay: 20 }); await page.keyboard.press('Enter');
      return waitText(/View Authorization Details/, 30000, what);
    };
    t = await showFirst('authorization details');
    const fraudBefore = fraudOf(t);
    await key('F5');
    t = await waitText(/Fraud Status: *\S/, 30000, 'fraud status after PF5');
    await sleep(1000); t = await text();
    const fraudAfter = fraudOf(t);
    await shot('carddemo-authorization-fraud');
    await key('F3');
    t = await waitText(/View Authorizations/, 30000, 'authorizations again');
    t = await showFirst('authorization details again');
    check('CardDemo: authorization fraud mark saved (PF5, shown again)', fraudAfter !== fraudBefore && fraudOf(t) === fraudAfter,
      { before: fraudBefore, after: fraudAfter, again: fraudOf(t) });
    await key('F3');
    t = await waitText(/View Authorizations/, 30000, 'authorizations list');
    await key('F3');
    t = await waitText(/Main Menu/, 30000, 'main menu after authorizations');
    // bill payment (a write): account 00000000001 pays its balance, then the account shows 0
    await typeLine('10');
    t = await waitText(/Bill Payment/i, 30000, 'bill payment screen');
    await unlocked(); await page.keyboard.type('00000000001', { delay: 20 }); await page.keyboard.press('Enter');
    t = await waitText(/Confirm to make a bill payment|You have nothing to pay/, 30000, 'bill payment balance');
    if (/Confirm to make/.test(t)) { await unlocked(); await page.keyboard.type('Y', { delay: 20 }); await page.keyboard.press('Enter'); }
    t = await waitText(/Payment successful|You have nothing to pay/, 30000, 'bill payment done');
    check('CardDemo: bill payment', true, t.split('\n').filter((l) => /Payment successful|nothing to pay|balance/i.test(l)).map((l) => l.trim()));
    await shot('carddemo-bill-payment');
    await key('F3');
    t = await waitText(/Main Menu/, 30000, 'main menu after bill payment');
    // card update (a write): the name on card 9680294154603697 changes, then the card view shows it
    await typeLine('5');
    t = await waitText(/Update Credit Card Details/, 30000, 'card update screen');
    await unlocked(); await page.keyboard.type('000000000019680294154603697', { delay: 20 }); await page.keyboard.press('Enter');
    t = await waitText(/Details of selected card shown above/, 30000, 'card details');
    const newName = /WEBMVS TESTER A/.test(t) ? 'Webmvs Tester B' : 'Webmvs Tester A';
    await key('End'); await page.keyboard.type(newName, { delay: 20 }); await page.keyboard.press('Enter');
    t = await waitText(/Changes validated/, 30000, 'card update validated');
    await key('F5');
    t = await waitText(/Changes committed to database/, 30000, 'card update saved');
    await shot('carddemo-card-update');
    await key('F3');
    t = await waitText(/Main Menu/, 30000, 'main menu after card update');
    await typeLine('4');
    t = await waitText(/View Credit Card Detail/, 30000, 'card view screen');
    await unlocked(); await page.keyboard.type('000000000019680294154603697', { delay: 20 }); await page.keyboard.press('Enter');
    t = await waitText(new RegExp(newName.toUpperCase()), 30000, 'card view shows the new name');
    check(`CardDemo: card update saved (card view shows ${newName.toUpperCase()})`, true, t.split('\n').filter((l) => /Name on card/.test(l)).map((l) => l.trim()));
    await shot('carddemo-card-view-updated');
    await key('F3');
    t = await waitText(/Main Menu/, 30000, 'main menu after card view');
    // transaction report: a custom date range, Y submits the report job (TRNRPT00 writes CARDDEMO.TRANREPT)
    await typeLine('9');
    t = await waitText(/Transaction Reports/, 30000, 'report screen');
    await unlocked(); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    await page.keyboard.type('X0101202212312022Y', { delay: 20 }); await page.keyboard.press('Enter');
    t = await waitText(/report submitted for printing/, 30000, 'report submitted');
    check('CardDemo: transaction report submitted', true, t.split('\n').filter((l) => /submitted/.test(l)).map((l) => l.trim()));
    await shot('carddemo-report-submitted');
    await key('F3');
    t = await waitText(/Main Menu/, 30000, 'main menu after the report');
    await leave();
    step('CardDemo user: back at READY');
    // the report at READY: REVIEW shows CARDDEMO.TRANREPT once the job has written it
    for (let i = 0; ; i++) {
      await key('Escape'); await typeLine("review 'carddemo.tranrept'");
      await sleep(3000); t = await text();
      if (/Daily Transaction Report/.test(t)) break;
      if (i > 20) { console.log(t); throw new Error('no report in CARDDEMO.TRANREPT'); }
      if (!/READY\s*$/m.test(t)) { await key('F3'); }
      await ready(60000); await sleep(5000);
    }
    // the report is 133 columns wide: the date range is right of the 80 REVIEW shows; the detail lines start with
    // the 16-digit transaction id
    const rptLines = t.split('\n').filter((l) => /^\s*\d{16}\s/.test(l));
    check('CardDemo: the report shows in REVIEW (header and transactions)', /DALYREPT/.test(t) && rptLines.length > 0,
      [t.split('\n').find((l) => /DALYREPT/.test(l)), ...rptLines.slice(0, 2)].map((l) => (l || '').trim()));
    await shot('carddemo-report');
    await key('F3'); await ready(60000);
    // the interest job: SUBMIT at READY, then REVIEW shows the interest transactions it wrote to CARDDEMO.SYSTRAN
    // (the id starts with the job's date parameter 2022071800, type 01, category 0005)
    await key('Escape'); await typeLine("submit 'carddemo.jcl(intcalc)'");
    await ready(60000);
    for (let i = 0; ; i++) {
      await sleep(5000);
      await key('Escape'); await typeLine("review 'carddemo.systran'");
      await sleep(3000); t = await text();
      if (/2022071800000001010005/.test(t)) break;
      if (i > 20) { console.log(t); throw new Error('no interest transactions in CARDDEMO.SYSTRAN'); }
      if (!/READY\s*$/m.test(t)) { await key('F3'); }
      await ready(60000);
    }
    const intLines = t.split('\n').filter((l) => /20220718\d{8}010005/.test(l));
    check('CardDemo: the interest job (INTCALC) writes interest transactions', intLines.length > 1,
      intLines.slice(0, 2).map((l) => l.trim().slice(0, 60)));
    await shot('carddemo-interest');
    await key('F3'); await ready(60000);
    await signon();
    await sleep(1500); await key('Home'); await page.keyboard.type('ADMIN001PASSWORD', { delay: 20 }); await page.keyboard.press('Enter');
    t = await waitText(/Admin Menu/i, 60000, 'CardDemo admin menu');
    await shot('carddemo-admin-menu');
    // add a user (a write), then the user list shows it
    await typeLine('2');
    t = await waitText(/Add User/, 30000, 'add user screen');
    await unlocked();
    for (const [v, tab] of [['Webmvs', true], ['Tester', true], ['A0WEBMVS', false], ['PASSWORD', false], ['U', false]]) {
      await page.keyboard.type(v, { delay: 20 }); if (tab) await page.keyboard.press('Tab');
    }
    await page.keyboard.press('Enter');
    t = await waitText(/has been added|already exist/i, 30000, 'user added');
    check('CardDemo: admin adds user A0WEBMVS', true, t.split('\n').filter((l) => /A0WEBMVS|added|exist/i.test(l)).map((l) => l.trim()));
    await shot('carddemo-add-user');
    await key('F3');
    t = await waitText(/Admin Menu/i, 30000, 'admin menu again');
    await typeLine('1');
    t = await waitText(/USER0001/, 60000, 'user list');
    check('CardDemo: admin user list shows the new user A0WEBMVS', /A0WEBMVS/.test(t), t.split('\n').filter((l) => /A0WEBMVS|USER0001/.test(l)).map((l) => l.trim()));
    await shot('carddemo-user-list');
    // transaction types (a VSAM file here): add type 50 (unless a run before added it), then the list deletes it
    await key('F3');
    t = await waitText(/Admin Menu/i, 30000, 'admin menu after the user list');
    await typeLine('6');
    t = await waitText(/Enter transaction type to be maintained/, 30000, 'transaction type maintenance');
    await unlocked(); await page.keyboard.type('50', { delay: 20 }); await page.keyboard.press('Enter');
    t = await waitText(/Press F05 to add|Update transaction type details/, 30000, 'type 50 looked up');
    if (/Press F05 to add/.test(t)) {
      await key('F5');
      t = await waitText(/Enter new transaction type details/, 30000, 'new type');
      await unlocked(); await page.keyboard.type('Webmvs test type', { delay: 20 }); await page.keyboard.press('Enter');
      t = await waitText(/Changes validated/, 30000, 'type validated');
      await key('F5');
      t = await waitText(/Changes committed to database/, 30000, 'type added');
      check('CardDemo: admin adds transaction type 50', true, t.split('\n').filter((l) => /50|committed/.test(l)).map((l) => l.trim()));
      await shot('carddemo-type-added');
    }
    await key('F3');
    t = await waitText(/Admin Menu/i, 30000, 'admin menu after the type maintenance');
    await typeLine('5');
    t = await waitText(/Type U to update, D to delete/, 30000, 'transaction type list');
    check('CardDemo: transaction type list', /01\s+Purchase/.test(t), t.split('\n').filter((l) => /^\s+0[1-7]\s/.test(l)).map((l) => l.trim()));
    await key('Home'); await page.keyboard.type('50', { delay: 20 }); await page.keyboard.press('Enter');
    t = await waitText(/50\s+WEBMVS TEST TYPE/, 30000, 'type 50 in the list');
    check('CardDemo: the list shows the added type 50', true, t.split('\n').filter((l) => /WEBMVS/.test(l)).map((l) => l.trim()));
    await key('Home'); await key('Tab'); await key('Tab'); await page.keyboard.type('D', { delay: 20 }); await page.keyboard.press('Enter');
    t = await waitText(/Delete HIGHLIGHTED row/, 30000, 'delete type 50');
    await key('F10');
    t = await waitText(/row deleted/, 30000, 'type 50 deleted');
    check('CardDemo: admin deletes transaction type 50', true, t.split('\n').filter((l) => /deleted/.test(l)).map((l) => l.trim()));
    await shot('carddemo-type-deleted');
    await leave();
    step('CardDemo admin: back at READY');
  }
  await key('Escape'); await typeLine('logoff');
  await waitText(/Logon ===>|CLEAR the screen|LOGGED OFF/, 30000, 'logged off').catch(() => {});
  step('LOGOFF');
  if (flag('shutdown') || flag('prep')) {
    await ev(() => { void window.mvs.shutdown(); });
    await waitFn(() => window.mvsState === 'off', null, 300000, 'shutdown complete');
    await waitFn(() => window.mvs.persist?.()?.herculesStopped ?? true, null, 30000, 'Hercules stopped');
    res.shadows = await ev(() => window.mvs.shadows?.() ?? null);
    step('shut down', { shadows: res.shadows });
  }
  check('no page errors', consoleErrors.length === 0, consoleErrors);
  res.ok = true;
} catch (e) {
  res.error = String(e?.stack || e);
  console.log('FAIL', res.error);
  await shot('fail').catch(() => {});
} finally {
  fs.writeFileSync(path.join(OUT, `kicks-${TAG}.json`), JSON.stringify(res, null, 1));
  await ctx.close().catch(() => {}); if (br) await br.close().catch(() => {});
  console.log(res.ok ? 'E2E-KICKS OK' : 'E2E-KICKS FAILED');
  process.exit(res.ok ? 0 : 1);
}
