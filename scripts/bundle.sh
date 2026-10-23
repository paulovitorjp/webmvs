#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# build the static bundle dist/ that any static host can serve
# (GitHub Pages, Cloudflare Pages, nginx, Caddy). Runs on the build host. See docs/DEPLOY.md.
#
# Usage: scripts/bundle.sh [--keep <previous dist>] [--precompress] [--tar]
#   --keep <dir>     also keep the hashed files of the previous deploy (open tabs keep working)
#   --tar            also write <DIST>-<build>.tar.gz + .sha256 next to DIST (reproducible tar: sorted names,
#                    mtime 0, owner 0): the asset for a GitHub Release / the Pages workflow (docs/DEPLOY.md)
#   --precompress    add .br/.gz next to the compressible files (nginx gzip_static/brotli_static,
#                    Caddy precompressed). Not needed for GitHub Pages or Cloudflare Pages.
# Env:  HERC_OUT  browser build (hercules.js + hercules.wasm; scripts/build.sh build or build-wasm.sh TARGET=web)
#       DASD      lazy DASD chunks (format 2; scripts/build.sh chunks)        SEED  seed shadows (build.sh seed)
#       SRC       Hyperion tree of the build (for SOURCE.txt / BUILD-INFO)    DIST  output (default <repo>/dist)
#
# Steps: 1. scripts/mk-dist-dev.sh assembles the site (page, runtime, conf, boot files, DASD, licenses,
#        source notice) into $DIST.stage; 2. scripts/bundle-hash.py gives every loaded file a
#        content-hashed name and writes entry.json, _headers, 404.html, .nojekyll; 3. checks and sizes.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
export HERC_OUT=${HERC_OUT:-$HOME/build/webmvs/out/web}
export DASD=${DASD:-$HOME/build/webmvs/dasd}
export SEED=${SEED:-$HOME/build/webmvs/seed}
export SRC=${SRC:-$HOME/src/hyperion-wasm}
DIST=${DIST:-$REPO/dist}
HARGS=(); MKTAR=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) HARGS+=(--keep "$(cd "$2" && pwd)"); shift 2 ;;
    --precompress) HARGS+=(--precompress); shift ;;
    --tar) MKTAR=1; shift ;;
    *) echo "usage: $0 [--keep <previous dist>] [--precompress] [--tar]"; exit 2 ;;
  esac
done
STAGE=$DIST.stage
echo "== 1. assemble ($STAGE)"
DIST=$STAGE "$REPO/scripts/mk-dist-dev.sh" > "$STAGE.log" 2>&1 || { tail -30 "$STAGE.log"; exit 1; }
grep -E '^(largest|files|license|host paths|BUILD-INFO)' "$STAGE.log" || true
echo "== 2. content-hashed names ($DIST.tmp)"
python3 "$REPO/scripts/bundle-hash.py" "$STAGE" "$DIST.tmp" ${HARGS[@]+"${HARGS[@]}"}
rm -rf "$DIST"; mv "$DIST.tmp" "$DIST"; rm -rf "$STAGE" "$STAGE.log"
echo "== 3. $DIST"
cd "$DIST"
nf=$(find . -type f | wc -l); nb=$(find . -type f -printf '%s\n' | awk '{s+=$1} END {print s}')
echo "files: $nf (Cloudflare Pages limit 20,000), bytes: $nb (GitHub Pages site limit 1 GB)"
echo "largest: $(find . -type f -printf '%s %P\n' | sort -n | tail -1) (limits: Cloudflare 25 MiB, GitHub 100 MB per file)"
echo "dasd/c: $(ls dasd/c | wc -l) files, $(du -sb dasd/c | cut -f1) bytes"
echo "no-cache entry files: index.html entry.json coi-serviceworker.js; build $(python3 -c 'import json;print(json.load(open("entry.json"))["build"])')"
echo "sizes on the wire (raw / gzip -5 = GitHub Pages / brotli -q 4, -q 11):"
for f in $(python3 -c 'import json;e=json.load(open("entry.json"));print(" ".join(v for k,v in e["files"].items() if not k.startswith(("boot/","conf/","dasd/seed/"))))') index.html coi-serviceworker.js; do
  printf '  %-44s %9d %9d %9d %9d\n' "$f" "$(stat -c %s "$f")" "$(gzip -5 -n -c "$f" | wc -c)" "$(brotli -q 4 -c "$f" | wc -c)" "$(brotli -q 11 -c "$f" | wc -c)"
done
if [ "$MKTAR" = 1 ]; then
  BID=$(python3 -c 'import json;print(json.load(open("entry.json"))["build"])')
  T=$DIST-$BID.tar.gz
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - . | gzip -n -6 > "$T"
  ( cd "$(dirname "$T")" && sha256sum "$(basename "$T")" > "$(basename "$T").sha256" )
  echo "tar: $T ($(stat -c %s "$T") bytes), sha256 $(cut -d' ' -f1 "$T.sha256")"
fi
