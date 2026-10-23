#!/bin/bash
# the longjmp micro-benchmark (bench/longjmp/longjmp_bench.c, unchanged) built the way
# Hercules is built: -pthread + PROXY_TO_PTHREAD (main() and the longjmps run in a worker with shared
# memory), wasm EH legacy. Plus the single-thread build for reference. Output ./out/.
set -euo pipefail
cd "$(dirname "$0")"; source ~/emsdk/emsdk_env.sh > /dev/null 2>&1; mkdir -p out
TS="taskset -c ${CPUS:-12-15}"
SRC=../longjmp/longjmp_bench.c
EH="-fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
$TS emcc -O3 $EH -sENVIRONMENT=web,node -sEXIT_RUNTIME=1 -o out/st-legacy.js $SRC
$TS emcc -O3 $EH -pthread -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=2 -sINITIAL_MEMORY=64MB -sALLOW_MEMORY_GROWTH=0 \
  -sENVIRONMENT=web,worker,node -sEXIT_RUNTIME=1 -o out/pt-legacy.js $SRC
$TS emcc -O3 $EH -sWASM_LEGACY_EXCEPTIONS=0 -pthread -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=2 -sINITIAL_MEMORY=64MB \
  -sALLOW_MEMORY_GROWTH=0 -sENVIRONMENT=web,worker,node -sEXIT_RUNTIME=1 -o out/pt-exnref.js $SRC
ls -l out
