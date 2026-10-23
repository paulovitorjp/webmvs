// SPDX-License-Identifier: Apache-2.0
// headless check of web/term-probe with Playwright chromium.
// Opens the probe page, waits for the MVS/CE logon screen text, takes a screenshot, then presses
// Clear (the USS screen asks for CLEAR or ENTER) and takes a second one of the TSO logon prompt.
// It never logs on, so no TSO session is left behind when it disconnects.
// Usage (cwd = web/term-probe): node ../../scripts/term-probe-shot.mjs <page-url> <out-dir>
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// playwright is installed in web/term-probe/node_modules; resolve it from the cwd, not from scripts/.
const { chromium } = createRequire(`${process.cwd()}/`)('playwright');
const [url, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const logs = [];
page.on('console', (m) => logs.push(`console.${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
const t0 = Date.now();
await page.goto(url);
const text = () => page.evaluate(() => (window.probe ? window.probe.text() : ''));
const waitFor = async (re, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await text();
    if (re.test(t)) return t;
    await page.waitForTimeout(200);
  }
  throw new Error(`timeout waiting for ${re}; status=${await page.evaluate(() => window.probeStatus)}\n${await text()}\n${logs.join('\n')}`);
};
let rc = 0;
try {
  const s1 = await waitFor(/CLEAR the screen|Logon|LOGON|MVS/i, 20000);
  await page.waitForTimeout(500);   // let the tinted-atlas bitmaps finish and repaint
  await page.screenshot({ path: `${out}/term-probe-logon.png` });
  writeFileSync(`${out}/term-probe-logon.txt`, s1 + '\n');
  console.log(`screen 1 after ${Date.now() - t0} ms, status: ${await page.evaluate(() => window.probeStatus)}`);
  console.log(`oia: ${await page.evaluate(() => window.probe.oia())}`);
  console.log(s1);
  if (/CLEAR the screen/i.test(s1)) {
    await page.keyboard.press('Control+c');   // Ctrl-C is the Clear AID in tn3270's keymap
    const s2 = await waitFor(/Logon ===>|LOGON/i, 10000);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/term-probe-clear.png` });
    writeFileSync(`${out}/term-probe-clear.txt`, s2 + '\n');
    console.log('--- after Clear');
    console.log(s2);
  }
} catch (e) {
  rc = 1;
  console.log(String(e));
  await page.screenshot({ path: `${out}/term-probe-fail.png` }).catch(() => {});
}
console.log(logs.join('\n'));
await page.evaluate(() => window.probe && window.probe.session.disconnect()).catch(() => {});
await browser.close();
process.exit(rc);
