#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# N clean IPLs (empty shadows) of the wasm build under Node; prints IPL 150 -> IKT007I
# for each run and the HHC....[EWS] messages of each log. Usage: scripts/wasm-ipl-bench.sh [N] [tag]
set -u
H=$HOME/webmvs; N=${1:-3}; TAG=${2:-bench}
for i in $(seq 1 "$N"); do
  export LOG=${LOGPFX:-$H/logs/wasm-core}-$TAG-$i.log
  "$H/scripts/wasm-ipl.sh" start >/dev/null
  if "$H/scripts/wasm-ipl.sh" wait 600 > /tmp/wasm-core-wait.$$ 2>&1; then
    echo "run $i: $(grep 'IPL 150 -> IKT007I' /tmp/wasm-core-wait.$$)"
  else
    echo "run $i: FAILED"; tail -20 /tmp/wasm-core-wait.$$
  fi
  sleep 2
  "$H/scripts/wasm-ipl.sh" stop > /dev/null 2>&1
  grep -E "HHC[0-9]{5}[EWS]" "$LOG" | sed 's/^/    /' | sort | uniq -c
  grep -i -E "thread pool|pool is exhausted|Tried to spawn" "$LOG" | head -3
  tail -1 "$LOG"
done
rm -f /tmp/wasm-core-wait.$$
