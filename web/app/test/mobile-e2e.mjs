// Mobile check: iPhone emulation (touch), boot to the TSO logon screen, tap the terminal, check the
// soft-keyboard capture box keeps the focus after the tap, type a user ID with key events and with
// soft-keyboard input events, and check it reaches the 3270 screen.
// Usage: node test/mobile-e2e.mjs <chromium|webkit> <url> <out dir> [video=1]
import { chromium, webkit, devices } from 'playwright';
const [B = 'chromium', URL0 = 'http://127.0.0.1:8231/', OUT = '/tmp', VIDEO = '0'] = process.argv.slice(2);
const T0 = Date.now(); const el = () => ((Date.now() - T0) / 1000).toFixed(1);
const log = (s) => console.log(`[${el()}s] ${s}`);
const br = await ({ chromium, webkit })[B].launch();
const ctx = await br.newContext({ ...devices['iPhone 13'], ...(VIDEO === '1' ? { recordVideo: { dir: OUT, size: { width: 390, height: 664 } } } : {}) });
const page = await ctx.newPage();
page.on('pageerror', (e) => log(`pageerror: ${e.message}`));
await page.goto(URL0);
const text = (id) => page.evaluate((i) => window.mvs?.text(i) ?? '', id).catch(() => '');
async function wait(fn, ms, what) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await page.waitForTimeout(250); } }
log(`isolated=${await page.evaluate(() => self.crossOriginIsolated)}`);
const id = 'tso1';
await wait(async () => /CLEAR the screen or hit ENTER|TSO Logon ===>|Logon ===>/.test(await text(id)), 300000, 'TSO logon screen');
const bootS = el(); log(`TSO logon screen up (boot ${bootS}s)`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/${B}-1-logon.png` });
const canvas = page.locator('#view-tso1 canvas');
await canvas.tap();
await page.waitForTimeout(400);
const focused = await page.evaluate(() => document.activeElement?.id);
log(`after tap release: activeElement=${focused}`);
if (!/Logon ===>/.test(await text(id))) { await page.keyboard.press('Enter'); await wait(async () => /Logon ===>/.test(await text(id)), 30000, 'logon prompt'); }
await wait(() => page.evaluate((i) => window.mvs.unlocked(i), id), 20000, 'unlocked');
// key events (iOS hardware/soft keys with key values) for "LOGON ", then soft-keyboard input events for the user
await page.keyboard.type('LOGON ', { delay: 40 });
await page.evaluate(() => { const c = document.getElementById('kbd-capture'); for (const ch of 'MVSCE02') { c.value += ch; c.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true })); } });
await page.waitForTimeout(500);
const scr = await text(id);
const typed = /LOGON MVSCE02/i.test(scr);
log(`typed text on screen: ${typed}; still focused: ${await page.evaluate(() => document.activeElement?.id)}`);
await page.screenshot({ path: `${OUT}/${B}-2-typed.png` });
// soft-keyboard Enter (beforeinput insertLineBreak)
await page.evaluate(() => { const c = document.getElementById('kbd-capture'); c.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true })); });
const pw = await wait(async () => /PASSWORD/.test(await text(id)), 30000, 'password prompt').catch(() => false);
log(`soft Enter -> password prompt: ${!!pw}`);
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/${B}-3-password.png` });
console.log(JSON.stringify({ browser: B, url: URL0, bootS: Number(bootS), focusedAfterTap: focused, typed, softEnter: !!pw }));
await ctx.close(); await br.close();
