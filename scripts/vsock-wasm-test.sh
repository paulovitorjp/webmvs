#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# test wasmsock.c compiled with Emscripten 6.0.13 (futex/atomics path), under Node.
#  1. src/wasm/wasmsock_test.c as wasm (8 client pthreads + console-like pselect thread, rings, doorbell).
#  2. src/wasm/vsock_echo_main.c as wasm behind scripts/node-harness.mjs (node:net on 127.0.0.1:3372,
#     main-thread hw_term_* calls), driven by scripts/vsock-echo-client.py over real TCP.
# Usage (on host): scripts/vsock-wasm-test.sh     Logs: ~/webmvs/logs/vsock/wasm-*.log
set -u
H=$HOME/webmvs W=$H/src/wasm B=$HOME/build/vsock-wasm L=$H/logs/vsock
mkdir -p "$B" "$L"
source ~/emsdk/emsdk_env.sh > /dev/null 2>&1
NODE=${EMSDK_NODE:-node}
echo "emcc: $(emcc --version | head -1)"; echo "node: $($NODE --version) ($NODE)"
COMMON="-O2 -pthread -Wall -sPROXY_TO_PTHREAD -sEXIT_RUNTIME=1 -sENVIRONMENT=node -sPTHREAD_POOL_SIZE_STRICT=1"
emcc $COMMON -sPTHREAD_POOL_SIZE=16 -sINITIAL_MEMORY=128MB -o "$B/wasmsock_test.js" "$W/wasmsock_test.c" "$W/wasmsock.c" > "$L/wasm-build1.log" 2>&1; echo "build wasmsock_test rc=$?"
emcc $COMMON -sPTHREAD_POOL_SIZE=4 -sINITIAL_MEMORY=64MB \
  -sEXPORTED_FUNCTIONS=_main,_hw_term_open,_hw_term_input,_hw_term_read,_hw_term_close,_hw_term_state,_hw_term_out_seq,_hw_term_buf,_hw_term_buf_size \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
  -o "$B/vsock_echo.js" "$W/vsock_echo_main.c" "$W/wasmsock.c" > "$L/wasm-build2.log" 2>&1; echo "build vsock_echo rc=$?"
grep -iE "warning|error" "$L/wasm-build1.log" "$L/wasm-build2.log" | head
echo "== 1. wasmsock_test under node"
timeout 300 $NODE "$B/wasmsock_test.js" > "$L/wasm-test.log" 2>&1; echo "rc=$?"; cat "$L/wasm-test.log"
echo "== 2. node-harness + vsock_echo (127.0.0.1:3372)"
HARNESS_PORT=3372 HARNESS_DEBUG=1 nohup $NODE "$H/scripts/node-harness.mjs" "$B/vsock_echo.js" > "$L/wasm-harness.log" 2>&1 &
HP=$!
for i in $(seq 1 30); do grep -q 'listening on' "$L/wasm-harness.log" && break; sleep 0.5; done
ss -ltnp | grep ':3372 '
python3 "$H/scripts/vsock-echo-client.py" 3372 6 1048576; r1=$?
python3 "$H/scripts/vsock-echo-client.py" 3372 1 4194304 --quit; r2=$?
for i in $(seq 1 20); do kill -0 $HP 2>/dev/null || break; sleep 0.5; done
kill -0 $HP 2>/dev/null && { echo "harness still running: kill $HP"; kill $HP; }
wait $HP 2>/dev/null; echo "harness exit rc=$?"
grep -vE "^node-harness: id [0-9]+: (client|Hercules) closed" "$L/wasm-harness.log" | tail -25
echo "== result: echo clients rc=$r1/$r2"
