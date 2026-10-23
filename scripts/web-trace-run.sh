#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# one traced boot of the web config with the trace build (~/herc-trace, patches/0000-trace-trk.patch):
# fresh shadows, boot, TSO logon to READY (tso-smoke.sh, 1 run), cckd stats, clean shutdown, then
# scripts/boot-manifest.py -> ~/webmvs/dasd/manifest/.
# Usage (on host): scripts/web-trace-run.sh
set -u
H=$HOME/webmvs; cd "$H"
M=$H/dasd/manifest; mkdir -p "$M"
export HERC=$HOME/herc-trace/bin/hercules HERC_TRK_TRACE=$M/trace-raw.txt
rm -f "$HERC_TRK_TRACE"
scripts/web-run.sh web-trace 1
R=$(grep -o 'READY seen at epoch [0-9.]*' logs/web-trace-smoke1.log | head -1 | awk '{print $NF}')
C=$(grep -o 'connect at epoch [0-9.]*' logs/web-trace-smoke1.log | head -1 | awk '{print $NF}')
[ -n "$R" ] || { echo "no READY epoch"; exit 1; }
echo "smoke connect epoch $C, READY epoch $R"
python3 scripts/boot-manifest.py --trace "$HERC_TRK_TRACE" --cnf conf/web.cnf --rundir dasd/web \
  --ts logs/web-trace.log.ts --ready "$R" --out "$M"
n=$(grep -n 'cckd stats' logs/web-trace.log | tail -1 | cut -d: -f1); sed -n "$n,$((n+11))p" logs/web-trace.log
ls -l "$M"
