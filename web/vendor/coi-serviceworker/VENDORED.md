# coi-serviceworker (vendored, not modified)

- Package: `coi-serviceworker@0.1.7` from the npm registry (https://registry.npmjs.org/coi-serviceworker/-/coi-serviceworker-0.1.7.tgz),
  upstream https://github.com/gzuidhof/coi-serviceworker, MIT (Guido Zuidhof and contributors).
- Tarball sha256 `6a546d4748e215220de923cf5dbb887104cec1aa7bb9afc2e925ba376a229616`,
  npm integrity `sha512-bjSUqEngCPOkErY2vbyWsaIGCNRODYzlNycaREVw5s12/C8SM+RnRUUeX6pZbTtov6C52ZLY/+tvHK+BDxuUuA==`.
- `coi-serviceworker.js` sha256 `d12bd536e27e39a773d7dc7adb1a1167d24002293e97ac81c995fb00cf8d4d5a`.
- Kept: `coi-serviceworker.js`, `LICENSE`, `README.md`, `package.json`. Not kept: `coi-serviceworker.min.js`, `index.html` (demo).
- Use (web/app): copied to `dist/coi-serviceworker.js` and loaded with a classic `<script>` as the FIRST script in
  `index.html`. On a host without COOP/COEP (GitHub Pages) it registers itself as a service worker and reloads the
  page once; on a host that sends the headers (`crossOriginIsolated === true`) it does nothing.
