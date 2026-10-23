#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# build wasm Hercules (Node, NODERAWFS) from a clean tree.
#   1. reset ~/src/hyperion-wasm to ee86c4d and remove untracked files
#   2. apply patches/hyperion/NNNN-*.patch in order (default: 0001-0008 0011-0015 0017 0018 0019; 0019 = checkpoint staging in WasmFS memory during the pause; 0018 = incremental
#      checkpoints; 0017 = checkpoint crc32 read
#      through a read-write open; 0016 = 3270 record
#      trace, debug builds only, never in the default; 0015 = checkpoint/resume
#      ('checkpoint <dir>', sr.c fixes, build id); 0014 = CCKD write-through
#      for the browser build, off unless wasm_main --cckd-wrthru; 0007 = RETURN_INTCHECK
#      without longjmp, in the default since it measured faster;
#      WASMSOCK=0 leaves out 0008 and builds the no-3270 stub variant)
#   3. autogen + emconfigure (scripts/configure-wasm.sh)
#   4. make -f src/wasm/Makefile.wasm node
# Env: SRC (default ~/src/hyperion-wasm), EXT (~/ext-wasm), OBJ/OUT (Makefile.wasm defaults),
#      NOCLEAN=1 skips steps 1-3 (incremental rebuild), OPT (default -O3), JOBS (16),
#      WASMSOCK (default 1 = TN3270 shim, patch 0008 + src/wasm/wasmsock.c, out ~/build/wasm/out;
#      0 = stub variant, out ~/build/wasm/out-nosock).
#      TARGET (default node): make target; TARGET=web = browser build: ES6 module
#      $OUT/web/hercules.js (WEBOUT), WasmFS, -sENVIRONMENT=web,worker; Makefile vars WEBMEM and
#      WEBSTRICT can be given in the environment.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
SRC=${SRC:-$HOME/src/hyperion-wasm}
PIN=ee86c4de066fcdb2ec898a157ff4c687c5f01ce2
WASMSOCK=${WASMSOCK:-1}
if [ "$WASMSOCK" = 1 ]; then
  PATCHES=${PATCHES:-"0001 0002 0003 0004 0005 0006 0007 0008 0011 0012 0013 0014 0015 0017 0018 0019"}
else
  PATCHES=${PATCHES:-"0001 0002 0003 0004 0005 0006 0007 0011 0012 0013 0014"}   # (0015 needs 0008: console.c)
fi
JOBS=${JOBS:-16}
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
emcc --version | head -1
if [ -z "${NOCLEAN:-}" ]; then
  # a local clone (scripts/build-native.sh makes ~/src/hyperion) saves the download; else clone from GitHub
  if [ ! -d "$SRC/.git" ]; then
    if [ -d ~/src/hyperion/.git ]; then git clone -q ~/src/hyperion "$SRC"; else git clone -q https://github.com/SDL-Hercules-390/hyperion "$SRC"; fi
  fi
  git -C "$SRC" checkout -q --detach $PIN
  git -C "$SRC" reset -q --hard $PIN
  git -C "$SRC" clean -q -fdx
  for n in $PATCHES; do
    p=$(ls "$REPO"/patches/hyperion/$n-*.patch)
    echo "apply $(basename "$p")"
    git -C "$SRC" apply --whitespace=nowarn "$p" || { echo "patch $(basename "$p") does not apply"; exit 1; }
  done
  echo "applied: $PATCHES"; git -C "$SRC" diff --stat | tail -1
  SRC="$SRC" "$REPO/scripts/configure-wasm.sh"
  for d in HAVE_ZLIB HAVE_ZLIB_H CCKD_BZIP2 HAVE_BZLIB_H; do
    grep -q "^#define $d 1" "$SRC/config.h" || { echo "config.h: $d missing"; exit 1; }
  done
  echo "config.h: HAVE_ZLIB HAVE_ZLIB_H CCKD_BZIP2 HAVE_BZLIB_H ok"
  if [ "$WASMSOCK" = 1 ]; then rm -rf "${OBJ:-$HOME/build/wasm/obj}"; else rm -rf "${OBJ:-$HOME/build/wasm/obj-nosock}"; fi
fi
cd "$REPO"
# __DATE__/__TIME__ come from SOURCE_DATE_EPOCH (Makefile.wasm default: commit time of $SRC HEAD), so two
# clean builds of the same tree give the same hercules.wasm.
echo "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$SRC" log -1 --format=%ct) (default: commit time of $SRC HEAD)}"
TARGET=${TARGET:-node}
time make -f src/wasm/Makefile.wasm HERC="$SRC" WASMSOCK="$WASMSOCK" ${OPT:+OPT="$OPT"} -j"$JOBS" "$TARGET"
if [ "$WASMSOCK" = 1 ]; then OUTD=${OUT:-$HOME/build/wasm/out}; else OUTD=${OUT:-$HOME/build/wasm/out-nosock}; fi
[ "$TARGET" = web ] && OUTD=${WEBOUT:-$OUTD/web}
ls -l "$OUTD"
