#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Browser build driver: Hyperion extpkgs, hercules.wasm, lazy DASD chunks and the seed shadow.
# Then make the deployable site with scripts/bundle.sh (see README.md and docs/DEPLOY.md).
#
# Usage: scripts/build.sh ext | build | chunks | seed | all
# Env: PACKS (default 0 = no DASD boot packs, scripts/dasd-packs.py), META (l2delta | none),
#      LCL400_KEEP (default 4: SYS1.VTAMLST(LCL400) trimmed to the 4 terminals of web.cnf),
#      VTAMLIB_STUB (default 1: SYS1.VTAMLIB IEDIAE/IEDIAK stub),
#      B (out dir, default ~/build/webmvs), SRC (Hyperion tree, default ~/src/hyperion-wasm), EXT (extpkgs, $B/ext),
#      L (logs, $B/logs), TAR (MVS/CE release tar, <repo>/dasd/mvsce/...; scripts/get-mvsce.sh).
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
B=${B:-$HOME/build/webmvs}; L=${L:-$B/logs}
SRC=${SRC:-$HOME/src/hyperion-wasm}
EXT=${EXT:-$B/ext}
TAR=${TAR:-$REPO/dasd/mvsce/MVSCE.release.v3.0.0.tar}
LCL400_KEEP=${LCL400_KEEP:-4}
VTAMLIB_STUB=${VTAMLIB_STUB:-1}
mkdir -p "$B" "$L"
case "${1:-}" in
ext)
  SRCROOT=$B/extsrc EXT=$EXT BUILDROOT=$B/extbuild "$REPO/scripts/build-extpkgs-wasm.sh" > "$L/extpkgs.log" 2>&1
  echo "extpkgs rc=$?"; ls -l "$EXT/lib" ;;
build)
  EXT=$EXT SRC=$SRC OBJ=$B/obj OUT=$B/out TARGET=web "$REPO/scripts/build-wasm.sh" > "$L/build.log" 2>&1
  rc=$?; echo "build rc=$rc"; grep -E '^apply|^applied|files changed|config.h|SOURCE_DATE_EPOCH' "$L/build.log"
  echo "warnings: $(grep -c 'warning:' "$L/build.log"), errors: $(grep -c 'error:' "$L/build.log")"
  grep -E ' error' "$L/build.log" | head -20
  grep -oE -- '-sPTHREAD_POOL_SIZE=[0-9]+|-sPTHREAD_POOL_SIZE_STRICT=[0-9]+|-sINITIAL_MEMORY=[0-9A-Za-z]+|-sWASMFS|-sENVIRONMENT=[a-z,]+|lazydasd.cpp|library_lazydasd.js' "$L/build.log" | sort -u | tr '\n' ' '; echo
  ls -l "$B/out/web"; sha256sum "$B/out/web"/hercules.{wasm,js}; exit $rc ;;
chunks)  # lazy chunks (dasd-chunk.py) with the LCL400 trim and the VTAMLIB stub
  # boot list = native trace + 6 browser traces (dasd/manifest/browser-boot, copied to $B/boot)
  mkdir -p "$B/boot"; [ -n "$(ls "$B/boot" 2>/dev/null)" ] || cp "$REPO/dasd/manifest/browser-boot/"*.csv "$B/boot/"
  BOOT=$REPO/dasd/manifest/boot-tracks.csv
  for f in "$B"/boot/*.csv; do BOOT=$BOOT,$f; done
  # native re-trace with WORK00 (0251) appended: its tracks join the boot list (dasd/manifest/work00/README.md)
  BOOT=$BOOT,$REPO/dasd/manifest/work00/boot-tracks.csv
  rm -rf "$B/dasd"
  STUB=(); [ "$VTAMLIB_STUB" = 1 ] && STUB=(--vtamlib-stub)
  python3 "$REPO/scripts/dasd-chunk.py" --cnf "$REPO/conf/web.cnf" --tar "$TAR" --boot "$BOOT" \
    --boot-ikt "$REPO/dasd/manifest/boot-tracks-ikt007i.csv,$REPO/dasd/manifest/work00/boot-tracks-ikt007i.csv" --out "$B/dasd" \
    --mode bootsplit --chunk-kib 128 --split-min 0 ${LCL400_KEEP:+--lcl400-keep "$LCL400_KEEP"} ${STUB[@]+"${STUB[@]}"} > "$L/chunks.log" 2>&1
  rc=$?
  # compact metadata (META, default l2delta) + boot packs (the boot list as PACKS files; default 0 = none: not faster)
  [ $rc = 0 ] && { python3 "$REPO/scripts/dasd-packs.py" "$B/dasd" --packs "${PACKS:-0}" --meta "${META:-l2delta}" >> "$L/chunks.log" 2>&1; rc=$?; }
  echo "chunks rc=$rc"; cat "$L/chunks.log"; ls "$B/dasd/c" | wc -l; exit $rc ;;
seed)    # SMF off: SYS1.PARMLIB(SMFPRM00) MAN=NONE as a seed shadow for MVSRES (mk-seed-shadow.py)
  mkdir -p "$B/seed" "$B/pristine"
  [ -f "$B/pristine/mvsres.3350" ] || tar -xf "$TAR" -C "$B/pristine" --strip-components=2 MVSCE/DASD/mvsres.3350
  python3 "$REPO/scripts/mk-seed-shadow.py" "$B/pristine/mvsres.3350" "$B/seed/mvsres_1.cckd" || exit 1
  python3 - "$B/seed" <<'EOF'
import hashlib, json, os, sys
d = sys.argv[1]; f = os.path.join(d, 'mvsres_1.cckd'); b = open(f, 'rb').read()
j = {'format': 1, 'what': 'seed shadow files: copied into the OPFS shadow dir when the file does not exist yet',
     'files': [{'name': 'mvsres_1.cckd', 'file': 'mvsres_1.cckd', 'size': len(b), 'sha256': hashlib.sha256(b).hexdigest(),
                'change': "SYS1.PARMLIB(SMFPRM00) MAN=ALL -> MAN=NONE (SMF recording off), JWT=30 -> JWT=999 (resume gaps up to 16.6 h; scripts/mk-seed-shadow.py)"}]}
json.dump(j, open(os.path.join(d, 'seed.json'), 'w'), indent=1); print(json.dumps(j['files'][0]))
EOF
  ;;
all) "$0" ext && "$0" build && "$0" chunks && "$0" seed ;;
*) echo "usage: $0 ext|build|chunks|seed|all"; exit 2 ;;
esac
