#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Browser build driver: Hyperion extpkgs, hercules.wasm, lazy DASD chunks and the seed shadow.
# Then make the deployable site with scripts/bundle.sh (see README.md and docs/DEPLOY.md).
#
# Usage: scripts/build.sh ext | build | kicks | carddemo | indfile | chunks | seed | all
# Env: PACKS (default 0 = no DASD boot packs, scripts/dasd-packs.py), META (l2delta | none),
#      LCL400_KEEP (default 4: SYS1.VTAMLST(LCL400) trimmed to the 4 terminals of web.cnf),
#      VTAMLIB_STUB (default 1: SYS1.VTAMLIB IEDIAE/IEDIAK stub, applied by 'kicks' before the install),
#      B (out dir, default ~/build/webmvs), SRC (Hyperion tree, default ~/src/hyperion-wasm), EXT (extpkgs, $B/ext),
#      L (logs, $B/logs), TAR (MVS/CE release tar, <repo>/dasd/mvsce/...; scripts/get-mvsce.sh),
#      HERC (native Hercules bin dir for the KICKS install, default ~/herc-native/bin), KICKS_ZIP (a local copy
#      of kicks-tso-v1r5m0.zip instead of the download), CARDDEMO_TGZ (a local copy of the CardDemo tarball).
# KICKS for TSO (Mike Noel, http://www.kicksfortso.com/) is not in this repository: 'kicks' downloads the
# distribution zip (sha256 pinned below) and installs it natively; 'chunks' and 'seed' then use its volumes.
# CardDemo (Apache-2.0, Copyright Amazon.com, Inc. or its affiliates): 'carddemo' downloads the repository at
# the pinned commit, converts and installs the programs on CARDD0 on top of the KICKS volumes (carddemo-install.py).
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
B=${B:-$HOME/build/webmvs}; L=${L:-$B/logs}
SRC=${SRC:-$HOME/src/hyperion-wasm}
EXT=${EXT:-$B/ext}
TAR=${TAR:-$REPO/dasd/mvsce/MVSCE.release.v3.0.0.tar}
LCL400_KEEP=${LCL400_KEEP:-4}
VTAMLIB_STUB=${VTAMLIB_STUB:-1}
HERC=${HERC:-$HOME/herc-native/bin}
KICKS_SHA256=e0df01bee1988c1c73dbb0a49e082e8ae9fda5822a02f8b9c798583565c177f1
KICKS_URLS="https://github.com/moshix/kicks/raw/d2fa27b17c659b9f3c9d3cf33442d43679f1337f/kicks-tso-v1r5m0.zip https://www.jaymoseley.com/hercules/kicks/kicks-tso-v1r5m0.zip"
KV=$B/kicks/out   # mvsres.3350, mvs000.3350 (KICKS install changes) and kicks0.3350
CARDDEMO_COMMIT=59cc6c2fd7ebd7ef7925cad552a01a4b8b6e4d5e
CARDDEMO_SHA256=a22c114ba79df73f86578495fbceb4062ae53e0cb335f5d2950598caf011684f
CARDDEMO_URL=https://codeload.github.com/aws-samples/aws-mainframe-modernization-carddemo/tar.gz/$CARDDEMO_COMMIT
CV=$B/carddemo/out   # mvsres.3350, mvs000.3350 (CardDemo install changes on top of KICKS) and cardd0.3350
IV=$B/indfile/out    # mvs000.3350 with IND$FILE in SYS2.CMDLIB (on top of the CardDemo install)
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
kicks)   # KICKS for TSO 1.5.0 on fresh MVS/CE volumes (scripts/kicks-install.py): $B/kicks/out
  K=$B/kicks; mkdir -p "$K"
  Z=$K/kicks-tso-v1r5m0.zip
  if [ -n "${KICKS_ZIP:-}" ]; then cp "$KICKS_ZIP" "$Z"; fi
  if ! echo "$KICKS_SHA256  $Z" | sha256sum -c --status 2>/dev/null; then
    for u in $KICKS_URLS; do curl -fsSL -o "$Z" "$u" && echo "$KICKS_SHA256  $Z" | sha256sum -c --status && break; done
  fi
  echo "$KICKS_SHA256  $Z" | sha256sum -c || exit 1
  rm -rf "$K/MVSCE" "$K/base" "$KV"; tar -xf "$TAR" -C "$K" MVSCE || exit 1
  mkdir -p "$K/base"; tar -xf "$TAR" -C "$K/base" --strip-components=2 MVSCE/DASD/mvs000.3350 || exit 1
  # the VTAMLIB stub (vtamlib-stub.py) applies to the pinned release mvsres only: before the install, not in 'chunks'
  if [ "$VTAMLIB_STUB" = 1 ]; then
    python3 "$REPO/scripts/vtamlib-stub.py" "$K/MVSCE/DASD/mvsres.3350" "$K/mvsres.stub" > "$L/kicks.log" 2>&1 \
      && mv "$K/mvsres.stub" "$K/MVSCE/DASD/mvsres.3350" || { cat "$L/kicks.log"; exit 1; }
  fi
  python3 "$REPO/scripts/kicks-install.py" --mvsce "$K/MVSCE" --zip "$Z" --out "$KV" --herc "$HERC" --base "$K/base" >> "$L/kicks.log" 2>&1
  rc=$?; cat "$L/kicks.log"; [ $rc = 0 ] && rm -rf "$K/MVSCE" "$K/base"; echo "kicks rc=$rc"; exit $rc ;;
carddemo)   # CardDemo on CARDD0 (0352), on the KICKS volumes: $B/carddemo/out
  [ -f "$KV/kicks0.3350" ] || { echo "no $KV/kicks0.3350: run scripts/build.sh kicks first"; exit 1; }
  C=$B/carddemo; mkdir -p "$C"; T=$C/carddemo-$CARDDEMO_COMMIT.tar.gz
  if [ -n "${CARDDEMO_TGZ:-}" ]; then cp "$CARDDEMO_TGZ" "$T"; fi
  echo "$CARDDEMO_SHA256  $T" | sha256sum -c --status 2>/dev/null || curl -fsSL -o "$T" "$CARDDEMO_URL"
  echo "$CARDDEMO_SHA256  $T" | sha256sum -c || exit 1
  rm -rf "$C/MVSCE" "$C/src" "$CV"; mkdir -p "$C/src"; tar -xzf "$T" -C "$C/src" --strip-components=1 || exit 1
  tar -xf "$TAR" -C "$C" MVSCE || exit 1
  cp "$KV"/*.3350 "$C/MVSCE/DASD/"
  # KICKS0 at 0351 as in conf/web.cnf; CARDD0 (0352) is added by the install
  sed -i 's|^0253    3350    DASD/syscpk.3350$|&\n0351    3350    DASD/kicks0.3350|' "$C/MVSCE/conf/local.cnf"
  grep -q '^0351 ' "$C/MVSCE/conf/local.cnf" || { echo "no 0351 line in local.cnf"; exit 1; }
  python3 "$REPO/scripts/carddemo-install.py" --mvsce "$C/MVSCE" --src "$C/src" --out "$CV" --herc "$HERC" --base "$KV" > "$L/carddemo.log" 2>&1
  rc=$?; grep -v '^HHC' "$L/carddemo.log"
  # KICKS0 ships from the KICKS install: the CardDemo install must not change it
  [ $rc = 0 ] && { cmp -s "$KV/kicks0.3350" "$C/MVSCE/DASD/kicks0.3350" || { echo "the install changed kicks0.3350"; rc=1; }; }
  [ $rc = 0 ] && rm -rf "$C/MVSCE" "$C/src"; echo "carddemo rc=$rc"; exit $rc ;;
indfile)   # IND$FILE 2.0.5 (3270 file transfer) from the release's MVP package into SYS2.CMDLIB: $B/indfile/out
  [ -f "$CV/cardd0.3350" ] || { echo "no $CV/cardd0.3350: run scripts/build.sh carddemo first"; exit 1; }
  I=$B/indfile; rm -rf "$I/MVSCE" "$IV"; mkdir -p "$I"; tar -xf "$TAR" -C "$I" MVSCE || exit 1
  cp "$KV/kicks0.3350" "$CV"/*.3350 "$I/MVSCE/DASD/"
  sed -i 's|^0253    3350    DASD/syscpk.3350$|&\n0351    3350    DASD/kicks0.3350\n0352    3350    DASD/cardd0.3350|' "$I/MVSCE/conf/local.cnf"
  grep -q '^0352 ' "$I/MVSCE/conf/local.cnf" || { echo "no 0352 line in local.cnf"; exit 1; }
  python3 "$REPO/scripts/indfile-install.py" --mvsce "$I/MVSCE" --out "$IV" --herc "$HERC" --base "$CV" > "$L/indfile.log" 2>&1
  rc=$?; grep -v '^HHC' "$L/indfile.log"; [ $rc = 0 ] && rm -rf "$I/MVSCE"; echo "indfile rc=$rc"; exit $rc ;;
chunks)  # lazy chunks (dasd-chunk.py) with the LCL400 trim and the VTAMLIB stub
  # boot list = native trace + 6 browser traces (dasd/manifest/browser-boot, copied to $B/boot)
  mkdir -p "$B/boot"; [ -n "$(ls "$B/boot" 2>/dev/null)" ] || cp "$REPO/dasd/manifest/browser-boot/"*.csv "$B/boot/"
  BOOT=$REPO/dasd/manifest/boot-tracks.csv
  for f in "$B"/boot/*.csv; do BOOT=$BOOT,$f; done
  # native re-trace with WORK00 (0251) appended: its tracks join the boot list (dasd/manifest/work00/README.md)
  BOOT=$BOOT,$REPO/dasd/manifest/work00/boot-tracks.csv
  # KICKS0 (0351), CARDD0 (0352): only their label and VTOC tracks are read at IPL (dasd/manifest/kicks0, cardd0)
  BOOT=$BOOT,$REPO/dasd/manifest/kicks0/boot-tracks.csv,$REPO/dasd/manifest/cardd0/boot-tracks.csv
  [ -f "$KV/kicks0.3350" ] || { echo "no $KV/kicks0.3350: run scripts/build.sh kicks first"; exit 1; }
  [ -f "$CV/cardd0.3350" ] || { echo "no $CV/cardd0.3350: run scripts/build.sh carddemo first"; exit 1; }
  [ -f "$IV/mvs000.3350" ] || { echo "no $IV/mvs000.3350: run scripts/build.sh indfile first"; exit 1; }
  # volumes: the release tar, with KICKS0 from the KICKS install, MVSRES and CARDD0 from the CardDemo install,
  # MVS000 from the IND$FILE install (CardDemo's MVS000 plus SYS2.CMDLIB(IND$FILE))
  V=$B/vols; rm -rf "$V"; mkdir -p "$V"; tar -xf "$TAR" -C "$V" --strip-components=2 --wildcards 'MVSCE/DASD/*' || exit 1
  cp "$KV"/*.3350 "$V/"; cp "$CV"/*.3350 "$V/"; cp "$IV/mvs000.3350" "$V/"
  rm -rf "$B/dasd"
  STUB=()   # VTAMLIB stub: already in the KICKS install's mvsres (scripts/build.sh kicks), kept by carddemo
  python3 "$REPO/scripts/dasd-chunk.py" --cnf "$REPO/conf/web.cnf" --voldir "$V" --boot "$BOOT" \
    --boot-ikt "$REPO/dasd/manifest/boot-tracks-ikt007i.csv,$REPO/dasd/manifest/work00/boot-tracks-ikt007i.csv,$REPO/dasd/manifest/kicks0/boot-tracks.csv,$REPO/dasd/manifest/cardd0/boot-tracks.csv" --out "$B/dasd" \
    --mode bootsplit --chunk-kib 128 --split-min 0 ${LCL400_KEEP:+--lcl400-keep "$LCL400_KEEP"} ${STUB[@]+"${STUB[@]}"} > "$L/chunks.log" 2>&1
  rc=$?
  # compact metadata (META, default l2delta) + boot packs (the boot list as PACKS files; default 0 = none: not faster)
  [ $rc = 0 ] && { python3 "$REPO/scripts/dasd-packs.py" "$B/dasd" --packs "${PACKS:-0}" --meta "${META:-l2delta}" >> "$L/chunks.log" 2>&1; rc=$?; }
  echo "chunks rc=$rc"; cat "$L/chunks.log"; ls "$B/dasd/c" | wc -l; exit $rc ;;
seed)    # SMF off: SYS1.PARMLIB(SMFPRM00) MAN=NONE as a seed shadow for MVSRES (mk-seed-shadow.py)
  mkdir -p "$B/seed"
  python3 "$REPO/scripts/mk-seed-shadow.py" "$CV/mvsres.3350" "$B/seed/mvsres_1.cckd" || exit 1
  python3 - "$B/seed" <<'EOF'
import hashlib, json, os, sys
d = sys.argv[1]; f = os.path.join(d, 'mvsres_1.cckd'); b = open(f, 'rb').read()
j = {'format': 1, 'what': 'seed shadow files: copied into the OPFS shadow dir when the file does not exist yet',
     'files': [{'name': 'mvsres_1.cckd', 'file': 'mvsres_1.cckd', 'size': len(b), 'sha256': hashlib.sha256(b).hexdigest(),
                'change': "SYS1.PARMLIB(SMFPRM00) MAN=ALL -> MAN=NONE (SMF recording off), JWT=30 -> JWT=999 (resume gaps up to 16.6 h; scripts/mk-seed-shadow.py)"}]}
json.dump(j, open(os.path.join(d, 'seed.json'), 'w'), indent=1); print(json.dumps(j['files'][0]))
EOF
  ;;
all) "$0" ext && "$0" build && "$0" kicks && "$0" carddemo && "$0" indfile && "$0" chunks && "$0" seed ;;
*) echo "usage: $0 ext|build|kicks|carddemo|indfile|chunks|seed|all"; exit 2 ;;
esac
