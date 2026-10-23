// Run out/<variant>.js in headless Chromium and Firefox (Playwright 1.56.1), cross-origin isolated:
// page.route() serves ./out under http://localhost:8223/ (intercepted, no listener; localhost is a trustworthy origin) with COOP same-origin + COEP require-corp
// (needed for SharedArrayBuffer / pthreads). Usage: node run-browsers.mjs <N> <reps> <browser>... -- <variant>...
import { chromium, firefox } from 'playwright';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2); const sep = args.indexOf('--');
const [N, REPS, ...browsers] = args.slice(0, sep); const variants = args.slice(sep + 1);
const engines = { chromium, firefox };
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
const hdrs = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
const page_html = (v) => `<!doctype html><meta charset=utf-8><body><script>
var Module = { arguments: ['${N}', '${REPS}'], print: (s) => console.log(s), printErr: (s) => console.log('ERR ' + s),
  onExit: (c) => console.log('EXIT ' + c) };
window.onerror = (m) => console.log('ERROR ' + m);
console.log('crossOriginIsolated=' + self.crossOriginIsolated);
</script><script src="${v}.js"></script>`;
for (const b of browsers) {
  const opts = b === 'firefox' ? { firefoxUserPrefs: { 'dom.max_script_run_time': 0, 'dom.max_chrome_script_run_time': 0 } } : {};
  const browser = await engines[b].launch(opts);
  console.log(`BROWSER ${b} ${browser.version()}`);
  for (const v of variants) {
    const page = await browser.newPage();
    await page.route('http://localhost:8223/**', (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (name === 'index.html') return route.fulfill({ body: page_html(v), contentType: 'text/html', headers: hdrs });
      const ext = name.slice(name.lastIndexOf('.'));
      try { route.fulfill({ body: readFileSync(`out/${name}`), contentType: types[ext], headers: hdrs }); }
      catch { route.fulfill({ status: 404, body: '' }); }
    });
    const done = new Promise((resolve) => {
      page.on('console', (m) => { const t = m.text(); console.log(`${b} ${v} | ${t}`);
        if (t === 'DONE' || t.startsWith('EXIT') || t.startsWith('ERROR') || t.startsWith('Aborted')) resolve(t); });
      page.on('pageerror', (e) => { console.log(`${b} ${v} | PAGEERROR ${e.message}`); resolve('PAGEERROR'); });
    });
    await page.goto('http://localhost:8223/index.html');
    const r = await Promise.race([done, new Promise((r) => setTimeout(() => r('TIMEOUT'), 900000).unref())]);
    if (r !== 'DONE' && !r.startsWith('EXIT')) console.log(`${b} ${v} | FAILED ${r}`);
    await page.close();
  }
  await browser.close();
}
