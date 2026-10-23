#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# build the Hyperion extpkgs (crypto, decNumber, SoftFloat, telnet) for wasm32
# with emsdk 6.0.13 into $EXT (default ~/ext-wasm). Commits pinned in docs/PINS.md.
set -euo pipefail
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
EXT=${EXT:-$HOME/ext-wasm}
# BUILDROOT: parent of the <pkg>32.Release build dirs (default ~/build). EXTRA_CFLAGS: added to
# CMAKE_C_FLAGS, e.g. -ffile-prefix-map=$HOME/src/= (no host paths in __FILE__ strings).
BUILDROOT=${BUILDROOT:-$HOME/build}
EXTRA_CFLAGS=${EXTRA_CFLAGS:-}
# SRCROOT: parent of the ext-<pkg> git clones (default ~/src, shared). Give each parallel build its own SRCROOT
# The script checks out the pinned commit in each clone, so a shared clone can be
# moved under another build. A new clone is made from an existing ~/src/ext-<pkg> clone if there
# is one (no network), else from GitHub. -ffile-prefix-map=$SRCROOT/= is always added, so __FILE__
# strings are "ext-<pkg>/..." whatever SRCROOT is (same libs, same wasm for every build).
SRCROOT=${SRCROOT:-$HOME/src}
declare -A PIN=(
  [crypto]=9ac58405c2b91fb7cd230aed474dc7059f0fcad9
  [decNumber]=995184583107625015bb450228a5f3fb781d9502
  [SoftFloat]=e053494d988ec0648c92f683abce52597bfae745
  [telnet]=384b2542dfc9af67ca078e2bc13487a8fc234a3f
)
mkdir -p "$EXT" "$BUILDROOT"
for p in crypto decNumber SoftFloat telnet; do
  src=$SRCROOT/ext-$p
  if [ ! -d "$src/.git" ]; then
    if [ -d "$HOME/src/ext-$p/.git" ] && [ "$src" != "$HOME/src/ext-$p" ]; then
      git clone -q --no-checkout "$HOME/src/ext-$p" "$src"
    else
      git clone -q --no-checkout https://github.com/SDL-Hercules-390/$p "$src"
    fi
  fi
  git -C "$src" cat-file -e "${PIN[$p]}^{commit}" 2>/dev/null || git -C "$src" fetch -q https://github.com/SDL-Hercules-390/$p
  git -C "$src" checkout -q --detach "${PIN[$p]}"
  b=$BUILDROOT/${p}32.Release
  rm -rf "$b"; mkdir -p "$b"; cd "$b"
  echo "== $p @ $(git -C "$src" rev-parse HEAD)"
  emcmake cmake -DCMAKE_C_FLAGS="-pthread -O3 -ffile-prefix-map=$SRCROOT/= $EXTRA_CFLAGS" -DCMAKE_INSTALL_PREFIX="$EXT" "$src" > cmake.log 2>&1 || { tail -30 cmake.log; exit 1; }
  emmake make -j16 install > make.log 2>&1 || { tail -40 make.log; exit 1; }
done
ls -l "$EXT"/lib "$EXT"/include
