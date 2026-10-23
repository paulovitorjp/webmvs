#!/bin/bash
# Usage: ./run.sh [N] [reps]   (taskset 12-15; Node 24 + Chromium + Firefox, playwright from ../longjmp/node_modules)
set -uo pipefail
cd "$(dirname "$0")"; N=${1:-2000000}; R=${2:-5}; TS="taskset -c ${CPUS:-12-15}"
NODE=$HOME/emsdk/node/24.19.0_64bit/bin/node
[ -e node_modules ] || ln -s ../longjmp/node_modules node_modules
echo "== load $(cut -d' ' -f1-3 /proc/loadavg)"
for v in st-legacy pt-legacy pt-exnref; do $TS $NODE out/$v.js $N $R 2>&1 | sed "s/^/node24 $v | /"; done
$TS $NODE run-browsers.mjs $N $R chromium firefox -- st-legacy pt-legacy pt-exnref 2>&1
