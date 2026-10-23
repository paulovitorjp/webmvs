#!/usr/bin/env node
// unit test of the keyboard hold (termview.ts KBD_HOLD), see kbdhold-entry.ts.
// Usage (from the repo or web/app; needs web/app/node_modules esbuild): node web/app/test/kbdhold-unit.mjs
// Runs the replay 4 times: hold on / off (?kbdhold=0) x 2 prompt variants. Pass = hold on gives 6 characters in both
// variants (and hold off reproduces the lost first character, which shows the test hits the race).
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..'), tn = join(app, '..', 'vendor', 'tn3270');
const out = join(os.tmpdir(), `kbdhold-${process.pid}.mjs`);
const shim = `globalThis.location={search:process.env.Q||''};globalThis.window=globalThis;globalThis.requestAnimationFrame=()=>0;
globalThis.ResizeObserver=class{observe(){}};globalThis.document={createElement:()=>({getContext:()=>({}),style:{}})};`;
await build({ entryPoints: [join(here, 'kbdhold-entry.ts')], bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile: out,
  banner: { js: shim }, logLevel: 'warning',
  alias: { '@tn3270/core': join(tn, 'packages', 'core', 'src', 'index.ts'), '@tn3270/frontend': join(app, 'src', 'frontend-browser.ts') } });
let bad = 0;
for (const variant of ['ic80', 'sf80']) {
  for (const q of ['', '?kbdhold=0']) {
    const r = spawnSync(process.execPath, [out], { env: { ...process.env, Q: q, VARIANT: variant }, encoding: 'utf8' });
    const line = (r.stdout || '').trim().split('\n').pop() || r.stderr;
    let j = {}; try { j = JSON.parse(line); } catch { /* error text */ }
    const expectOk = q === '';
    const pass = expectOk ? r.status === 0 : r.status !== 0;
    if (!pass) bad++;
    console.log(`${pass ? 'PASS' : 'FAIL'} variant=${variant} ${q || 'hold on'}: chars=${j.chars} ok=${j.ok} unlockedBetween=${j.unlockedBetween} holds=${j.typeahead?.holds} queued=${j.typeahead?.queued} replayed=${j.typeahead?.replayed}${expectOk ? '' : ' (control: the race is reproduced)'}`);
    if (!pass) console.log(line);
  }
}
console.log(bad ? `KBDHOLD-UNIT FAIL ${bad}` : 'KBDHOLD-UNIT PASS 4/4');
process.exit(bad ? 1 : 0);
