#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Incremental helper: reset the tracked files of ~/src/hyperion-wasm to the pin,
# re-apply the patch list, keep config.h (untracked) and the object directory.
# Then: NOCLEAN=1 scripts/build-wasm.sh. Use RMOBJ=1 to drop all objects (header changes).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
SRC=${SRC:-$HOME/src/hyperion-wasm}
PIN=ee86c4de066fcdb2ec898a157ff4c687c5f01ce2
PATCHES=${PATCHES:-"0001 0002 0003 0004 0005 0006 0011 0012 0013"}
cp -p "$SRC/config.h" /tmp/wasm-core-config.h
git -C "$SRC" reset -q --hard $PIN
for n in $PATCHES; do
  p=$(ls "$REPO"/patches/hyperion/$n-*.patch)
  git -C "$SRC" apply --whitespace=nowarn "$p" && echo "applied $(basename "$p")"
done
cp -p /tmp/wasm-core-config.h "$SRC/config.h"
[ -n "${RMOBJ:-}" ] && rm -rf "${OBJ:-$HOME/build/wasm-core/obj}" && echo "objects removed"
true
