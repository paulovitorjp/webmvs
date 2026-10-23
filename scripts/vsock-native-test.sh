#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# native test of the wasmsock shim with the MVS/CE web config.
# Hercules ~/herc-vsock (patch 0008 + libwasmsock.so incl. TCP bridge on 127.0.0.1:3370) runs from a
# private run dir ~/webmvs/dasd/web-vsock (7 volumes, fresh shadows) with a private copy of web.cnf
# whose CNSLPORT is 127.0.0.1:3371: console.c "listens" on that port only inside the shim, so no
# real socket must appear on 3371. The only real port is the bridge's 3370.
# Own tmux socket (-L vsock), own session, own log; processes matched by the private config path.
# Usage (on host): scripts/vsock-native-test.sh prepare|start|console|ipl|wait|smoke [n]|consolecmd '<cmd>'|
#                                             stopconsole|shutdown|check|status|auto
#   auto = unattended cycle: fresh shadows, web.rc (IPL + HAO on 009), wait IKT007I, connect the 0010
#          master-console client, "V 010,CONSOLE" from 009, tso-smoke 3x while 0010 stays connected,
#          disconnect 0010, clean shutdown, check-ipl-log.
#   Manual flow (start with web-noipl.rc, console, ipl): with 0010 connected before IPL, MVS sends
#          IEA101A to 0010 (not 009), so HAO does not answer it; reply with "consolecmd ''", and do
#          "consolecmd 'v 009,mstcons'" before "shutdown" (web-shutdown.rc needs 009 as master).
set -u
H=$HOME/webmvs; S=$H/scripts; cd "$H"
export WEB=$H/dasd/web-vsock
export HERC=$HOME/herc-vsock/bin/hercules TMUX_SOCK=vsock SES=vsock
export CNF=$WEB/web-vsock.cnf RC=${VRC:-$WEB/web-noipl.rc} LOG=${VLOG:-$H/logs/vsock-ipl.log}
export SHUTRC=$H/conf/web-shutdown.rc
export WASMSOCK_DEBUG=1 VSOCK_BRIDGE_PORT=3370
L=$H/logs/vsock; mkdir -p "$L"
PORT=127.0.0.1:3370
CON_TARGET=0010@$PORT
case "${1:-status}" in
prepare)
  [ -f "$WEB/DASD/syscpk.3350" ] || EXTRA_VOLS=syscpk.3350 $S/web-ipl.sh prepare > "$L/prepare.log" 2>&1 || { tail "$L/prepare.log"; exit 1; }
  $S/web-ipl.sh reset-shadows
  sed -e 's|^CNSLPORT .*|CNSLPORT  127.0.0.1:3371   # vsock test: in-shim only; the bridge serves 127.0.0.1:3370|' "$H/conf/web.cnf" > "$CNF"
  grep -v '^IPL ' "$H/conf/web.rc" > "$WEB/web-noipl.rc"   # manual flow: IPL after the 0010 client connected
  cp "$H/conf/web.rc" "$WEB/web-ipl.rc"                       # auto flow: unchanged web.rc (IPL + HAO)
  grep -n CNSLPORT "$CNF"; echo "rc:"; cat "$RC"; ls -l "$WEB/DASD"
  ;;
start)
  tmux -L vsock kill-server 2>/dev/null   # own socket only: fresh env for WASMSOCK_DEBUG
  $S/web-ipl.sh start || exit 1
  for i in $(seq 1 30); do grep -q 'vsock bridge: listening' "$LOG" && break; sleep 1; done
  grep -E 'wasmsock|vsock bridge|HHC01024I' "$LOG"
  echo "== real listening sockets of our hercules (expect 127.0.0.1:3370 only, no 3371):"
  P=$(pgrep -f -- "bin/hercules -n -f $CNF -r"); echo "pid $P"
  ss -ltnp | grep "pid=$P," || echo "(none)"
  ss -ltn | grep -q ':3371 ' && echo "UNEXPECTED: something listens on 3371" || echo "port 3371: not listening (OK)"
  ;;
console)
  rm -f "$L/console.stop"; : > "$L/console.cmds"
  CMD_FILE=$L/console.cmds nohup "$S/vsock-console-watch.sh" "$CON_TARGET" "$L/console-screens.txt" "$L/console.stop" 3600 > "$L/console-watch.out" 2>&1 &
  echo "console watcher pid $!"; sleep 4; head -40 "$L/console-screens.txt"
  grep -E '0010|ttype' "$LOG" | tail -5
  ;;
consolecmd) echo "$2" >> "$L/console.cmds"; sleep 5; tail -30 "$L/console-screens.txt" ;;
ipl)   $S/web-ipl.sh cmd "ipl 150"; sleep 2; tail -5 "$LOG" ;;
wait)  $S/web-ipl.sh wait 300 ;;
smoke)
  N=${2:-3}; ok=0
  for i in $(seq 1 "$N"); do
    SMOKE_LOG=$L/smoke$i.log timeout 150 $S/tso-smoke.sh $PORT > "$L/smoke$i.out" 2>&1; rc=$?
    echo "smoke $i rc=$rc $(grep -o 'TIME output: .*' "$L/smoke$i.out") $(grep -E 'PASS|FAIL' "$L/smoke$i.out" | tail -1 | cut -c1-90)"
    [ $rc = 0 ] && ok=$((ok+1))
  done
  echo "smoke: $ok/$N pass"
  ;;
stopconsole) touch "$L/console.stop"; sleep 4; tail -3 "$L/console-screens.txt" ;;
shutdown) $S/web-ipl.sh shutdown 300 ;;
check)
  $S/check-ipl-log.sh "$LOG" | grep -v '^allowed'; echo "check-ipl-log rc=${PIPESTATUS[0]}"
  echo "== HHC warnings/errors:"; grep -E 'HHC[0-9]{5}[WES]' "$LOG" | sort | uniq -c | sort -rn | head -20
  ;;
status) $S/web-ipl.sh status 15 ;;
stop)   $S/web-ipl.sh stop ;;
auto)
  export VRC=$WEB/web-ipl.rc VLOG=$H/logs/vsock-auto.log
  "$0" prepare > "$L/auto-prepare.log" 2>&1 || exit 1
  "$0" start || exit 1
  timeout 320 "$0" wait || { "$0" stop; exit 1; }
  "$0" console > /dev/null
  $S/web-ipl.sh cmd "/v 010,console"; sleep 5   # MVS formats the 0010 screen itself (no Clear: it would erase the entry area)
  "$0" consolecmd "k s,del=r,rnum=19,rtme=1" > /dev/null
  "$0" smoke 3
  "$0" consolecmd "d t" > /dev/null; sleep 20
  "$0" stopconsole > /dev/null
  echo "== 0010 console: $(grep -c '=== .* screen' "$L/console-screens.txt") screens; messages seen:"
  grep -E 'IEF12[56]I|IEE136I|IEE163I|IEE164I|IEE143I|HASP373 MVSCE02' "$L/console-screens.txt" | sed 's/^ *//' | sort | uniq -c
  timeout 400 "$0" shutdown | tail -4
  "$0" check
  ;;
esac
