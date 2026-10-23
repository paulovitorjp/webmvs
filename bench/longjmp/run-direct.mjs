// Control run without Playwright: start the browser binary itself (headless) on a page served
// from 127.0.0.1:<ephemeral port>; the page POSTs its output lines back to /log.
// This checks that the Playwright/Juggler/CDP instrumentation does not change throw cost.
// Usage: node run-direct.mjs <N> <reps> <browser>... -- <variant>...
import http from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
const [N, REPS, ...browsers] = args.slice(0, sep);
const variants = args.slice(sep + 1);
const PW = `${homedir()}/.cache/ms-playwright`;
const bins = {
  chromium: `${PW}/chromium_headless_shell-1194/chrome-linux/headless_shell`,
  firefox: `${PW}/firefox-1495/firefox/firefox`,
};
const types = { '.js': 'text/javascript', '.wasm': 'application/wasm' };
let waiter = null;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST' && u.pathname === '/log') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => { res.end(); if (waiter) waiter(b); });
    return;
  }
  if (u.pathname === '/index.html') {
    const v = u.searchParams.get('v');
    res.setHeader('content-type', 'text/html');
    return res.end(`<!doctype html><meta charset=utf-8><body><script>
const post = (s) => fetch('/log', { method: 'POST', body: s, keepalive: true });
var Module = { arguments: ['${N}', '${REPS}'], print: post, printErr: (s) => post('ERR ' + s) };
window.onerror = (m) => post('ERROR ' + m);
post('UA ' + navigator.userAgent);
</script><script src="${v}.js"></script>`);
  }
  const name = u.pathname.slice(1);
  try { res.setHeader('content-type', types[name.slice(name.lastIndexOf('.'))] || 'application/octet-stream'); res.end(readFileSync(`out/${name}`)); }
  catch { res.statusCode = 404; res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log(`SERVER 127.0.0.1:${port}`);

for (const b of browsers) {
  for (const v of variants) {
    const prof = mkdtempSync(`${tmpdir()}/ljbench-${b}-`);
    const url = `http://127.0.0.1:${port}/index.html?v=${v}`;
    let argv;
    if (b === 'firefox') {
      writeFileSync(`${prof}/user.js`, 'user_pref("dom.max_script_run_time", 0);\nuser_pref("browser.shell.checkDefaultBrowser", false);\n');
      argv = ['--headless', '--no-remote', '--profile', prof, url];
    } else {
      argv = ['--headless', '--no-sandbox', `--user-data-dir=${prof}`, '--remote-debugging-port=0', url];
    }
    const child = spawn(bins[b], argv, { stdio: 'ignore' });
    const r = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('TIMEOUT'), 600000);
      waiter = (line) => {
        for (const l of line.split('\n')) {
          console.log(`direct-${b} ${v} | ${l}`);
          if (l === 'DONE' || l.startsWith('ERR')) { clearTimeout(t); resolve(l); }
        }
      };
    });
    await new Promise((r) => setTimeout(r, 1000));   // late POSTs
    if (r !== 'DONE') console.log(`direct-${b} ${v} | FAILED ${r}`);
    child.kill('SIGTERM');            // only the child we started (by PID)
    await new Promise((r) => { if (child.exitCode !== null) r(); else child.on('exit', r); setTimeout(r, 5000); });
    rmSync(prof, { recursive: true, force: true });
  }
}
server.close();
