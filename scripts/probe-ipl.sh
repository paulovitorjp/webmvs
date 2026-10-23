#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Helper (runs on the build host): a PRIVATE stock MVS/CE boot for the terminal probe,
# used only when no other hercules is listening. It runs from a COPY of the image
# (~/webmvs/probe-mvsce/MVSCE) so it never writes to the DASD another build uses, with
#   CNSLPORT 127.0.0.1:3271 (loopback only; not 3270), sockdev readers on 3605/3606 (not 3505/3506),
#   no INCLUDE conf/local/custom.cnf (no TCPNJE listener on 1175),
# in tmux session "probe". Processes are found by this copy's path only, never by a generic
# pattern, so another Hercules is never touched.
# Usage: scripts/probe-ipl.sh start | wait [timeout-s] | shutdown [timeout-s] | status
set -u
SRC=$HOME/webmvs/dasd/mvsce/MVSCE
DIR=$HOME/webmvs/probe-mvsce/MVSCE
HERC=$HOME/herc-native/bin/hercules
LOG=$HOME/webmvs/logs/probe-ipl.log
SES=probe
mypid() { pgrep -f "^$HERC -n -f $DIR/conf/probe.cnf"; }
case "${1:-status}" in
start)
  mypid >/dev/null && { echo "probe hercules already running: $(mypid)"; exit 1; }
  ss -ltn | grep -qE ':(3271|3605|3606) ' && { echo "port 3271/3605/3606 busy"; ss -ltnp | grep -E ':(3271|3605|3606) '; exit 1; }
  if [ ! -d "$DIR" ]; then mkdir -p "$(dirname "$DIR")" && cp -a "$SRC" "$DIR"; fi
  sed -e 's/^CNSLPORT .*/CNSLPORT  127.0.0.1:3271/' -e 's/localhost:3505/localhost:3605/' -e 's/localhost:3506/localhost:3606/' \
      -e 's|^INCLUDE conf/local/custom.cnf|# (probe) INCLUDE conf/local/custom.cnf|' "$DIR/conf/local.cnf" > "$DIR/conf/probe.cnf"
  diff "$DIR/conf/local.cnf" "$DIR/conf/probe.cnf"
  [ -f "$LOG" ] && mv "$LOG" "$LOG.$(date +%s).old"
  tmux new-session -d -s $SES -c "$DIR" "'$HERC' -n -f '$DIR/conf/probe.cnf' -r conf/mvsce.rc > '$LOG' 2>&1; echo hercules rc=\$? >> '$LOG'; sleep 300"
  sleep 2; mypid || { echo "did not start"; tail -20 "$LOG"; exit 1; }
  ;;
wait)
  end=$(( $(date +%s) + ${2:-300} ))
  until grep -q IKT007I "$LOG" 2>/dev/null; do
    [ "$(date +%s)" -ge "$end" ] && { echo TIMEOUT; tail -20 "$LOG"; exit 1; }
    mypid >/dev/null || { echo "exited"; tail -20 "$LOG"; exit 1; }
    sleep 1
  done
  grep -E "HHC01603I|IKT007I" "$LOG"; ss -ltnp | grep ':3271 '
  ;;
shutdown)
  n=$(wc -l < "$LOG")
  tmux send-keys -t $SES -l "script SCRIPTS/SHUTDOWN.RC"; tmux send-keys -t $SES Enter
  for i in $(seq 1 "${2:-180}"); do tail -n +"$n" "$LOG" | grep -q HHC01412I && break; sleep 1; done
  # Hercules waits on stdin after quit (see stock-ipl.sh). One Enter right after HHC01412I was
  # not always enough , so send one every 3 s for up to 30 s.
  for i in $(seq 1 10); do tmux send-keys -t $SES Enter; sleep 3; mypid >/dev/null || break; done
  if mypid >/dev/null; then echo "still running: $(mypid)"; exit 1; fi
  tail -n +"$n" "$LOG" | grep -E "IEE334I|HHC01412I|hercules rc="
  tmux kill-session -t $SES 2>/dev/null; echo "probe hercules stopped"
  ;;
status)
  mypid || echo "probe hercules not running"; [ -f "$LOG" ] && tail -5 "$LOG"
  ;;
esac
