#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// does a reload download the DASD chunks again? Opens the page, waits for the
// app, reloads in the same browser context, waits again. Run against a static-serve.mjs started with
// SERVE_LOG=1 and count the 200 / 304 lines of its log (this script only drives the browser).
// Usage: node scripts/cache-check.mjs <chromium|firefox> <url>   (env CHANNEL=chrome: the installed Google Chrome)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.join(here, '..', 'web', 'app'), 'package.json'));
const pw = require('playwright');
const [B, URL0] = process.argv.slice(2);
// A persistent context (temporary profile dir) has a disk cache like a normal browser profile; the
// default Playwright context is incognito-like (memory cache only, too small for 8 MiB chunks).
import fs from 'node:fs';
import os from 'node:os';
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mvs-cache-'));
const br = await pw[B].launchPersistentContext(prof, process.env.CHANNEL ? { channel: process.env.CHANNEL } : {});
const page = br.pages()[0] ?? await br.newPage();
const visible = () => page.waitForFunction(() => window.mvs && !document.getElementById('app').hidden, null, { timeout: 120000 });
for (const what of ['first load', 'reload']) {
  const t0 = Date.now();
  if (what === 'first load') await page.goto(URL0); else await page.reload();
  await visible();
  console.log(`${what}: app visible after ${Date.now() - t0} ms; isolated=${await page.evaluate(() => self.crossOriginIsolated)}`);
  console.log(`MARK ${what} done`);
  await page.waitForTimeout(1500);
}
await br.close();
fs.rmSync(prof, { recursive: true, force: true });
