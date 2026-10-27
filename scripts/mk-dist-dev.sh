#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# assemble the dev bundle web/dist-dev/ on the build host.
# The result is a plain static site: any static server can host it (with COOP/COEP headers, or
# without them: coi-serviceworker.js then makes the page cross-origin isolated).
#
# Usage (host): scripts/mk-dist-dev.sh
# Env: HERC_OUT  dir with the browser build hercules.js + hercules.wasm (default ~/build/webmvs/out/web)
#      DASD      dir with manifest.json + chunks from scripts/mk-dasd-chunks.sh (default ~/build/webmvs/dasd)
#      DIST      output dir (default <repo>/web/dist-dev)
#      SRC       Hyperion tree of the build (for BUILD-INFO; default ~/src/hyperion-wasm)
#      PATCHES   patch list of the build (for BUILD-INFO; default: build-wasm.sh default)
#
# Layout (what web/app and web/runtime expect):
#   index.html app.js app.css 3270.bdf coi-serviceworker.js _headers LICENSE-*.txt   (web/app, node build.mjs)
#   runtime/  mvs-runtime.js tn3270-headless.js hercules.js hercules.wasm (+ .br)
#   conf/     web.cnf web-browser.rc web-shutdown.rc
#   boot/     herclogo.txt SCRIPTS/{pjes2,zeod,quiesce,poweroff}   (from the MVS/CE release tar)
#   dasd/     manifest.json + <volume>.NNN chunks (each <= 25 MiB)
#   licenses/ SOURCE.txt source/   QPL text + notice + patches and new source files (QPL sections 3, 4)
#   BUILD-INFO.json
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
HERC_OUT=${HERC_OUT:-$HOME/build/webmvs/out/web}
DASD=${DASD:-$HOME/build/webmvs/dasd}
DIST=${DIST:-$REPO/web/dist-dev}
SRC=${SRC:-$HOME/src/hyperion-wasm}
TAR=${TAR:-$REPO/dasd/mvsce/MVSCE.release.v3.0.0.tar}
PATCHES=${PATCHES:-$(sed -n 's/^  PATCHES=\${PATCHES:-"\(.*\)"}$/\1/p' "$REPO/scripts/build-wasm.sh" | head -1)}
export PATH=$HOME/emsdk/node/24.19.0_64bit/bin:$PATH
LIMIT=$((25 * 1024 * 1024))

for f in "$HERC_OUT/hercules.js" "$HERC_OUT/hercules.wasm" "$DASD/manifest.json" "$TAR"; do
  [ -f "$f" ] || { echo "missing: $f"; exit 1; }
done

echo "== page (web/app)"
( cd "$REPO/web/app" && [ -d node_modules/esbuild ] || npm ci --no-audit --no-fund > /dev/null )
( cd "$REPO/web/app" && node build.mjs 2>&1 | grep -E 'app.js |Done|error' )

echo "== assemble $DIST"
rm -rf "$DIST.tmp"; mkdir -p "$DIST.tmp"/{runtime,conf,boot/SCRIPTS,dasd}
A=$REPO/web/app/dist
cp "$A"/{index.html,app.js,app.js.map,app.css,3270.bdf,coi-serviceworker.js,_headers,og.png,player.png} "$DIST.tmp/"
cp "$A"/LICENSE-*.txt "$DIST.tmp/"
cp "$REPO"/web/runtime/{mvs-runtime.js,tn3270-headless.js,mvs-persist.js,mvs-snapshot.js} "$DIST.tmp/runtime/"
cp "$HERC_OUT"/hercules.{js,wasm} "$DIST.tmp/runtime/"
cp "$REPO"/conf/{web.cnf,web-browser.rc,web-shutdown.rc} "$DIST.tmp/conf/"
# QPL 1.0 section 4 (the wasm binary is a modified Hercules): license text, copyright, and the
# complete corresponding source (pinned upstream commit + every patch + the new linked files) in the bundle.
mkdir -p "$DIST.tmp/licenses" "$DIST.tmp/source/patches/hyperion" "$DIST.tmp/source/src/wasm" "$DIST.tmp/source/scripts" "$DIST.tmp/source/conf"
cp "$SRC/html/herclic.html" "$DIST.tmp/licenses/hercules-QPL-1.0.html"
cp "$SRC/COPYRIGHT" "$DIST.tmp/licenses/hercules-COPYRIGHT.txt"
for f in crypto.LICENSE.txt decnumber.ICU-license.html softfloat.LICENSE.txt telnet.LICENSE.txt; do cp "$SRC/LICENSES/$f" "$DIST.tmp/licenses/extpkg-$f"; done
cp "$A"/LICENSE-*.txt "$DIST.tmp/licenses/"
HCOMMIT=$(git -C "$SRC" rev-parse HEAD)
for n in $PATCHES; do cp "$REPO"/patches/hyperion/"$n"-*.patch "$DIST.tmp/source/patches/hyperion/"; done
cp "$REPO"/src/wasm/{Makefile.wasm,hdl_static.c,library_webload.js,wasm_main.c,wasmsock.c,wasmsock.h,webrt.c,webrt.h} "$DIST.tmp/source/src/wasm/"
cp "$REPO"/scripts/{build-wasm.sh,configure-wasm.sh,build-extpkgs-wasm.sh,mk-dasd-chunks.sh,vtamlst-trim.py,mk-dist-dev.sh,mk-seed-shadow.py} "$DIST.tmp/source/scripts/"
for f in src/wasm/lazydasd.cpp src/wasm/library_lazydasd.js src/wasm/outsink.cpp scripts/build.sh scripts/bundle.sh scripts/bundle-hash.py scripts/dasd-chunk.py scripts/dasd-packs.py src/wasm/library_webload.js web/runtime/mvs-persist.js web/runtime/mvs-snapshot.js scripts/vtamlib-stub.py scripts/vtamlst-edit.py scripts/kicks-install.py scripts/carddemo-install.py scripts/carddemo/cob2ans.py scripts/carddemo/fixes.py scripts/carddemo/helpers/CDMOVC.cbl scripts/carddemo/helpers/CDSTRG.cbl scripts/carddemo/helpers/CDDATE.cbl scripts/carddemo/helpers/CDREPC.cbl scripts/carddemo/helpers/CDNUMV.cbl scripts/data/vtamlib-iedia-stub.json scripts/data/vtamlib-iedia-stub.jcl; do if [ -f "$REPO/$f" ]; then mkdir -p "$(dirname "$DIST.tmp/source/$f")"; cp "$REPO/$f" "$DIST.tmp/source/$f"; fi; done   # lazy DASD + persistence, VTAMLIB stub (no IST025I)
cp "$REPO"/conf/{web.cnf,web-browser.rc,web-shutdown.rc} "$DIST.tmp/source/conf/"
cp "$REPO"/docs/PINS.md "$DIST.tmp/source/PINS.md"
# Licenses of the source copy: Apache-2.0 for the project code (LICENSE, NOTICE), QPL 1.0 text and the
# Hercules copyright for the patches (LICENSES/).
cp "$REPO"/LICENSE "$REPO"/NOTICE "$DIST.tmp/source/"
mkdir -p "$DIST.tmp/source/LICENSES"; cp "$REPO"/LICENSES/* "$DIST.tmp/source/LICENSES/"
cat > "$DIST.tmp/SOURCE.txt" <<NOTICE
MVS 3.8J in the browser: source and license notice
===================================================

runtime/hercules.wasm and runtime/hercules.js are a MODIFIED version of SDL Hercules 4.x Hyperion,
compiled to WebAssembly with Emscripten 6.0.13. Hercules is distributed under the Q Public License
version 1.0: see licenses/hercules-QPL-1.0.html and licenses/hercules-COPYRIGHT.txt.

The complete source of this build is available at no charge:
  0. Public repository: https://github.com/paulovitorjp/webmvs
  1. Original source: https://github.com/SDL-Hercules-390/hyperion
     commit $HCOMMIT (tag Release_4.9.1)
  2. Modifications, distributed separately from the original as patch files (QPL section 3):
     source/patches/hyperion/  ($PATCHES), applied in that order with 'git apply'
  3. New files linked into the binary: source/src/wasm/ (wasm_main.c, wasmsock.c, webrt.c,
     hdl_static.c, library_webload.js, Makefile.wasm, lazydasd.cpp, library_lazydasd.js,
     outsink.cpp)
  4. Build scripts and configuration: source/scripts/ (build-wasm.sh builds the binary; build.sh
     ext/build/chunks/seed and bundle.sh make the whole site),
     source/conf/; pinned versions of all inputs (extpkgs, emsdk, terminal): source/PINS.md
  5. Hercules external packages (crypto, decNumber, SoftFloat, telnet), unmodified, at the commits
     in source/PINS.md; licenses in licenses/extpkg-*.

Other parts of this page:
  - 3270 terminal athornton/tn3270 (MIT): licenses/LICENSE-tn3270.txt
  - x3270 3270 font: licenses/LICENSE-3270-font.txt
  - coi-serviceworker (MIT): licenses/LICENSE-coi-serviceworker.txt
  - MVS 3.8J (public domain), MVS/CE v3.0.0 by the MVS-sysgen project: https://github.com/MVS-sysgen/sysgen

The code of the webmvs project (source/src/wasm/, source/scripts/, source/conf/, the page and the
runtime JS) is licensed under the Apache License 2.0: source/LICENSE and source/NOTICE. The patches in
source/patches/hyperion/ stay under the Q Public License 1.0: source/LICENSES/hercules-QPL-1.0.html.
NOTICE
( cd "$DIST.tmp/source" && { echo '<!doctype html><meta charset="utf-8"><title>Source of this build</title><h1>Source of this build</h1><p>See <a href="../SOURCE.txt">SOURCE.txt</a>.</p><ul>';
  find . -type f ! -name index.html | sort | sed 's|^\./\(.*\)$|<li><a href="\1">\1</a></li>|'; echo '</ul>'; } > index.html )
tar -xOf "$TAR" MVSCE/herclogo.txt > "$DIST.tmp/boot/herclogo.txt"
# Seed shadow files (scripts/build.sh seed -> mk-seed-shadow.py): dasd/seed/{seed.json,mvsres_1.cckd}
SEED=${SEED:-$HOME/build/webmvs/seed}
if [ -f "$SEED/seed.json" ]; then mkdir -p "$DIST.tmp/dasd/seed"; cp "$SEED"/seed.json "$SEED"/*.cckd "$DIST.tmp/dasd/seed/"; else echo "no seed shadows in $SEED (SMF stays on)"; fi
# KICKS for TSO (Mike Noel, http://www.kicksfortso.com/): its license allows redistribution of the complete
# original package only, so the site offers the unmodified distribution zip (scripts/build.sh kicks pins its
# sha256) and its license text. The KICKS libraries themselves are on the KICKS0 volume (dasd/).
KICKS_ZIP=${KICKS_ZIP:-$HOME/build/webmvs/kicks/kicks-tso-v1r5m0.zip}
if [ -f "$KICKS_ZIP" ]; then
  mkdir -p "$DIST.tmp/kicks"; cp "$KICKS_ZIP" "$DIST.tmp/kicks/kicks-tso-v1r5m0.zip"
  unzip -p "$KICKS_ZIP" kicks-tso-v1r5m0/kicks-license.txt > "$DIST.tmp/kicks/kicks-license.txt"
  [ -s "$DIST.tmp/kicks/kicks-license.txt" ] || { echo "no kicks-license.txt in $KICKS_ZIP"; exit 1; }
  echo "kicks: $(sha256sum "$DIST.tmp/kicks/kicks-tso-v1r5m0.zip" | cut -c1-64)"
else echo "no KICKS zip ($KICKS_ZIP): run scripts/build.sh kicks"; exit 1; fi
# CardDemo (Apache-2.0, Copyright Amazon.com, Inc. or its affiliates): modified programs on the CARDD0 volume;
# its LICENSE and NOTICE go with the site (scripts/build.sh carddemo pins the tarball's sha256)
CARDDEMO_TGZ=${CARDDEMO_TGZ:-$(ls "$HOME"/build/webmvs/carddemo/carddemo-*.tar.gz 2>/dev/null | head -1)}
if [ -f "$CARDDEMO_TGZ" ]; then
  mkdir -p "$DIST.tmp/carddemo"
  for f in LICENSE NOTICE; do tar -xzOf "$CARDDEMO_TGZ" --wildcards "*/$f" > "$DIST.tmp/carddemo/$f.txt"; [ -s "$DIST.tmp/carddemo/$f.txt" ] || { echo "no $f in $CARDDEMO_TGZ"; exit 1; }; done
else echo "no CardDemo tarball: run scripts/build.sh carddemo"; exit 1; fi
for f in pjes2 zeod quiesce poweroff; do tar -xOf "$TAR" "MVSCE/SCRIPTS/$f" > "$DIST.tmp/boot/SCRIPTS/$f"; done
python3 - "$DASD" "$DIST.tmp/dasd" <<'EOF'
import json, os, shutil, sys
src, dst = sys.argv[1:3]
m = json.load(open(os.path.join(src, 'manifest.json')))
shutil.copy2(os.path.join(src, 'manifest.json'), dst)
if m.get('format') == 2:      # lazy chunks (scripts/dasd-chunk.py): dasd/c/<sha256>
    os.makedirs(os.path.join(dst, 'c'), exist_ok=True)
    for f in [c[0] for c in m['chunks']] + [m['meta']['file'].split('/')[-1]] + [p['file'].split('/')[-1] for p in m.get('packs', [])]:   # + boot packs
        shutil.copy2(os.path.join(src, 'c', f), os.path.join(dst, 'c', f))
else:
    for v in m['volumes']:
        for c in v['chunks']:
            shutil.copy2(os.path.join(src, c['file']), dst)
EOF
if command -v brotli > /dev/null; then
  for f in runtime/hercules.wasm runtime/hercules.js runtime/mvs-runtime.js runtime/tn3270-headless.js app.js; do
    brotli -q 11 -f -o "$DIST.tmp/$f.br" "$DIST.tmp/$f"
  done
fi

echo "== checks"
big=$(find "$DIST.tmp" -type f -size +"${LIMIT}"c)
[ -z "$big" ] || { echo "files over 25 MiB: $big"; exit 1; }
echo "largest file: $(find "$DIST.tmp" -type f -printf '%s %P\n' | sort -n | tail -1)"
nf=$(find "$DIST.tmp" -type f | wc -l); echo "files: $nf (Cloudflare Pages limit 20000)"; [ "$nf" -lt 20000 ] || { echo "too many files"; exit 1; }
for f in licenses/hercules-QPL-1.0.html SOURCE.txt source/LICENSE source/NOTICE source/LICENSES/hercules-QPL-1.0.html; do [ -s "$DIST.tmp/$f" ] || { echo "missing $f"; exit 1; }; done
echo "license/source notice: $(ls "$DIST.tmp/licenses" | wc -l) license files, $(ls "$DIST.tmp/source/patches/hyperion" | wc -l) patches, $(ls "$DIST.tmp/source/src/wasm" | wc -l) source files"
n=$(strings "$DIST.tmp/runtime/hercules.wasm" | grep -c '/home/' || true)
echo "host paths (/home/) in hercules.wasm: $n"
python3 - "$DIST.tmp" "$SRC" "$PATCHES" <<'EOF'
import hashlib, json, os, subprocess, sys, time
dist, src, patches = sys.argv[1:4]
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()
def git(*a):
    try: return subprocess.run(['git', '-C', src, *a], capture_output=True, text=True).stdout.strip()
    except Exception: return None
files = {}
for root, _, names in os.walk(dist):
    for n in names:
        p = os.path.join(root, n); r = os.path.relpath(p, dist)
        if r.startswith('dasd/') and r != 'dasd/manifest.json': continue
        files[r] = {'size': os.path.getsize(p), 'sha256': sha(p)}
dasd = json.load(open(os.path.join(dist, 'dasd', 'manifest.json')))
info = {
  'built': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
  'hyperion': git('rev-parse', 'HEAD'), 'patches': patches.split(),
  'hyperionDiffStat': git('diff', '--stat', 'HEAD') and git('diff', '--stat', 'HEAD').splitlines()[-1],
  'dasd': ({'volumes': len(dasd['volumes']), 'chunks': sum(len(v['chunks']) for v in dasd['volumes']),
           'bytes': sum(c['size'] for v in dasd['volumes'] for c in v['chunks']), 'chunkSize': dasd['chunkSize']}
           if dasd.get('format', 1) == 1 else
           {'format': 2, 'volumes': len(dasd['volumes']), 'chunks': len(dasd['chunks']), 'bytes': sum(c[1] for c in dasd['chunks']),
            'metaBytes': dasd['meta']['size'], 'chunking': dasd['chunking'], 'bootReadyBytes': dasd['boot']['readyBytes'],
            'bootChunks': len(dasd['boot']['ready'])}),
  'files': files,
}
json.dump(info, open(os.path.join(dist, 'BUILD-INFO.json'), 'w'), indent=1)
print('BUILD-INFO.json: hyperion', info['hyperion'], 'patches', ' '.join(info['patches']), '| dasd', info['dasd'])
EOF
rm -rf "$DIST"; mv "$DIST.tmp" "$DIST"
echo "== $DIST"; ( cd "$DIST" && find . -type f ! -path './dasd/*' -printf '%10s %P\n' | sort -k2 ); du -sh "$DIST"
