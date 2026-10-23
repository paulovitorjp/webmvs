#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Boot MVS/CE with the wasm Hercules under Node (-sNODERAWFS), headless.
# Usage (on host): scripts/wasm-ipl.sh prepare | start | wait [timeout-s] | cmd '<hercules cmd>' | status | shutdown | stop | times
#   prepare  run dir $WEB (default ~/webmvs/dasd/web-wasmcore): web-ipl.sh prepare (7 volumes incl. SYSCPK)
#            and empty shadow files (reset-shadows), so each start is a "first visit".
#   start    node hercules.js -f $CNF -r $RC --cmdfile=$WEB/cmd.txt in tmux (-L $TMUX_L), log via tslog.pl
#   cmd      append one Hercules command line to the cmdfile (wasm_main.c polls it every 100 ms)
#   shutdown clean MVS shutdown: "script conf/web-shutdown.rc" via the cmdfile, wait for node to exit
#   stop     "quit force" via the cmdfile; after 30 s kill only our node PID
#   times    IPL 150 -> IKT007I (and other key messages) from the .ts log
# Env: WEB, CNF (default conf/web.cnf), RC (conf/web.rc), JS (~/build/wasm/out/hercules.js), LOG, NODE, NODEOPT,
#      TMUX_L (tmux socket and session name, default wasm), HARNESS, HARNESS_PORT.
set -u
H=$HOME/webmvs
export WEB=${WEB:-$H/dasd/web-wasmcore}
CNF=${CNF:-$H/conf/web.cnf}   # CNSLPORT is only a label in wasm (no real listener)
RC=${RC:-$H/conf/web.rc}
JS=${JS:-$HOME/build/wasm/out/hercules.js}
LOG=${LOG:-$H/logs/wasm-core-ipl.log}
NODEOPT=${NODEOPT:-}
NODE=${NODE:-node}   # e.g. ~/emsdk/node/24.19.0_64bit/bin/node (much faster wasm EH longjmp than the host Node 18)
# HARNESS=1 (default): run through scripts/node-harness.mjs (default WASMSOCK=1 build); the 3270 port is
# then real TCP on 127.0.0.1:$HARNESS_PORT (default 3270), e.g. for tso-smoke.sh and s3270 0010@...
# HARNESS=0: plain node (no 3270 port; needed for the WASMSOCK=0 stub build, JS=~/build/wasm/out-nosock/hercules.js).
HARNESS=${HARNESS:-1}
export HARNESS_PORT=${HARNESS_PORT:-3270}
if [ "$HARNESS" = 1 ]; then RUNJS="'$H/scripts/node-harness.mjs' '$JS'"; else RUNJS="'$JS'"; fi
TMUX_L=${TMUX_L:-wasm}
TMX="tmux -L $TMUX_L"
SES=$TMUX_L
PIDF=$WEB/node.pid
TSLOG=$H/scripts/tslog.pl
case "${1:-status}" in
prepare)
  EXTRA_VOLS=syscpk.3350 "$H/scripts/web-ipl.sh" prepare >/dev/null || exit 1
  EXTRA_VOLS=syscpk.3350 "$H/scripts/web-ipl.sh" reset-shadows
  : > "$WEB/cmd.txt"; ls "$WEB" "$WEB/DASD"
  ;;
start)
  [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null && { echo "already running: pid $(cat "$PIDF")"; exit 1; }
  rm -f "$WEB"/shadow/*.cckd; : > "$WEB/cmd.txt"
  if [ -f "$LOG" ]; then sfx=$(date +%s); mv "$LOG" "$LOG.$sfx.old"; [ -f "$LOG.ts" ] && mv "$LOG.ts" "$LOG.ts.$sfx.old"; fi
  date +%s.%N > "${LOG%.log}.t0"
  $TMX kill-session -t $SES 2>/dev/null
  $TMX new-session -d -s $SES -c "$WEB" \
    "cd '$WEB' && { HARNESS_PORT=$HARNESS_PORT '$NODE' $NODEOPT $RUNJS -f '$CNF' -r '$RC' --cmdfile='$WEB/cmd.txt' 2>&1 & echo \$! > '$PIDF'; wait \$!; echo node rc=\$?; } | '$TSLOG' '$LOG' > '$LOG.ts'; sleep 3600"
  sleep 3; echo "node pid $(cat "$PIDF" 2>/dev/null)"; tail -5 "$LOG"
  ;;
wait)
  TO=${2:-600}; end=$(( $(date +%s) + TO ))
  while ! grep -q 'IKT007I' "$LOG" 2>/dev/null; do
    [ "$(date +%s)" -ge "$end" ] && { echo "TIMEOUT waiting for IKT007I"; tail -30 "$LOG"; exit 1; }
    kill -0 "$(cat "$PIDF")" 2>/dev/null || { echo "node exited"; tail -30 "$LOG"; exit 1; }
    sleep 1
  done
  echo "IKT007I seen"; "$0" times
  ;;
times)
  awk '/IPL 150|ipl 150|HHC00811I|IEA101A|\$HASP426|IEE136I|HASP373|IKT007I|HHC01603I ipl/ {print}' "$LOG.ts" | head -20
  awk 'BEGIN{t0="";t1=""} /HHC01603I ipl 150|HHC01603I IPL 150/ && t0=="" {t0=$1} /IKT007I/ && t1=="" {t1=$1} END{ if (t0!="" && t1!="") printf "IPL 150 -> IKT007I: %.3f s\n", t1-t0; else print "no IPL/IKT007I pair" }' "$LOG.ts"
  ;;
cmd)
  printf '%s\n' "$2" >> "$WEB/cmd.txt"
  ;;
status)
  [ -f "$PIDF" ] && ps -o pid,etime,pcpu,rss,args -p "$(cat "$PIDF")" 2>/dev/null
  tail -n "${2:-20}" "$LOG"
  ;;
shutdown)   # clean MVS shutdown with conf/web-shutdown.rc (HAO chain ends with poweroff -> quit)
  TO=${2:-300}; t0=$(date +%s)
  printf 'script %s\n' "${SHUTRC:-$H/conf/web-shutdown.rc}" >> "$WEB/cmd.txt"
  while kill -0 "$(cat "$PIDF")" 2>/dev/null; do
    [ $(( $(date +%s) - t0 )) -ge "$TO" ] && { echo "TIMEOUT: still running after $TO s"; exit 1; }
    sleep 1
  done
  echo "node ended $(( $(date +%s) - t0 )) s after the shutdown script"
  grep -E "IEE334I|disabled wait|HHC01412I|node rc=" "$LOG" | tail -5
  $TMX kill-session -t $SES 2>/dev/null
  ;;
stop)
  printf 'quit force\n' >> "$WEB/cmd.txt"
  for i in $(seq 1 30); do sleep 1; kill -0 "$(cat "$PIDF")" 2>/dev/null || break; done
  if kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "quit did not end node; kill $(cat "$PIDF")"; kill "$(cat "$PIDF")"; sleep 2; fi
  tail -5 "$LOG"; $TMX kill-session -t $SES 2>/dev/null; echo stopped
  ;;
esac
