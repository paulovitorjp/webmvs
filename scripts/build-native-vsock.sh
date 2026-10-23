#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# native Hyperion with the wasmsock shim (patch 0008) + TCP test bridge.
# Tree ~/src/hyperion-vsock (clone at ee86c4d), install prefix ~/herc-vsock.
# The shim and the bridge are built as ~/herc-vsock/lib/libwasmsock.so (one instance per process;
# hdt3270.so (console.c) links it through LIBS). The bridge listens on 127.0.0.1:${VSOCK_BRIDGE_PORT:-3370}
# when console.c first calls listen().
# Usage (on host): scripts/build-native-vsock.sh [lib|full]   (lib = rebuild only libwasmsock.so)
# Logs: ~/webmvs/logs/build-vsock-*.log
set -euo pipefail
PIN=ee86c4de066fcdb2ec898a157ff4c687c5f01ce2
SRC=~/src/hyperion-vsock PREFIX=~/herc-vsock LOG=~/webmvs/logs W=~/webmvs/src/wasm
PATCHES="0008-wasmsock-console.patch"
mkdir -p "$LOG" "$PREFIX/lib"
[ -d "$SRC/.git" ] || git clone -q ~/src/hyperion "$SRC"
cd "$SRC"
[ "$(git rev-parse HEAD)" = "$PIN" ] || git checkout -q "$PIN"
[ "$(git rev-parse HEAD)" = "$PIN" ] || { echo "PIN MISMATCH"; exit 2; }

echo "== libwasmsock.so"
gcc -O2 -g -Wall -Wextra -fPIC -shared -pthread -DWASMSOCK_NATIVE -I"$W" \
    -o "$PREFIX/lib/libwasmsock.so" "$W/wasmsock.c" "$W/vsock_native_bridge.c" > "$LOG/build-vsock-lib.log" 2>&1 \
  || { cat "$LOG/build-vsock-lib.log"; exit 1; }
[ "${1:-full}" = lib ] && { echo "LIB OK"; exit 0; }

echo "== patches"
for p in $PATCHES; do
  f=~/webmvs/patches/hyperion/$p
  if git apply --check -R "$f" 2>/dev/null; then echo "$p already applied"
  else git apply "$f" && echo "$p applied"; fi
done
git status --short | grep -v '\.in$\|configure$' || true

echo "== autogen"; ./autogen.sh > "$LOG/build-vsock-autogen.log" 2>&1
echo "== configure"
./configure --prefix="$PREFIX" \
  CPPFLAGS="-DUSE_WASMSOCK -I$W" \
  LIBS="-L$PREFIX/lib -lwasmsock -Wl,-rpath,$PREFIX/lib" > "$LOG/build-vsock-configure.log" 2>&1
echo "== make";    make -j16 > "$LOG/build-vsock-make.log" 2>&1 || { grep -E "error|Error" "$LOG/build-vsock-make.log" | head -30; exit 1; }
echo "== install"; make install > "$LOG/build-vsock-install.log" 2>&1
grep -c "warning:" "$LOG/build-vsock-make.log" | sed 's/^/make warnings total: /'
grep -E "console\.c.*warning" "$LOG/build-vsock-make.log" | head -10 || true
echo "== check: hdt3270 uses the shim"
M=$(ls "$PREFIX"/lib/hercules/hdt3270.so 2>/dev/null || ls "$PREFIX"/lib*/hercules/hdt3270* | head -1)
ldd "$M" | grep wasmsock
nm -D "$M" | grep -E " U (vsock_|pselect|accept|recv)" || true
echo "BUILD OK"
