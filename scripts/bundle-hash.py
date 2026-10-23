#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""turn an assembled site (scripts/mk-dist-dev.sh output) into the static bundle dist/.

Usage: bundle-hash.py <assembled dir> <out dir> [--keep <previous dist>] [--precompress]

What it does
  * Content-hashed names for every file that the page loads, so that every browser can cache them
    for ever ("immutable") and a new deploy can never mix old and new files:
      assets/app.<h>.js, assets/app.<h>.css, assets/3270.<h>.bdf, assets/app.<h>.js.map
      runtime/{hercules,mvs-runtime,mvs-persist,tn3270-headless}.<h>.js, runtime/hercules.<h>.wasm
      conf/<name>.<h>.<ext>, boot/herclogo.<h>.txt, boot/SCRIPTS/<name>.<h>
      dasd/manifest.<h>.json, dasd/seed/seed.<h>.json, dasd/seed/<vol>_1.<h>.cckd
      dasd/c/<sha256>        (already content-addressed by scripts/dasd-chunk.py; not renamed)
    <h> = the first 12 hex digits of the sha256 of the file content (after its own references were
    rewritten), so a file's name changes when it or anything it references changes.
  * The references are rewritten as exact string replacements with an expected count each; a count
    mismatch (the source changed) stops the build.
  * Only index.html, entry.json (tiny: logical name -> hashed name) and coi-serviceworker.js keep fixed
    names; they are the no-cache files. 404.html (Cloudflare Pages: no SPA fallback, so a missing
    file is a real 404), .nojekyll (GitHub Pages branch deploy: keep files that start with "_").
  * _headers (Cloudflare Pages / Netlify): COOP/COEP/CORP on every file, immutable for the hashed dirs,
    no-cache for the entry files.
  * --keep <previous dist>: also copy the hashed files of the previous deploy that this build does
    not have, so a tab that still runs the previous page (index.html cached up to 10 min on GitHub
    Pages; a session that lazily loads DASD chunks for hours) does not get 404s after the deploy.
  * --precompress: <file>.br (brotli -q 11) and <file>.gz (gzip -9) next to the compressible files, for
    nginx (gzip_static, brotli_static) and Caddy (file_server precompressed). Not for GitHub Pages or
    Cloudflare Pages: both compress by themselves and never serve our .br/.gz as Content-Encoding.
"""
import gzip, hashlib, json, os, re, shutil, subprocess, sys, time

LIMIT_FILE = 25 * 1024 * 1024        # Cloudflare Pages per-file limit (GitHub Pages: 100 MB)
LIMIT_FILES = 20000                  # Cloudflare Pages files per deploy
LIMIT_SITE = 1000 * 1000 * 1000      # GitHub Pages published site limit (1 GB)
HASHLEN = 12

args = sys.argv[1:]
keep = None; pre = False
if '--keep' in args: i = args.index('--keep'); keep = args[i + 1]; del args[i:i + 2]
if '--precompress' in args: args.remove('--precompress'); pre = True
if len(args) != 2: sys.exit(__doc__)
SRC, OUT = (os.path.abspath(a) for a in args)

def sha(b): return hashlib.sha256(b).hexdigest()
def rd(p): return open(os.path.join(OUT, p), 'rb').read()
def wr(p, b):
    os.makedirs(os.path.dirname(os.path.join(OUT, p)) or OUT, exist_ok=True)
    open(os.path.join(OUT, p), 'wb').write(b)

if os.path.exists(OUT): shutil.rmtree(OUT)
shutil.copytree(SRC, OUT, ignore=shutil.ignore_patterns('*.br', '*.gz'))
# Public site: no values of the private build setup in the copied sources (
# problem 3: source/PINS.md had the build host's instance id). Generic patterns only, so this script can be
# public; BUNDLE_DENY (env, a regex, not committed) adds the owner's own values to the final scan below.
REDACT = [(re.compile(r'\bi-0[0-9a-f]{16}\b'), '<instance-id>'), (re.compile(r'(arn:[a-z0-9-]+:[a-z0-9-]*:[a-z0-9-]*:)\d{12}'), r'\1<account-id>'),
          (re.compile(r'/[U]sers/[^/\s]+'), '~')]   # macOS home paths ([U]: no literal path in this file)
redacted = 0
for root, _, fs in os.walk(os.path.join(OUT, 'source')):
    for f in fs:
        q = os.path.join(root, f)
        try: t = open(q, encoding='utf-8').read()
        except UnicodeDecodeError: continue
        u = t
        for rx, rep in REDACT: u = rx.sub(rep, u)
        if u != t: open(q, 'w', encoding='utf-8').write(u); redacted += 1
for f in ('app.js', 'app.js.map', 'app.css', '3270.bdf'):           # page assets -> assets/
    os.makedirs(os.path.join(OUT, 'assets'), exist_ok=True)
    os.rename(os.path.join(OUT, f), os.path.join(OUT, 'assets', f))
for f in ('_headers',):                                             # web/app's _headers: replaced below
    if os.path.exists(os.path.join(OUT, f)): os.remove(os.path.join(OUT, f))

names = {}       # logical path -> hashed path (both relative to the site root)
def hashed_name(p, b):
    d, base = os.path.split(p)
    if base.endswith('.js.map'): stem, ext = base[:-7], '.js.map'
    elif base == '3270.bdf': stem, ext = '3270', '.bdf.txt'   # text/plain, so Cloudflare compresses it (69 KB -> 8 KB)
    else:
        stem, ext = os.path.splitext(base)
    return os.path.join(d, f'{stem}.{sha(b)[:HASHLEN]}{ext}')
def fix(p):
    """rename p to its content-hashed name (content is final)."""
    b = rd(p); n = hashed_name(p, b)
    os.rename(os.path.join(OUT, p), os.path.join(OUT, n)); names[p] = n
    return n
def rewrite(p, reps):
    """exact replacements [(old, new, count)] in file p; fails on a count mismatch."""
    t = rd(p).decode('utf-8')
    for old, new, cnt in reps:
        k = t.count(old)
        if k != cnt: sys.exit(f'bundle-hash: {p}: expected {cnt} x {old!r}, found {k} (the source changed: update scripts/bundle-hash.py)')
        t = t.replace(old, new)
    wr(p, t.encode('utf-8'))
base = lambda p: os.path.basename(names[p])
rel = lambda p, frm: os.path.relpath(names[p], frm)

# 1. leaves (no references to other files)
leaves = ['runtime/hercules.wasm', 'runtime/tn3270-headless.js', 'runtime/mvs-persist.js', 'runtime/mvs-snapshot.js', 'assets/3270.bdf', 'assets/app.css',
          'conf/web.cnf', 'conf/web-browser.rc', 'conf/web-shutdown.rc', 'boot/herclogo.txt', 'dasd/manifest.json']
leaves += sorted(os.path.join('boot/SCRIPTS', f) for f in os.listdir(os.path.join(OUT, 'boot/SCRIPTS')))
seed = os.path.exists(os.path.join(OUT, 'dasd/seed/seed.json'))
if seed: leaves += sorted(os.path.join('dasd/seed', f) for f in os.listdir(os.path.join(OUT, 'dasd/seed')) if f != 'seed.json')
for p in leaves: fix(p)
m = json.loads(rd(names['dasd/manifest.json']))
if m.get('format') != 2: sys.exit('bundle-hash: dasd/manifest.json is not format 2 (lazy chunks, scripts/dasd-chunk.py)')
for c in m['chunks'] + [[m['meta']['file'].split('/')[-1], m['meta']['size']]]:   # chunks: name = sha256 of the content
    b = open(os.path.join(OUT, 'dasd/c', c[0]), 'rb').read()
    if len(b) != c[1] or (c[0] != sha(b) and not m['meta']['file'].endswith(c[0])): sys.exit(f'bundle-hash: chunk {c[0]}: size/sha mismatch')
for pk in m.get('packs', []):        # boot packs = the listed chunks, concatenated
    b = open(os.path.join(OUT, 'dasd', pk['file']), 'rb').read()
    if len(b) != pk['size'] or pk['file'].split('/')[-1] != sha(b) or len(b) != sum(m['chunks'][i][1] for i in pk['ids']):
        sys.exit(f"bundle-hash: pack {pk['file']}: size/sha mismatch")

# 2. seed list: files[].file -> hashed seed file (relative to seed.json); files[].name (OPFS name) unchanged
if seed:
    j = json.loads(rd('dasd/seed/seed.json'))
    for f in j['files']: f['file'] = base(os.path.join('dasd/seed', f['file']))
    wr('dasd/seed/seed.json', json.dumps(j, indent=1).encode()); fix('dasd/seed/seed.json')

# 3. Emscripten glue: the wasm URL, and the pthread Worker URL (= the module itself: import.meta.url,
#    so the file does not have to contain its own hashed name)
rewrite('runtime/hercules.js', [
    ('"hercules.wasm"', f'"{base("runtime/hercules.wasm")}"', 2),
    ('new Worker(new URL("hercules.js",import.meta.url),', 'new Worker(new URL(import.meta.url),', 1),
])
if 'hercules.js' in rd('runtime/hercules.js').decode(): sys.exit('bundle-hash: hercules.js still names hercules.js')
fix('runtime/hercules.js')

# 4. runtime module: imports, the glue URL, manifest/seed URLs, and the URL (2nd element) of each loader file
rt = 'runtime/mvs-runtime.js'
reps = [("from './tn3270-headless.js'", f"from './{base('runtime/tn3270-headless.js')}'", 1),
        ("from './mvs-persist.js'", f"from './{base('runtime/mvs-persist.js')}'", 2),
        ("from './mvs-snapshot.js'", f"from './{base('runtime/mvs-snapshot.js')}'", 1),
        ("new URL('hercules.js', here)", f"new URL('{base('runtime/hercules.js')}', here)", 1),
        ("manifest: 'dasd/manifest.json',", f"manifest: '{names['dasd/manifest.json']}',", 1)]
if seed: reps.append(("seed: 'dasd/seed/seed.json',", f"seed: '{names['dasd/seed/seed.json']}',", 1))
for fs_path, url in [('conf/web.cnf', 'conf/web.cnf'), ('conf/web-browser.rc', 'conf/web-browser.rc'),
                     ('conf/web-shutdown.rc', 'conf/web-shutdown.rc'), ('herclogo.txt', 'boot/herclogo.txt')] + \
                    [(f'SCRIPTS/{f}', f'boot/SCRIPTS/{f}') for f in ('pjes2', 'zeod', 'quiesce', 'poweroff')]:
    reps.append((f"['{fs_path}', '{url}']", f"['{fs_path}', '{names[url]}']", 1))
rewrite(rt, reps); fix(rt)

# 5. page bundle: runtime URL and font URL (both relative to the page, not to app.js), source map name
fix('assets/app.js.map')
rewrite('assets/app.js', [('"./runtime/mvs-runtime.js"', f'"./{names[rt]}"', 1),
                          ('"./3270.bdf"', f'"./{names["assets/3270.bdf"]}"', 1),
                          ('//# sourceMappingURL=app.js.map', f'//# sourceMappingURL={base("assets/app.js.map")}', 1)])
fix('assets/app.js')

# 6. index.html (fixed name, no-cache)
# preload list (index.html starts these downloads at once; see the comment there):
# [url, 'module' | 'fetch', fetchpriority]. Env PRELOAD_PACKS=1 also preloads the DASD boot packs (low priority).
pl = [[names['runtime/hercules.wasm'], 'fetch', 'high'], [names['runtime/hercules.js'], 'module', ''],
      [names[rt], 'module', ''], [names['runtime/tn3270-headless.js'], 'module', ''],
      [names['runtime/mvs-persist.js'], 'module', ''], [names['runtime/mvs-snapshot.js'], 'module', ''],
      [names['assets/3270.bdf'], 'fetch', ''], [names['dasd/manifest.json'], 'fetch', '']]
if seed: pl.append([names['dasd/seed/seed.json'], 'fetch', ''])
pl.append(['dasd/' + m['meta']['file'], 'fetch', ''])
pl += [[names[f], 'fetch', ''] for f in ('conf/web.cnf', 'conf/web-browser.rc')]
if os.environ.get('PRELOAD_PACKS') == '1': pl += [['dasd/' + pk['file'], 'fetch', 'low'] for pk in m.get('packs', [])]
rewrite('index.html', [('href="./app.css"', f'href="./{names["assets/app.css"]}"', 1),
                       ('src="./app.js"', f'src="./{names["assets/app.js"]}"', 1),
                       ('var L = [/*PRELOAD*/];', 'var L = ' + json.dumps([[('./' + u), k, q] for u, k, q in pl], separators=(',', ':')) + ';', 1)])

# 6b. embed.html (served as /embed: the X player card frame). The same page with class "embed" (terminal only)
# and without coi-serviceworker: a service worker cannot isolate a page in a cross-origin frame. Its
# isolation comes from the Document-Isolation-Policy header (_headers below; Chromium 137+ on desktop).
idx = rd('index.html').decode()
coi = re.search(r'<!-- First script:.*?<script src="\./coi-serviceworker\.js"></script>\n', idx, re.S)
if not coi: sys.exit('bundle-hash: index.html: coi-serviceworker block not found')
emb = idx.replace(coi.group(0), '<script>document.documentElement.classList.add("embed")</script>\n', 1)
emb = emb.replace('<meta property="og:url" content="https://webmvs.com/">', '<meta property="og:url" content="https://webmvs.com/embed">\n<link rel="canonical" href="https://webmvs.com/">', 1)
wr('embed.html', emb.encode())

# 7. entry manifest, 404 page, .nojekyll, _headers
build_id = sha(''.join(f'{k}={v}\n' for k, v in sorted(names.items())).encode())[:HASHLEN]
entry = {'format': 1, 'build': build_id, 'built': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
         'what': 'logical name -> content-hashed file of this build (scripts/bundle.sh); index.html loads assets/app.*.js',
         'dasdManifest': names['dasd/manifest.json'], 'files': dict(sorted(names.items()))}
wr('entry.json', (json.dumps(entry, indent=1) + '\n').encode())
wr('404.html', b'<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found. <a href="./">MVS 3.8J</a></p>\n')
wr('.nojekyll', b'')
IMM = 'public, max-age=31536000, immutable'
NOC = 'no-cache'
headers = f"""# Cloudflare Pages / Netlify. Made by scripts/bundle.sh. GitHub Pages ignores this file
# (coi-serviceworker.js makes the page cross-origin isolated there).
# Every matching rule applies (the same header from two rules is joined with a comma), so
# Cache-Control is set only in rules that do not overlap.
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
  X-Content-Type-Options: nosniff
/assets/*
  Cache-Control: {IMM}
/runtime/*
  Cache-Control: {IMM}
/conf/*
  Cache-Control: {IMM}
/boot/*
  Cache-Control: {IMM}
/dasd/*
  Cache-Control: {IMM}
/
  Cache-Control: {NOC}
/index.html
  Cache-Control: {NOC}
/entry.json
  Cache-Control: {NOC}
/coi-serviceworker.js
  Cache-Control: {NOC}
/og.png
  Cache-Control: public, max-age=3600
/player.png
  Cache-Control: public, max-age=3600
/embed
  ! Cross-Origin-Opener-Policy
  ! Cross-Origin-Embedder-Policy
  Document-Isolation-Policy: isolate-and-require-corp
  Content-Security-Policy: frame-ancestors 'self' https://x.com https://*.x.com https://twitter.com https://*.twitter.com
  Cache-Control: {NOC}
/embed.html
  ! Cross-Origin-Opener-Policy
  ! Cross-Origin-Embedder-Policy
  Document-Isolation-Policy: isolate-and-require-corp
  Content-Security-Policy: frame-ancestors 'self' https://x.com https://*.x.com https://twitter.com https://*.twitter.com
  Cache-Control: {NOC}
"""
wr('_headers', headers.encode())

# 8. previous deploy's hashed files (--keep)
kept = 0; kept_bytes = 0
if keep:
    for d in ('assets', 'runtime', 'conf', 'boot', 'dasd'):
        for root, _, fs in os.walk(os.path.join(keep, d)):
            for f in fs:
                if f.endswith(('.br', '.gz')): continue
                r = os.path.relpath(os.path.join(root, f), keep)
                if not os.path.exists(os.path.join(OUT, r)):
                    os.makedirs(os.path.dirname(os.path.join(OUT, r)), exist_ok=True)
                    shutil.copy2(os.path.join(keep, r), os.path.join(OUT, r)); kept += 1; kept_bytes += os.path.getsize(os.path.join(OUT, r))

# 9. checks: every hashed name matches its content; no file under a hashed dir without a hash
pat = re.compile(r'\.([0-9a-f]{%d})(\.[A-Za-z0-9.]+)?$' % HASHLEN)
for d in ('assets', 'runtime', 'conf', 'boot', 'dasd'):
    for root, _, fs in os.walk(os.path.join(OUT, d)):
        for f in fs:
            p = os.path.join(root, f); r = os.path.relpath(p, OUT)
            if r.startswith('dasd/c/'): continue          # checked above (sha256 names)
            mm = pat.search(f)
            if not mm: sys.exit(f'bundle-hash: {r}: in an immutable dir without a content hash')
            if sha(open(p, 'rb').read())[:HASHLEN] != mm.group(1): sys.exit(f'bundle-hash: {r}: hash does not match the content')
for p in ('index.html', 'embed.html', 'coi-serviceworker.js', 'entry.json'):
    if not os.path.exists(os.path.join(OUT, p)): sys.exit(f'bundle-hash: missing {p}')

# BUILD-INFO.json: same content as mk-dist-dev.sh's, with the final file names
bi_p = os.path.join(OUT, 'BUILD-INFO.json')
bi = json.load(open(bi_p))
files = {}
for root, _, fs in os.walk(OUT):
    for f in fs:
        p = os.path.join(root, f); r = os.path.relpath(p, OUT)
        if (r.startswith('dasd/c/')) or r == 'BUILD-INFO.json': continue
        files[r] = {'size': os.path.getsize(p), 'sha256': sha(open(p, 'rb').read())}
bi['files'] = dict(sorted(files.items())); bi['bundle'] = {'build': build_id, 'entry': 'entry.json', 'kept': kept}
json.dump(bi, open(bi_p, 'w'), indent=1)

# 10. --precompress: .br/.gz siblings for nginx / Caddy
if pre:
    comp = re.compile(r'\.(html|js|css|json|wasm|txt|bdf|map|cnf|rc)$')
    for root, _, fs in os.walk(OUT):
        for f in fs:
            p = os.path.join(root, f)
            if not comp.search(f) or os.path.getsize(p) < 1024 or '/source/' in p: continue
            subprocess.run(['brotli', '-q', '11', '-f', '-o', p + '.br', p], check=True)
            with open(p, 'rb') as a, gzip.GzipFile(p + '.gz', 'wb', compresslevel=9, mtime=0) as g: shutil.copyfileobj(a, g)

# private-value scan of every file except the DASD chunks (binary data: random matches possible)
deny = [rx for rx, _ in REDACT] + ([re.compile(os.environ['BUNDLE_DENY'].encode())] if os.environ.get('BUNDLE_DENY') else [])
for root, _, fs in os.walk(OUT):
    for f in fs:
        q = os.path.join(root, f)
        if '/dasd/c/' in q: continue
        b = open(q, 'rb').read()
        for rx in deny:
            pat2 = rx if isinstance(rx.pattern, bytes) else re.compile(rx.pattern.encode())
            mm = pat2.search(b)
            if mm: sys.exit(f'bundle-hash: {os.path.relpath(q, OUT)}: private value {mm.group(0)[:40]!r} (pattern {pat2.pattern!r})')
print(f'bundle-hash: redacted {redacted} source files; private-value scan clean ({len(deny)} patterns)')

# summary + host limits
n = 0; tot = 0; big = []
for root, _, fs in os.walk(OUT):
    for f in fs:
        s = os.path.getsize(os.path.join(root, f)); n += 1; tot += s
        if s > LIMIT_FILE: big.append(os.path.relpath(os.path.join(root, f), OUT))
print(f'bundle-hash: build {build_id}: {len(names)} files renamed, {n} files, {tot} bytes, kept from previous: {kept} files {kept_bytes} B')
for k, v in sorted(names.items()): print(f'  {k} -> {v}')
if big: sys.exit(f'bundle-hash: files over 25 MiB: {big}')
if n >= LIMIT_FILES: sys.exit(f'bundle-hash: {n} files, Cloudflare Pages allows {LIMIT_FILES}')
if tot >= LIMIT_SITE: sys.exit(f'bundle-hash: {tot} bytes, GitHub Pages allows 1 GB')
