# Deploy: publish the MVS 3.8J page on a static host

This file tells you how to put the bundle `dist/` on **GitHub Pages** (first choice) or **Cloudflare Pages**,
or on your own nginx or Caddy server. The page needs no server code: every file is static.
The live site is https://webmvs.com (Cloudflare Pages project `webmvs`, section 4).

## 1. What is in `dist/`

`scripts/bundle.sh` (on the build host) makes `dist/`. Example build
`5f6de6761110`: **674 files, 64,602,958 bytes**. Largest file: `runtime/hercules.f3b563c3b4f8.wasm`, 4,199,730 bytes.
The limits of both hosts are far away: GitHub Pages 100 MB per file, 1 GB per site; Cloudflare Pages
25 MiB per file, 20,000 files per deploy.
With the storage volume WORK00 (0251) the bundle has
681 files (65.2 MB; 597 DASD chunk files, boot working set 3.71 MB). A browser with saved disks of an older bundle
starts once from the original disks (the base image changed).

```
index.html                 no-cache  the page (fixed name)
entry.json                 no-cache  tiny list: logical name -> content-hashed file of this build
coi-serviceworker.js       no-cache  adds COOP/COEP on hosts without custom headers (GitHub Pages)
assets/  app.<h>.js  app.<h>.css  3270.<h>.bdf  app.<h>.js.map        immutable
runtime/ hercules.<h>.js  hercules.<h>.wasm  mvs-runtime.<h>.js  mvs-persist.<h>.js  tn3270-headless.<h>.js
conf/    web.<h>.cnf  web-browser.<h>.rc  web-shutdown.<h>.rc                immutable
boot/    herclogo.<h>.txt  SCRIPTS/{pjes2,zeod,quiesce,poweroff}.<h>       immutable
dasd/    manifest.<h>.json  seed/seed.<h>.json  seed/mvsres_1.<h>.cckd     immutable
dasd/c/  <sha256>  (589 DASD chunks of at most 128 KiB + the 209 KB metadata blob, 58.9 MB)    immutable
_headers                   Cloudflare Pages / Netlify headers (GitHub Pages ignores it)
404.html  .nojekyll        real 404 on Cloudflare (no SPA fallback); GitHub branch deploy keeps "_" files
licenses/  source/  SOURCE.txt  LICENSE-*.txt  BUILD-INFO.json   license texts, QPL source notice and copy
```

- `<h>` = the first 12 hex digits of the sha256 of the file. A changed file gets a new name, and every file
  that refers to it gets a new name too. So a browser can keep these files for ever (`immutable`), and a
  visitor can never get a mix of an old and a new runtime. Only `index.html`, `entry.json` and
  `coi-serviceworker.js` keep fixed names; they must be revalidated on each load.
- The DASD chunks are loaded on demand with whole-file GETs (no HTTP Range requests). The browser keeps them
  in Cache Storage, so a second visit downloads almost nothing.
- `source/` is a copy of the Hercules patches and the new source files (QPL 1.0 section 4). The bundle step
  removes private values of the build setup from it (instance id, account id, home paths) and then scans
  every file; set `BUNDLE_DENY='<regex>'` to add your own strings to that scan.

Bytes that a first visit downloads (measured in the host emulations, section 6): about **5.1-5.2 MB**:
1.1-1.2 MB page and runtime, 3.9 MB DASD (the boot working set). Then the page IPLs MVS. The rest of the
58.9 MB of DASD loads only if MVS reads it.

Sizes of bundle `5f6de6761110` (measured with the commands of `scripts/bundle.sh`):

| File | raw | gzip (GitHub Pages) | brotli q4 | brotli q11 |
|---|---|---|---|---|
| `runtime/hercules.<h>.wasm` | 4,199,730 | 1,184,636 | 1,040,218 | 808,852 |
| `runtime/hercules.<h>.js` | 58,886 | 18,091 | 18,697 | 16,159 |
| `runtime/mvs-runtime.<h>.js` | 47,183 | 16,680 | 17,273 | 14,750 |
| `runtime/tn3270-headless.<h>.js` + `mvs-persist.<h>.js` | 19,994 | 7,273 | 7,433 | 6,218 |
| `assets/app.<h>.js` | 91,213 | 32,319 | 33,259 | 28,482 |
| `assets/3270.<h>.bdf` (font) | 69,094 | 8,473 | 8,345 | 5,966 |
| `dasd/manifest.<h>.json` | 56,222 | 30,543 | 27,583 | 24,740 |
| runtime total (wasm + 4 JS) | 4,325,793 | **1,226,680** | 1,083,621 | **845,979** |

GitHub Pages sends gzip only (measured: about gzip level 5). That is 381 KB more than brotli q11 per first visit.

## 2. Make the bundle (build host)

Inputs: the browser build, the lazy DASD chunks and the seed shadow (`scripts/build.sh`):
```
cd ~/webmvs          # or your repo copy on the host
scripts/build.sh ext && scripts/build.sh build && scripts/build.sh chunks && scripts/build.sh seed
scripts/bundle.sh --tar                     # -> dist/ and dist-<build>.tar.gz + .sha256 next to it
```
`bundle.sh` reads `HERC_OUT` (default `~/build/webmvs/out/web`), `DASD` (`~/build/webmvs/dasd`), `SEED`
(`~/build/webmvs/seed`), `SRC` (`~/src/hyperion-wasm`) and writes `DIST` (default `<repo>/dist`).
Options:
- `--keep <previous dist>`: also copy the hashed files of the previous deploy that the new build does not
  have. Use it for every update after the first one (see "Updates" below).
- `--precompress`: add `<file>.br` and `<file>.gz` for nginx and Caddy (not for GitHub or Cloudflare Pages).
- `--tar`: write the deploy asset `dist-<build>.tar.gz` (sorted names, mtime 0, owner 0) and its `.sha256`.
  (`entry.json` and `BUILD-INFO.json` contain the build time, so two runs give different tar files with the
  same content-hashed names.)


## 3. GitHub Pages (alternative)

GitHub Pages cannot set response headers. The page is cross-origin isolated by `coi-serviceworker.js`:
the first visit loads the page, registers the service worker and reloads one time. All later loads are
isolated at once. Limits: site 1 GB, file 100 MB, soft bandwidth 100 GB per month (about 19,000 first visits
of 5.2 MB; later visits of the same browser download about 30 KB). GitHub Pages sends
`Cache-Control: max-age=600` for every file (you cannot change it): the browser reuses a file for 10 minutes,
then revalidates it (304). The hashed names make this safe.

### 3a. With the workflow and a release asset (recommended: the bundle never enters the git history)
1. Create the public repository (for example `webmvs`) and push the source (`https://github.com/paulovitorjp/webmvs`). The workflow file `.github/workflows/pages.yml` must be on the default branch.
2. Settings > Pages > Build and deployment > Source: select **GitHub Actions**.
3. Releases > Draft a new release, tag for example `site-5f6de6761110`. Attach the two files
   `dist-5f6de6761110.tar.gz` and `dist-5f6de6761110.tar.gz.sha256`. Publish the release.
   With the GitHub CLI: `gh release create site-5f6de6761110 dist-5f6de6761110.tar.gz dist-5f6de6761110.tar.gz.sha256 --title "Site 5f6de6761110" --notes "Prebuilt bundle"`.
4. Actions > "Deploy to GitHub Pages" > Run workflow. In `release`, type the tag (`site-5f6de6761110`).
   The job downloads the asset, checks the sha256, checks the limits, and deploys. Nothing is built on GitHub.
5. Open `https://<user>.github.io/<repo>/`. The page reloads one time by itself, then IPLs MVS.

### 3b. Without releases: commit `dist/`
Copy `dist/` into the repository root, commit and push. Run the workflow with `release` empty: it deploys the
`dist/` of the branch. Each DASD or wasm change adds megabytes to the git history for ever.

### 3c. Without Actions: a `gh-pages` branch
```
git worktree add --orphan -b gh-pages ../site          # an empty branch, separate from the source
cp -a dist/. ../site/ && cd ../site && git add -A && git commit -m "site 5f6de6761110" && git push -u origin gh-pages
```
Settings > Pages > Source: **Deploy from a branch**, branch `gh-pages`, folder `/ (root)`. `.nojekyll` is in the
bundle, so Jekyll does not drop `_headers` or other files. To keep the branch small, make a new orphan commit for
each update and push it with `--force`.

### Notes for GitHub Pages
- A project site is at `https://<user>.github.io/<repo>/`. All URLs in the page are relative, and this
  layout was tested (emulation with the site under `/webmvs/`, section 6).
- All project sites of one user share the origin `https://<user>.github.io`, so they share storage. The page
  uses the OPFS directory `shadow/`, the Cache Storage `mvs-dasd-c1`, the localStorage key `mvs-machine-state`
  and the Web Lock `mvs-machine`. Another page of the same user with the same names would interfere. A
  custom domain (Settings > Pages > Custom domain) gives the site its own origin.
- GitHub gzips the DASD chunks too (it compresses `application/octet-stream`). Most chunks are already
  compressed, so the gain is small (about 20 KB on a first visit).

## 4. Cloudflare Pages

Cloudflare Pages applies `dist/_headers`: COOP/COEP/CORP on every file (no service worker reload),
`immutable` for the hashed directories, `no-cache` for the entry files. It compresses with brotli by itself.
Limits: 25 MiB per file, 20,000 files per deploy (a bundle has about 700 files).

1. Log in once (Node 22 or later): `npx wrangler@4 login` (opens the browser), or set `CLOUDFLARE_API_TOKEN`
   to a token with the Cloudflare Pages: Edit permission.
2. Create the project one time:
   `npx wrangler@4 pages project create webmvs --production-branch main`
3. Deploy (from the repository root, after `scripts/bundle.sh`):
   `npx wrangler@4 pages deploy dist --project-name webmvs --branch main`
   Wrangler uploads only the files that the project does not have yet.
4. Open `https://webmvs.pages.dev/` (or your custom domain, here `https://webmvs.com`). Check the headers:
   `curl -sI https://webmvs.pages.dev/ | grep -i -E 'cross-origin|cache-control'`
   You must see `cross-origin-opener-policy: same-origin`, `cross-origin-embedder-policy: require-corp` and
   `cache-control: no-cache`.
5. Custom domain: Workers & Pages > webmvs > Custom domains.

Alternative: connect the GitHub repository in the Cloudflare dashboard (Workers & Pages > Create > Pages >
Connect to Git) with an empty build command and output directory `dist` (this needs `dist/` in the branch, 3b).

## 5. Your own server: nginx or Caddy

Make the bundle with `scripts/bundle.sh --precompress` (build `5f6de6761110`: 730 files, 67,278,456 bytes,
with `.br` and `.gz` next to the text, JSON and wasm files). Samples: `deploy/nginx.conf` (put it in `/etc/nginx/conf.d/`; Ubuntu's nginx
has no brotli module, so it sends the `.gz` files) and `deploy/Caddyfile` (sends the `.br` files). Both set
COOP/COEP/CORP, `application/wasm`, immutable caching for the hashed directories and `no-cache` for the rest,
and answer Range requests (206). Both were tested on 127.0.0.1 (section 6). The site must be HTTPS
(SharedArrayBuffer and the service worker need a secure context; only `http://localhost` is an exception).

## 6. Tests on the build host (emulations of the two hosts)

The tables below are from build `68cb79bc1fcb`. Build `5f6de6761110` passed the same matrix (28 e2e runs),
nginx and Caddy, a durability loop and 60-minute soaks.

`scripts/pages-emu.mjs` serves `dist/` like each host (checked against real responses of `pages.github.com`,
`mdn.github.io` and `developers.cloudflare.com` on 2026-10-20). an internal (unpublished) test script runs the repo e2e
(`scripts/e2e.mjs`: IPL on the Console tab, TSO logon in the TSO tab, `time`, `D T`, logoff, Shut down, plus
all the checks) against them.

| Port | Emulation |
|---|---|
| 8401 | GitHub Pages: no custom headers (coi-serviceworker), gzip level 5 only (also wasm and octet-stream), `max-age=600`, weak ETag, 304, `Access-Control-Allow-Origin: *`, no Range |
| 8402 | Cloudflare Pages: `_headers` applied, brotli q4, default `public, max-age=0, must-revalidate`, strong ETag, `/index.html` -> 308 `/` |
| 8403 / 8404 | 8401 / 8402 with a server-side throttle: all responses share 9 Mbit/s, each starts 60 ms after the request |
| 8405 | 8401 with the site under `/webmvs/` (a GitHub project site) |
| 8406 / 8407 | nginx 1.24 with `deploy/nginx.conf` / Caddy 2.11.7 with `deploy/Caddyfile` (bundle with `--precompress`) |

Results (headless Playwright 1.56.1 on the build host; times from the navigation start; "cold" = new
profile, "warm" = second visit with the same profile; bytes = response bodies from the server log).
**Firefox rows: Playwright's own Firefox build** (142.0.1, `firefox-1495`) runs this wasm about 5 times slower than
the official Mozilla build; an official Firefox 142.0.1 / 158.0.1 reached IKT007I in 4.5-4.9 s. The Firefox times below are not what a visitor's Firefox does.

| Browser, server | runs (PASS) | nav -> IKT007I cold / warm | nav -> TSO READY cold / warm | first visit: bytes of the whole visit (before IKT007I), requests | second visit: bytes |
|---|---|---|---|---|---|
| Chromium, GitHub-like 8401 | 2 cold + 2 warm (4) | 3.08-3.10 / 3.57-3.64 s | 9.43-9.49 / 9.37-9.49 s | 5,164,626 B (5,158,886 B), 131 (coi reload included) | 25,533 B, 7 |
| Chromium, Cloudflare-like 8402 | 2 cold + 2 warm (4) | 3.70-3.77 / 3.04 s | 9.49 / 9.35-9.51 s | 5,103,493 B (5,097,898 B), 128 | 136,054-145,919 B, 8-9 |
| Firefox, GitHub-like 8401 | 2 cold + 2 warm (4) | 10.83-11.62 / 11.45-11.64 s | 16.60-17.12 / 16.48-17.29 s | 5,296,728 B (5,160,348 B), 132 | 25,533-35,421 B |
| Firefox, Cloudflare-like 8402 | 2 cold + 2 warm (4) | 11.49-11.65 / 11.34 s | 16.40-16.73 / 16.55-16.56 s | 5,234,081 B (5,097,898 B), 129 | 136,054 B |
| WebKit 26, 8401 / 8402 | 1 cold + 1 warm each (cold PASS, warm FAIL: see note) | 3.18 / 4.00 s; 4.08 / 3.03 s | 8.65 / 8.86 s; 8.63 / 8.79 s | 5,437,095 B (5,203,797 B) / 5,588,477 B (5,232,984 B; no br from Playwright WebKit) | 5,254 B (0 DASD requests) |
| Chromium, throttled 9 / 1.5 Mbit/s, 60 ms (CDP), 8402 | 1 cold + 1 warm (2) | 7.73 / 4.70 s | 13.55 / 9.61 s | 5,103,493 B | 136,054 B |
| Chromium, server throttle 9 Mbit/s + 60 ms, GitHub-like 8403 | 3 cold + 2 warm (3 PASS, 2 FAIL: heartbeat, see note) | 7.57-8.17 / 3.61-3.63 s | 13.48-14.06 / 9.35-9.38 s | 5,164,626 B | 25,533 B |
| Chromium, server throttle, Cloudflare-like 8404 | 1 cold + 1 warm (2) | 7.79 / 3.76 s | 13.75 / 9.65 s | 5,103,493 B | 136,054 B |
| Firefox, server throttle, GitHub-like 8403 | 1 cold + 1 warm (2) | 14.09 / 10.94 s | 19.77 / 16.66 s | 5,296,728 B | 25,533 B |
| Chromium / Firefox, GitHub project site `/webmvs/` 8405 | 1 cold + 1 warm each (4) | 3.15 / 3.63 s; 11.02 / 11.50 s | 9.49 / 9.50 s; 16.74 / 16.62 s | same as 8401 | same as 8401 |
| Chromium / Firefox, nginx 8406 | 1 cold + 1 warm each (4) | 3.70 / 3.57 s; 10.78 / 10.60 s | 9.54 / 9.34 s; 16.59 / 16.39 s | (not logged) | |
| Chromium / Firefox, Caddy 8407 | 1 cold + 1 warm each (4) | 2.99 / 2.99 s; 11.58 / 11.36 s | 9.51 / 9.37 s; 16.57 / 16.27 s | (not logged) | |

- The first visit downloads the same set on every server: page + runtime + the boot working set of the DASD
  (3.86-3.88 MB of chunks incl. the 209 KB metadata blob, 98 boot chunks). Everything the e2e session needs is
  in before IKT007I. GitHub-like: page 0.05 MB + runtime 1.22 MB (gzip); Cloudflare-like: page 0.11 MB (the
  font is sent uncompressed there, its type is `application/octet-stream`) + runtime 1.08 MB (brotli q4).
- Second visit: the runtime and page files come from the HTTP cache without a request (immutable /
  `max-age=600`), the chunks from Cache Storage. The 131 KB chunk that Chromium and Firefox fetch on the second
  visit is one that only a restart after a clean Shut down reads (JES2 warm start); GitHub gzips it to 20 KB.
- IPL time does not depend on the host (CPU only): IPL -> IKT007I 2.5-3.4 s Chromium and WebKit, 9.8-11.1 s Firefox
  (unthrottled; with the throttle the IPL overlaps the download and takes 4.9-5.4 s in Chromium).
- Note WebKit: Playwright WebKit counts HTTP-cache hits as response bytes, so the e2e check "second visit
  < 1 MB DASD" fails (3.88-3.93 MB "seen"); the server logs show 0 DASD requests in both second visits.
- Note heartbeat: 2 of 9 Chromium runs on the throttled GitHub-like port had one main-thread gap of 229-230 ms
  (the e2e limit is 200 ms; no long task; at the TSO logon screen); 8 more runs (4 on that port) all passed.
- Long runs (MVS idle with a TSO user logged on, a TSO command every 120 s, `D T` every 240 s, then
  `d r,l` + TSO Enter): Chromium on the GitHub-like port and Firefox on the Cloudflare-like port, 1,800 s each (at the same time):
  **both ok**, 14 TSO commands + 7 `D T`, 0 failures, no crash; wasm heap high-water 62.2 -> 64.9 MiB (Chromium) and
  61.3 -> 63.9 MiB (Firefox) of the fixed 112 MiB; 1.3 MB of DASD loaded on demand after the first minute.

Differences between the emulations and the real hosts: HTTP/1.1 on 127.0.0.1 (the real hosts use HTTP/2 or
HTTP/3 and TLS; the browser opens at most 6 HTTP/1.1 connections); no CDN latency (the throttled ports add
60 ms per response, but no TCP slow start); real GitHub Pages answers Range with 206 (the page never sends
Range); the brotli level of Cloudflare is not known (the emulation uses q4; q11 is 231 KB smaller for the wasm).

## 7. Checklist

1. Build: README "Build" steps, then `scripts/bundle.sh` (add `--tar` for a GitHub Release asset).
2. Deploy: Cloudflare Pages (section 4), GitHub Pages (section 3) or your own server (section 5).
3. After the deploy: open the page in Chrome, Firefox and Safari; in the browser console `crossOriginIsolated`
   must be `true`. The e2e can also run against the public URL:
   `node scripts/e2e.mjs chromium https://webmvs.com/ /tmp/e2e-public pub1 --expect-persist --shutdown`.

### Updates
Make the new bundle with `scripts/bundle.sh --tar --keep <the dist of the current deploy>`. The old hashed
files stay in the new deploy, so a tab that still runs the old page (its `index.html` can be 10 minutes old on
GitHub Pages; a TSO session loads DASD chunks for hours) does not get 404 errors. The cost is the size of the
changed files (a new wasm: about 4 MB; a new DASD image: up to 59 MB). Drop the old files at the next update.
A new DASD image drops the visitor's saved changes on the volumes whose image changed (the runtime compares the
base-volume sha256s and deletes only those shadow files; the other volumes keep the visitor's data, and the page
shows a one-time notice). Edit `UPDATE_NOTICE` in `web/app/src/main.ts` for the next image change.
