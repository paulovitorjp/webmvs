#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# build native SDL Hyperion (tag Release_4.9.1) into ~/herc-native.
# Note: tag Release_4.9.1 = ee86c4de (lightweight tag, on branch develop). It is one commit
# after master HEAD ae9b4971 and changes only the generated 'configure' (VERS_MIN 0 -> 1).
# autogen.sh regenerates configure from configure.ac (VERS_MIN=1 in both), so the build is
# the same. The script checks that the tree differs from ae9b4971 only in 'configure'.
# Logs: ~/webmvs/logs/build-native-*.log
set -euo pipefail
TAGPIN=ee86c4de066fcdb2ec898a157ff4c687c5f01ce2
BASEPIN=ae9b4971849e6560fae47f26bdd89f95accc994f
SRC=~/src/hyperion PREFIX=~/herc-native LOG=~/webmvs/logs
mkdir -p "$LOG" ~/src
if [ ! -d "$SRC/.git" ]; then git clone https://github.com/SDL-Hercules-390/hyperion "$SRC"; fi
cd "$SRC"
git fetch --tags -q origin
git checkout -q Release_4.9.1
HEAD=$(git rev-parse HEAD)
echo "HEAD=$HEAD"
[ "$HEAD" = "$TAGPIN" ] || { echo "PIN MISMATCH: expected $TAGPIN"; exit 2; }
DIFF=$(git diff --name-only "$BASEPIN" "$HEAD")
[ "$DIFF" = "configure" ] || { echo "UNEXPECTED DIFF vs $BASEPIN: $DIFF"; exit 3; }
echo "diff vs $BASEPIN: $DIFF only"
echo "== bldlvlck";  ./util/bldlvlck            > "$LOG/build-native-bldlvlck.log" 2>&1 || echo "bldlvlck rc=$?"
echo "== autogen";   ./autogen.sh               > "$LOG/build-native-autogen.log" 2>&1
echo "== configure"; ./configure --prefix="$PREFIX" > "$LOG/build-native-configure.log" 2>&1
echo "== make";      make -j16                  > "$LOG/build-native-make.log" 2>&1
echo "== install";   make install               > "$LOG/build-native-install.log" 2>&1
echo "BUILD OK"
