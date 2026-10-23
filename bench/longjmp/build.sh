#!/bin/bash
# Build the longjmp micro-benchmark: native (gcc -O3) and four emcc 6.0.13 variants.
# Run on the build host from ~/webmvs/bench/longjmp. Output in ./out/.
set -euo pipefail
cd "$(dirname "$0")"
source ~/emsdk/emsdk_env.sh > /dev/null 2>&1
mkdir -p out
emcc --version | head -1
gcc --version | head -1
TS="taskset -c 12-15"
$TS gcc -O3 -o out/native longjmp_bench.c
# Common wasm flags. MIN_NODE_VERSION lowered so the output runs on the host Node 18.19.1.
COMMON="-O3 -sENVIRONMENT=web,node -sMIN_NODE_VERSION=181900 -sEXIT_RUNTIME=1"
build() { local name=$1; shift; echo "== $name: emcc $COMMON $*"; $TS emcc $COMMON "$@" -o out/$name.js longjmp_bench.c; ls -l out/$name.wasm; }
build wasm-eh-legacy -fwasm-exceptions -sSUPPORT_LONGJMP=wasm
build wasm-eh-exnref -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=0
build sjlj-wasm-noeh -sSUPPORT_LONGJMP=wasm
build js-sjlj        -sSUPPORT_LONGJMP=emscripten
# Record which EH opcodes each module uses (try/catch = legacy, try_table/throw_ref = exnref).
for m in wasm-eh-legacy wasm-eh-exnref sjlj-wasm-noeh js-sjlj; do
  echo "== $m opcodes:"; ~/emsdk/upstream/bin/wasm-dis --all-features out/$m.wasm 2>/dev/null \
    | grep -oE '\((try_table|try|catch_all|catch|throw_ref|throw|delegate|rethrow)\b' | sort | uniq -c || true
  # Import names are minified at -O3; JS SjLj adds an invoke_vii-shaped import (i32 i32 i32) and
  # a no-arg _emscripten_throw_longjmp import, Wasm SjLj adds neither.
  echo "== $m imports:"; ~/emsdk/upstream/bin/wasm-dis --all-features out/$m.wasm 2>/dev/null | grep '(import ' || true
done
