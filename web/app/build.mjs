// Build the visitor page web/app into web/app/dist (static files only; any static server can host it).
// Usage: node web/app/build.mjs     (npm install in web/app first: esbuild 0.28.2)
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, '..', 'vendor');
const tn = join(vendor, 'tn3270');
const out = join(here, 'dist');
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, 'src', 'main.ts')],
  bundle: true, format: 'esm', target: 'es2022', outfile: join(out, 'app.js'), minify: true,
  alias: {
    '@tn3270/core': join(tn, 'packages', 'core', 'src', 'index.ts'),
    '@tn3270/frontend': join(here, 'src', 'frontend-browser.ts'),
  },
  sourcemap: true, logLevel: 'info', legalComments: 'linked',
});
const copy = (from, to) => copyFileSync(from, join(out, to));
copy(join(here, 'index.html'), 'index.html');
copy(join(here, 'app.css'), 'app.css');
copy(join(tn, 'packages', 'canvas', 'assets', '3270.bdf'), '3270.bdf');
copy(join(tn, 'packages', 'canvas', 'assets', 'LICENSE-3270-font.txt'), 'LICENSE-3270-font.txt');
copy(join(tn, 'LICENSE'), 'LICENSE-tn3270.txt');
copy(join(vendor, 'coi-serviceworker', 'coi-serviceworker.js'), 'coi-serviceworker.js');
copy(join(vendor, 'coi-serviceworker', 'LICENSE'), 'LICENSE-coi-serviceworker.txt');
copy(join(here, '_headers'), '_headers');
if (process.argv.includes('--dev')) { mkdirSync(join(out, 'mock'), { recursive: true }); copy(join(here, 'dev', 'mock-runtime.js'), 'mock/mock-runtime.js'); }
