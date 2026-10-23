#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# generate config.h for wasm32 in ~/src/hyperion-wasm with emconfigure.
set -euo pipefail
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
EXT=${EXT:-$HOME/ext-wasm}
# MULTICPU (default 1 = MAX_CPU_ENGS 1, web.cnf NUMCPU 1): experiment with 2 CPUs
SRC=${SRC:-$HOME/src/hyperion-wasm}
cd "$SRC"
./autogen.sh > autogen-wasm.log 2>&1
# configure.ac:2728 rejects every build without shared libraries ("external-gui requires
# loadable modules"), and libtool reports no shared-library support for emscripten. The wasm
# build uses a static HDL registry (patch 0004), so let a cache value override the check.
# This edits only the generated ./configure (re-created by autogen.sh), not a source file.
sed -i 's/^hc_cv_hdl_build_shared=\$enable_shared$/hc_cv_hdl_build_shared=${hc_cv_hdl_build_shared:-$enable_shared}/' configure
grep -q 'hc_cv_hdl_build_shared=${hc_cv_hdl_build_shared:-' configure
# lt_cv_prog_gnu_ld=no: HC_LD_DISALLOWDUPS adds -Wl,--warn-common for GNU ld; wasm-ld rejects it,
# which makes every link test fail (zlib, bzip2, sizeof runs, ...).
# Make sure the emscripten ports exist before configure tries to link them.
echo 'int main(){return 0;}' > /tmp/wc-port.c
emcc -pthread -sUSE_ZLIB=1 -sUSE_BZIP2=1 /tmp/wc-port.c -o /tmp/wc-port.js
CFLAGS="-O2 -pthread -sUSE_ZLIB=1 -sUSE_BZIP2=1" LDFLAGS="-pthread -sUSE_ZLIB=1 -sUSE_BZIP2=1" \
hc_cv_hdl_build_shared=yes ac_cv_func_fork=no lt_cv_prog_gnu_ld=no hc_cv_builtin_alloca_broke=no hc_cv_regparm_attr_broke=yes \
emconfigure ./configure --host=wasm32-unknown-emscripten --enable-extpkgs="$EXT" \
  --disable-shared --enable-static --without-included-ltdl --enable-multi-cpu="${MULTICPU:-1}" \
  --enable-regina-rexx=no --enable-object-rexx=no --disable-ipv6 > configure-wasm.log 2>&1
echo "configure rc=$?"
grep -n -E 'HAVE_ZLIB|HAVE_BZLIB|BZIP2|HAVE_LIBZ|HAVE_LIBBZ2|HAVE_FORK|MAX_CPU_ENGS|HAVE_DLFCN|OPTION_DYNAMIC_LOAD|HDL_' config.h || true
