#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// File transfer test of the visitor page: Download / Upload (IND$FILE, DFT) from TSO READY (Playwright).
//
// Usage: node scripts/e2e-ft.mjs <chromium|firefox|webkit> <url> <out dir> <tag> [--mobile]
//   log on MVSCE02; Upload dialog: a text file (with the file picker) to a new data set MVSCE02.WEBMVS.FTTEXT,
//   LISTDS shows it; Download dialog: it comes back as a browser download with the same lines; binary round trip
//   of 256 x 40 bytes (RECFM U) through MVSCE02.WEBMVS.FTBIN, byte for byte; downloads of SYS1.PARMLIB(IEASYS00)
//   and CARDDEMO.COPYLIB(COSGN00); a data set that does not exist and a transfer away from READY give errors;
//   TSO is at READY after each transfer. --mobile: iPhone viewport, the buttons are in the More (...) sheet.
// Output: <out>/ft-<tag>.json, screenshots <out>/<tag>-<step>.png
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
const res = { kind: 'ft', browser: B, url: URL0, tag: TAG, date: new Date().toISOString(), steps: [], checks: {}, ok: false };
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


const TEXT = ['//FTTEST   JOB (1),WEBMVS', '* webmvs file transfer test: lower case, digits 0123456789', '  symbols !"#$%&()*+,-./:;<=>?@[]_{|}~',
  'LAST LINE ' + 'X'.repeat(60)].join('\r\n') + '\r\n';
const BIN = Buffer.alloc(256 * 40); for (let i = 0; i < BIN.length; i++) BIN[i] = (i * 7 + (i >> 8)) & 0xff;
const lines = (s) => s.replace(/\r\n$/, '').split('\r\n').map((l) => l.replace(/ +$/, ''));
async function openXfer(dir) {
  if (MOBILE) { await page.click('#more-btn'); if (!res.moreShot) { res.moreShot = true; await shot('more-menu'); } await page.click(`#more-items button:has-text("${dir === 'upload' ? 'Upload' : 'Download'}")`); }
  else await page.click(dir === 'upload' ? '#upload-btn' : '#download-btn');
  await waitFn(() => document.getElementById('xfer-dialog').open, null, 5000, 'transfer dialog');
}
const status = () => ev(() => ({ text: document.getElementById('xfer-status').textContent, cls: document.getElementById('xfer-status').className }));
async function waitDone(ms = 120000) {
  return waitFn(() => { const s = document.getElementById('xfer-status'); return (s.className === 'ok' || s.className === 'err') && !document.getElementById('xfer-go').disabled ? { text: s.textContent, cls: s.className } : null; }, null, ms, 'transfer end');
}
async function closeXfer() { await page.click('#xfer-cancel'); await waitFn(() => !document.getElementById('xfer-dialog').open, null, 5000, 'dialog closed'); }

try {
  await page.goto(URL0, { waitUntil: 'load', timeout: 120000 });
  await waitFn(() => window.mvs && !document.getElementById('app').hidden, null, 180000, 'app visible');
  await waitFn(() => window.mvs.active() === 'tso1', null, 240000, 'TSO ready (auto-switch)');
  if (!(await ev(() => document.getElementById('notice').hidden))) await page.click('#notice-close');
  // the dialog before log on: it says to log on first
  await openXfer('download');
  const pre = await status();
  check('before log on: the dialog says to log on to READY', /READY/.test(pre.text), pre);
  await shot('dialog-before-logon');
  await closeXfer();
  let t = await waitText(/CLEAR the screen or hit ENTER|TSO Logon ===>|Logon ===>/, 60000, 'logon screen');
  if (!/Logon ===>/.test(t)) { await key('Enter'); await waitText(/Logon ===>/, 30000, 'Logon ===>'); }
  await typeLine('logon mvsce02');
  await waitText(/ENTER CURRENT PASSWORD FOR MVSCE02/, 60000, 'password prompt');
  await typeLine('PASS4U');
  await ready(120000);
  step('READY');
  await cmd("delete ('mvsce02.webmvs.fttext' 'mvsce02.webmvs.ftbin')", 60000);   // from an earlier run of the same profile

  // 1. upload a text file with the dialog and the file picker
  await openXfer('upload');
  await page.fill('#xfer-dsn', 'mvsce02.webmvs.fttext');
  await page.setInputFiles('#xfer-file', { name: 'fttest.txt', mimeType: 'text/plain', buffer: Buffer.from(TEXT, 'latin1') });
  await shot('upload-dialog');
  let t0 = Date.now();
  await page.click('#xfer-go');
  let s = await waitDone();
  res.uploadText = { ...s, ms: Date.now() - t0, last: await ev(() => window.mvs.xferLast()) };
  check('upload text: done', s.cls === 'ok' && /Uploaded \d+ bytes/.test(s.text), res.uploadText);
  await shot('upload-done');
  await closeXfer();
  await ready(30000);
  t = await cmd("listds 'mvsce02.webmvs.fttext'", 60000);
  check('upload text: LISTDS shows the new data set (FB 80)', /MVSCE02\.WEBMVS\.FTTEXT/.test(t) && /FB\s+80/.test(t), t.split('\n').filter((l) => l.trim()).slice(-6));

  // 2. download it with the dialog: a browser download
  await openXfer('download');
  await page.fill('#xfer-dsn', "'MVSCE02.WEBMVS.FTTEXT'");
  t0 = Date.now();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#xfer-go')]);
  s = await waitDone();
  const got = fs.readFileSync(await dl.path()).toString('latin1');
  res.downloadText = { ...s, ms: Date.now() - t0, file: dl.suggestedFilename(), bytes: got.length };
  check('download text: browser download named mvsce02.webmvs.fttext.txt', dl.suggestedFilename() === 'mvsce02.webmvs.fttext.txt', res.downloadText);
  check('download text: same lines as uploaded (FB 80: trailing blanks aside)', JSON.stringify(lines(got)) === JSON.stringify(lines(TEXT)), { got: lines(got), want: lines(TEXT) });
  await shot('download-done');
  await closeXfer();
  await ready(30000);

  // 3. binary round trip (RECFM U), byte for byte
  t0 = Date.now();
  let r = await ev((b64) => window.mvs.transfer({ direction: 'upload', dsn: 'MVSCE02.WEBMVS.FTBIN', format: 'binary', recfm: 'U', blksize: 6144, b64 }), BIN.toString('base64'));
  res.uploadBin = { ok: r.ok, bytes: r.bytes, error: r.error, command: r.command, ms: Date.now() - t0 };
  check('upload binary: done', r.ok && r.bytes === BIN.length, res.uploadBin);
  await ready(30000);
  t0 = Date.now();
  r = await ev(() => window.mvs.transfer({ direction: 'download', dsn: 'MVSCE02.WEBMVS.FTBIN', format: 'binary' }));
  const back = Buffer.from(r.b64 ?? '', 'base64');
  res.downloadBin = { ok: r.ok, bytes: back.length, error: r.error, command: r.command, ms: Date.now() - t0 };
  check('binary round trip: the same bytes', r.ok && back.equals(BIN), { ...res.downloadBin, firstDiff: [...back].findIndex((x, i) => x !== BIN[i]) });
  await ready(30000);

  // 4. existing data sets
  r = await ev(() => window.mvs.transfer({ direction: 'download', dsn: 'SYS1.PARMLIB(IEASYS00)', format: 'text' }));
  let txt = Buffer.from(r.b64 ?? '', 'base64').toString('latin1');
  res.parmlib = { ok: r.ok, bytes: r.bytes, first: txt.split('\r\n')[0] };
  check('download SYS1.PARMLIB(IEASYS00)', r.ok && /^APF=00,\s+IEAAPF00/.test(txt) && lines(txt).length === 19, res.parmlib);
  await ready(30000);
  r = await ev(() => window.mvs.transfer({ direction: 'download', dsn: 'CARDDEMO.COPYLIB(COSGN00)', format: 'text' }));
  txt = Buffer.from(r.b64 ?? '', 'base64').toString('latin1');
  res.carddemo = { ok: r.ok, bytes: r.bytes, lines: lines(txt).length };
  check("download CARDDEMO.COPYLIB(COSGN00) (the sign-on map's copybook)", r.ok && /'BMS' map for use with 'KICKS for TSO'/.test(txt) && res.carddemo.lines === 143, res.carddemo);
  await ready(30000);

  // 5. errors
  await openXfer('download');
  await page.fill('#xfer-dsn', 'MVSCE02.NO.SUCH.DATA');
  t0 = Date.now();
  await page.click('#xfer-go');
  s = await waitDone(90000);
  res.notFound = { ...s, ms: Date.now() - t0 };
  check('download of a data set that does not exist: an error in the dialog within 15 s', s.cls === 'err' && /RC=12/.test(s.text) && res.notFound.ms < 15000, res.notFound);
  await shot('error-not-found');
  await closeXfer();
  await ready(60000);
  await key('Escape'); await typeLine('edit fttmp.cntl new');           // EDIT mode: not READY
  await waitText(/^\s*INPUT\s*$/m, 60000, 'EDIT INPUT');
  r = await ev(() => window.mvs.transfer({ direction: 'download', dsn: 'SYS1.PARMLIB(IEASYS00)', format: 'text' }));
  check('away from READY: refused before anything is typed', !r.ok && /READY/.test(r.error ?? ''), r);
  await typeLine(''); await typeLine('end nosave'); await ready(60000);
  t = await cmd('time', 30000);
  check('TSO works after the transfers', /TIME-/.test(t), t.split('\n').filter((l) => l.trim()).slice(-3));
  await cmd("delete ('mvsce02.webmvs.fttext' 'mvsce02.webmvs.ftbin')", 60000);
  await shot('end');
  await typeLine('logoff');
  res.consoleErrors = consoleErrors;
  res.ok = true;
} catch (e) {
  res.error = String(e?.stack ?? e);
  console.log('ERROR', res.error);
  await shot('error').catch(() => {});
} finally {
  res.secs = Number(el());
  fs.writeFileSync(path.join(OUT, `ft-${TAG}.json`), JSON.stringify(res, null, 1));
  console.log(res.ok ? 'PASS' : 'FAIL', `${res.secs}s`);
  await ctx.close(); await br?.close();
  process.exit(res.ok ? 0 : 1);
}
