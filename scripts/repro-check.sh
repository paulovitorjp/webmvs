#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# prove that the browser build is reproducible. Two clean builds of the same tree
# (scripts/build-wasm.sh resets $SRC to the pin and applies the patches each time) into two different
# OBJ/OUT dirs, at different times of day, must give the same hercules.wasm and hercules.js (sha256).
# __DATE__/__TIME__ come from SOURCE_DATE_EPOCH (src/wasm/Makefile.wasm).
#
# Usage (host): scripts/repro-check.sh
# Env: EXT  extpkgs install dir (default ~/build/webmvs/ext)    SRC  Hyperion tree (default ~/src/hyperion-repro)
#      B    work dir (default ~/build/repro): $B/{obj,out}-{a,b}, logs $B/build-{a,b}.log
#      TARGET (default web), GAP seconds to wait between the builds (default 65: another minute in __TIME__)
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
EXT=${EXT:-$HOME/build/webmvs/ext}; SRC=${SRC:-$HOME/src/hyperion-repro}; B=${B:-$HOME/build/repro}
TARGET=${TARGET:-web}; GAP=${GAP:-65}
mkdir -p "$B"
for r in a b; do
  [ "$r" = b ] && sleep "$GAP"
  echo "== build $r at $(date -u +%H:%M:%S)"
  EXT=$EXT SRC=$SRC OBJ=$B/obj-$r OUT=$B/out-$r TARGET=$TARGET "$REPO/scripts/build-wasm.sh" > "$B/build-$r.log" 2>&1
  rc=$?; echo "build $r rc=$rc ($(grep -m1 '^SOURCE_DATE_EPOCH' "$B/build-$r.log"))"; [ $rc = 0 ] || exit $rc
done
d=; [ "$TARGET" = web ] && d=/web
ok=1
for f in hercules.wasm hercules.js; do
  a=$(sha256sum < "$B/out-a$d/$f" | cut -c1-64); b=$(sha256sum < "$B/out-b$d/$f" | cut -c1-64)
  echo "$f a=$a b=$b size=$(stat -c %s "$B/out-a$d/$f")/$(stat -c %s "$B/out-b$d/$f") $([ "$a" = "$b" ] && echo SAME || echo DIFFERENT)"
  [ "$a" = "$b" ] || ok=0
done
echo "build date/time strings in hercules.wasm:"
strings "$B/out-a$d/hercules.wasm" | grep -E '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 0-9][0-9] [0-9]{4}|^[0-9]{2}:[0-9]{2}:[0-9]{2}$' | sort | uniq -c | head
if [ $ok = 1 ]; then echo "REPRODUCIBLE: yes"; else
  echo "REPRODUCIBLE: no; differing strings:"; diff <(strings "$B/out-a$d/hercules.wasm") <(strings "$B/out-b$d/hercules.wasm") | head -20; exit 1; fi
