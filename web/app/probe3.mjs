// Extra views: ?debug=1 desktop, mobile layout with keypad, ?console=late fallback.
// Usage: node probe3.mjs <debug|mobile|late> <url> <out dir>   (needs a fresh Hercules for debug/late)
import { chromium } from 'playwright';
const [mode, url, out] = process.argv.slice(2);
const br = await chromium.launch();
const opts = mode === 'mobile'
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
  : { viewport: { width: 1280, height: 860 } };
const page = await (await br.newContext(opts)).newPage();
const wait = async (fn, ms, what) => { const end = Date.now() + ms; for (;;) { if (await page.evaluate(fn).catch(() => false)) return; if (Date.now() > end) throw new Error(`timeout: ${what}`); await page.waitForTimeout(250); } };
const r = { mode, url };
try {
  await page.goto(url);
  await wait(() => window.mvsState === 'tso', 90000, 'tso');
  r.coi = await page.evaluate(() => self.crossOriginIsolated);
  r.events = await page.evaluate(() => window.mvs.events());
  await page.waitForTimeout(2500);
  if (mode === 'mobile') {
    r.keypadVisible = await page.evaluate(() => !document.getElementById('keypad').hidden);
    await page.screenshot({ path: `${out}/mobile-tso.png` });
    await page.tap('button.tab[data-tab="console"]'); await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/mobile-console.png` });
  } else if (mode === 'debug') {
    r.debugVisible = await page.evaluate(() => !document.getElementById('debug').hidden);
    await page.click('button.tab[data-tab="console"]'); await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/debug.png` });
  } else {
    r.console = await page.evaluate(() => window.mvs.text('console'));
    await page.click('button.tab[data-tab="console"]'); await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/late-console.png` });
  }
  r.ok = true;
} catch (e) { r.error = String(e); await page.screenshot({ path: `${out}/${mode}-failure.png` }).catch(() => {}); }
console.log(JSON.stringify(r, null, 1));
await br.close();
