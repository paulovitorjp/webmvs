#!/bin/bash
# Run the longjmp benchmark on the build host: native, Node, headless Chromium and Firefox.
# Pinned to 4 cores (taskset -c 12-15). Usage: ./run.sh [N=10000000] [reps=5]
set -uo pipefail
cd "$(dirname "$0")"
N=${1:-10000000}; R=${2:-5}
TS="taskset -c 12-15"
V="wasm-eh-legacy wasm-eh-exnref sjlj-wasm-noeh js-sjlj"
EMNODE=$(ls -d ~/emsdk/node/*/bin/node 2>/dev/null | tail -1)
echo "== host: $(nproc) cpus, load: $(cut -d' ' -f1-3 /proc/loadavg), affinity: 12-15"
echo "== native (gcc -O3)"; $TS ./out/native $N $R | sed 's/^/native | /'; echo "rc=${PIPESTATUS[0]}"
for NODE in /usr/bin/node $EMNODE; do
  echo "== node $NODE $($NODE --version) (V8 $($NODE -p process.versions.v8))"
  for v in $V; do
    $TS $NODE out/$v.js $N $R 2>&1 | sed "s/^/node$($NODE --version) $v | /"; echo "rc=${PIPESTATUS[0]}"
  done
done
echo "== browsers"
$TS node run-browsers.mjs $N $R chromium firefox -- $V 2>&1
echo "rc=$?"
echo "== browsers, direct (no Playwright)"
$TS node run-direct.mjs $N ${R_DIRECT:-3} chromium firefox -- $V 2>&1
echo "rc=$?"
