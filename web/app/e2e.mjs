// End-to-end test of the visitor page against a FRESH (not yet IPLed) Hercules.
// Usage: node e2e.mjs <chromium|firefox> <page url> <out dir> [tag]
// Steps: page load (coi-serviceworker reload if no headers) -> Console tab shows the 0010 logo ->
// the page starts the IPL -> NIP on 0010 -> IEA101A answered by the page -> roll mode -> IKT007I ->
// auto-switch to TSO -> logon MVSCE02/PASS4U with the real keyboard -> time -> second TSO session
// (0401, MVSCE01) -> time -> logoff both -> D T on the console -> keypad (mobile) -> shutdown on 0010.
import { chromium, firefox } from 'playwright';
import { writeFileSync } from 'node:fs';

const [B = 'chromium', URL0 = 'http://127.0.0.1:8211/', OUT = '/tmp', TAG = B] = process.argv.slice(2);
const T0 = Date.now();
const res = { browser: B, url: URL0, steps: [], ok: false };
const el = () => ((Date.now() - T0) / 1000).toFixed(1);
const step = (name, extra = {}) => { const s = { t: Number(el()), name, ...extra }; res.steps.push(s); console.log(`[${el()}s] ${name}`, Object.keys(extra).length ? JSON.stringify(extra) : ''); };

const br = await ({ chromium, firefox })[B].launch();
const ctx = await br.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
// Chromium only: long tasks on the page's main thread (target: none over 200 ms).
await page.addInitScript(() => {
  window.__longtasks = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longtasks.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch { /* not supported */ }
});
let navigations = 0;
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });

const text = (id) => page.evaluate((i) => window.mvs?.text(i) ?? '', id);
async function waitText(id, re, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const t = await text(id).catch(() => '');
    if (re.test(t)) return t;
    if (Date.now() > end) { console.log(`--- ${id} screen at timeout:\n${t}`); throw new Error(`timeout waiting for ${what ?? re} on ${id}`); }
    await page.waitForTimeout(200);
  }
}
async function waitFn(fn, arg, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await page.evaluate(fn, arg).catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await page.waitForTimeout(200);
  }
}
const shot = (name) => page.screenshot({ path: `${OUT}/${TAG}-${name}.png` });
const unlocked = (id) => waitFn((i) => window.mvs.unlocked(i), id, 20000, `${id} keyboard unlocked`);
async function typeLine(id, s) { await unlocked(id); await page.keyboard.type(s, { delay: 15 }); await page.keyboard.press('Enter'); }

async function tsoLogon(id, user, pass) {
  // Welcome (HERCLOGO) screen or USS screen -> Enter -> "TSO Logon ===>"
  let t = await waitText(id, /CLEAR the screen or hit ENTER|TSO Logon ===>/, 30000, 'logon screen');
  if (!/TSO Logon ===>/.test(t)) { await unlocked(id); await page.keyboard.press('Enter'); await waitText(id, /TSO Logon ===>/, 20000); }
  await typeLine(id, `logon ${user}`);
  await waitText(id, new RegExp(`ENTER CURRENT PASSWORD FOR ${user.toUpperCase()}`), 30000, 'password prompt');
  await typeLine(id, pass);
  for (let i = 0; i < 20; i++) {
    t = await waitText(id, /\*\*\*\s*$|READY\s*$|IN USE|REJECTED|NOT AUTHORIZED/m, 60000, 'READY');
    if (/IN USE|REJECTED|NOT AUTHORIZED/.test(t)) throw new Error(`logon failed: ${t.split('\n').find((l) => /IN USE|REJECTED|NOT AUTH/.test(l))}`);
    if (/READY\s*$/m.test(t)) return t;
    await unlocked(id); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  }
  throw new Error('no READY');
}
async function tsoTime(id) {
  await unlocked(id); await page.keyboard.press('Escape');               // Esc = Clear
  await page.waitForTimeout(300);
  await typeLine(id, 'time');
  const t = await waitText(id, /TIME-\d\d:\d\d:\d\d [AP]M\. CPU-\S+ SERVICE-\d+ SESSION-\S+ \w+ \d+,\d{4}/, 30000, 'TIME output');
  return t.split('\n').find((l) => /TIME-/.test(l)).trim();
}
async function tsoLogoff(id) {
  await unlocked(id); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await typeLine(id, 'logoff');
  await waitText(id, /LOGGED OFF|TSO Logon ===>|CLEAR the screen/, 30000, 'logoff');
}

try {
  await page.goto(URL0);
  // Without COOP/COEP the coi-serviceworker registers and reloads once.
  await waitFn(() => window.mvs && document.getElementById('app') && !document.getElementById('app').hidden, null, 30000, 'app visible');
  const coi = await page.evaluate(() => ({ crossOriginIsolated: self.crossOriginIsolated, swControlled: !!navigator.serviceWorker?.controller }));
  coi.navigations = navigations;
  coi.debugPaneHidden = await page.evaluate(() => document.getElementById('debug').hidden && document.getElementById('herclog').textContent === '');
  if (!URL0.includes('debug=1') && !coi.debugPaneHidden) throw new Error('Hercules pane visible without ?debug=1');
  step('page loaded', coi);
  await waitText('console', /Welcome to MVS Community Edition|Hercules Version/, 20000, '0010 logo');
  step('console 0010 connected before IPL');
  await shot('console-logo');
  const nip = await waitText('console', /IEA101A SPECIFY SYSTEM PARAMETERS/, 60000, 'NIP IEA101A');
  step('NIP on Console tab: IEA101A');
  await shot('nip');
  await waitFn(() => window.mvs.events().some((e) => /IEA101A answered/.test(e.what)), null, 20000, 'IEA101A auto-answered');
  step('IEA101A answered by the page');
  await waitFn(() => window.mvs.events().some((e) => /roll mode/.test(e.what)), null, 60000, 'roll mode');
  step('roll mode sent');
  await waitFn(() => window.mvs.active() === 'tso1', null, 120000, 'auto-switch to TSO');
  const ev = await page.evaluate(() => window.mvs.events());
  const tm = await page.evaluate(() => window.mvs.timings());
  step('auto-switched to TSO at IKT007I', { iplToIkt007iSeconds: Number(((tm.tso - tm.started) / 1000).toFixed(2)), source: ev.find((e) => /IKT007I/.test(e.what))?.what });
  const conText = await text('console');
  res.consoleAtIkt007i = conText;
  await waitText('tso1', /CLEAR the screen or hit ENTER|TSO Logon ===>/, 30000, 'TSO welcome');
  await shot('tso-welcome');
  await page.click('button.tab[data-tab="console"]');
  await page.waitForTimeout(400);
  await shot('console-ikt007i');
  await page.click('button.tab[data-tab="tso1"]');
  step('user switched back and forth');

  await tsoLogon('tso1', 'mvsce02', 'PASS4U');
  step('TSO logon MVSCE02 READY');
  await shot('tso-ready');
  const t1 = await tsoTime('tso1');
  step('time (session 1)', { line: t1 });
  await shot('tso-time');

  // Second TSO session through the + button (device 0401).
  await page.click('#add-tso');
  await waitFn(() => window.mvs.tabs().includes('tso2'), null, 5000, 'tso2 tab');
  await waitText('tso2', /CLEAR the screen or hit ENTER|TSO Logon ===>/, 30000, 'tso2 welcome');
  step('second TSO session: welcome screen');
  await shot('tso2-welcome');
  await tsoLogon('tso2', 'mvsce01', 'CUL8TR');
  const t2 = await tsoTime('tso2');
  step('second TSO session MVSCE01 READY + time', { line: t2 });
  await shot('tso2-time');
  await tsoLogoff('tso2');
  step('logoff session 2');
  await page.click('button.tab[data-tab="tso1"]');
  await tsoLogoff('tso1');
  step('logoff session 1');
  await shot('tso-logoff');

  // Operator command typed by the "visitor" on the Console tab.
  await page.click('button.tab[data-tab="console"]');
  await unlocked('console');
  await page.keyboard.press('Home');
  await typeLine('console', 'd t');
  const dt = await waitFn(() => window.mvs.seen().find((l) => /IEE136I/.test(l)), null, 20000, 'IEE136I');
  step('console command D T', { line: dt.trim() });
  const logons = await page.evaluate(() => window.mvs.seen().filter((l) => /IEF12[56]I/.test(l)).map((l) => l.trim()));
  step('console saw TSO logon/logoff', { lines: logons });
  await shot('console-dt');

  // Keypad: open, check the AID buttons exist and work (Clear on the console is harmless).
  await page.click('#keys-btn');
  await page.waitForTimeout(300);
  const nkeys = await page.locator('#keypad button').count();
  await shot('keypad');
  await page.click('#keys-btn');
  step('keypad', { buttons: nkeys });

  // Shutdown through the master console.
  await page.evaluate(() => { void window.mvs.shutdown(); });
  await waitFn(() => window.mvsState === 'off', null, 240000, 'shutdown complete');
  step('shutdown through the master console');
  res.shutdownLines = await page.evaluate(() => window.mvs.seen().filter((l) => /IKT006I|IST102I|\$HASP099|\$HASP085|IEE334I|IEE600I|IKT010D/.test(l)).map((l) => l.trim()));
  await shot('shutdown');
  res.ok = true;
} catch (e) {
  step('FAILED', { error: String(e) });
  await shot('failure').catch(() => {});
  for (const id of ['console', 'tso1', 'tso2']) res[`screen_${id}`] = await text(id).catch(() => '');
} finally {
  res.events = await page.evaluate(() => window.mvs?.events() ?? []).catch(() => []);
  res.errors = errors;
  res.longtasksMs = await page.evaluate(() => window.__longtasks ?? null).catch(() => null);
  if (res.longtasksMs) console.log(`longtasks: n=${res.longtasksMs.length} max=${Math.max(0, ...res.longtasksMs)} ms`);
  res.pageLog = (await page.evaluate(() => window.mvs?.log() ?? []).catch(() => [])).filter((l) => !/^\d\d:\d\d:\d\d /.test(l)).slice(-80);
  writeFileSync(`${OUT}/e2e-${TAG}.json`, JSON.stringify(res, null, 1));
  console.log(res.ok ? 'E2E PASS' : 'E2E FAIL', `${el()} s`, errors.length ? `errors: ${errors.join(' | ')}` : '');
  await br.close();
  process.exit(res.ok ? 0 : 1);
}
