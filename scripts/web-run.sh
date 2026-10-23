#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# one complete web-config cycle on the host, no operator action:
#   reset shadows -> boot (HAO/rc only) -> wait IKT007I -> tso-smoke.sh N times -> cckd stats
#   -> clean shutdown (conf/web-shutdown.rc) -> check-ipl-log.sh on the whole log.
# Usage (on host): scripts/web-run.sh [tag] [smoke-runs]   (env HERC, HERC_TRK_TRACE pass through)
# Timings come from logs/<tag>.log.ts (host epoch ms per log line).
set -u
H=$HOME/webmvs; cd "$H"
TAG=${1:-web-ipl}; N=${2:-3}
export LOG=$H/logs/$TAG.log
S=scripts
$S/web-ipl.sh reset-shadows >/dev/null
$S/web-ipl.sh start >/dev/null || exit 1
timeout 300 $S/web-ipl.sh wait 280 || { $S/web-ipl.sh stop; exit 1; }
sleep 1
ok=0
for i in $(seq 1 "$N"); do
  SMOKE_LOG=$H/logs/$TAG-smoke$i.log timeout 150 $S/tso-smoke.sh 127.0.0.1:3270 > $H/logs/$TAG-smoke$i.out 2>&1
  rc=$?; echo "smoke $i rc=$rc $(grep -o 'TIME output: .*' $H/logs/$TAG-smoke$i.out) $(grep -E 'PASS|FAIL' $H/logs/$TAG-smoke$i.out | tail -1 | cut -c1-80)"
  [ $rc = 0 ] && ok=$((ok+1))
done
$S/web-ipl.sh cmd "cckd stats"; sleep 2
$S/web-ipl.sh shutdown 300; src=$?
echo "== check-ipl-log (whole log)"; $S/check-ipl-log.sh "$LOG" | grep -v '^allowed'; crc=${PIPESTATUS[0]}
TS=$LOG.ts
t() { grep -m1 -E "$1" "$TS" | cut -d' ' -f1; }
tipl=$(t 'HHC01603I IPL 150'); tikt=$(t 'IKT007I'); tsd=$(t 'IEE334I')
echo "== timings: IPL->IKT007I $(awk -v a="$tikt" -v b="$tipl" 'BEGIN{printf "%.3f", a-b}') s"
echo "== result: smoke $ok/$N pass, shutdown rc=$src, check-ipl-log rc=$crc"
