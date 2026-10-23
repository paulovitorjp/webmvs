// Build web/term-probe into web/term-probe/dist (index.html, probe.js, 3270.bdf, licenses).
// Usage: node web/term-probe/build.mjs   (needs esbuild; scripts/term-probe-build.sh installs it)
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, '..', 'vendor', 'tn3270');
const out = join(here, 'dist');
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, 'src', 'probe.ts')],
  bundle: true, format: 'esm', target: 'es2022', outfile: join(out, 'probe.js'),
  alias: {
    '@tn3270/core': join(vendor, 'packages', 'core', 'src', 'index.ts'),
    '@tn3270/frontend': join(here, 'src', 'frontend-browser.ts'),
  },
  // Vendored sources import './x.js' for './x.ts' (TS NodeNext style); esbuild resolves that.
  sourcemap: true, logLevel: 'info',
});
copyFileSync(join(here, 'index.html'), join(out, 'index.html'));
copyFileSync(join(vendor, 'packages', 'canvas', 'assets', '3270.bdf'), join(out, '3270.bdf'));
copyFileSync(join(vendor, 'packages', 'canvas', 'assets', 'LICENSE-3270-font.txt'), join(out, 'LICENSE-3270-font.txt'));
copyFileSync(join(vendor, 'LICENSE'), join(out, 'LICENSE-tn3270.txt'));
