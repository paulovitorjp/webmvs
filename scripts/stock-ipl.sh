#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# boot the stock MVS/CE image headless with native Hyperion, inside tmux.
# Usage (on host): scripts/stock-ipl.sh start | status | wait [timeout-s] | cmd '<hercules cmd>' | shutdown [timeout-s] | stop
#   shutdown = clean MVS shutdown with the stock SCRIPTS/SHUTDOWN.RC (HAO chain: $PJES2, Z EOD, QUIESCE,
#              then poweroff = stopall/sysclear/quit), then waits for the process to exit.
#   stop     = Hercules "quit" without an MVS shutdown (use only if shutdown fails).
# Known issue: in NoUI mode with a tty on stdin, Hercules prints HHC01412I "terminated" after quit
# but the process does not exit until stdin returns a line (impl_thread is blocked in read() on stdin,
# quit_thread waits on a futex). We therefore send an extra Enter after HHC01412I.
# Hercules runs in NoUI mode (-n; -d is deprecated, HHC00022W). stdin is the tmux pane,
# so Hercules commands can be sent with "$TMX send-keys". stdout/stderr go to the log.
set -u
MVS=${MVS:-$HOME/webmvs/dasd/mvsce/MVSCE}
HERC=${HERC:-$HOME/herc-native/bin/hercules}
LOG=${LOG:-$HOME/webmvs/logs/stock-ipl.log}
CNF=${CNF:-conf/local.cnf}          # relative to $MVS or absolute (web: ~/webmvs/conf/web.cnf)
RC=${RC:-conf/mvsce.rc}
SHUTRC=${SHUTRC:-SCRIPTS/SHUTDOWN.RC}  # relative to $MVS or absolute
T0F=${LOG%.log}.t0
# $LOG.ts = same log with a host epoch timestamp (ms) in front of each line (for IPL timings)
SES=${SES:-mvsce}
# Own tmux server socket, so that other tmux users on the host (kill-server) cannot end our session.
TMX="tmux -L ${TMUX_SOCK:-mvsm0}"
# Match only *our* Hercules (other users may run their own Hercules on the same host):
PAT="bin/hercules -n -f $CNF -r"
TSLOG=$(dirname "$(readlink -f "$0")")/tslog.pl
case "${1:-status}" in
start)
  pgrep -f -- "$PAT" >/dev/null && { echo "hercules already running: $(pgrep -af -- "$PAT")"; exit 1; }
  mkdir -p "$(dirname "$LOG")"
  if [ -f "$LOG" ]; then sfx=$(date +%s); mv "$LOG" "$LOG.$sfx.old"; [ -f "$LOG.ts" ] && mv "$LOG.ts" "$LOG.ts.$sfx.old"; fi
  date +%s.%N > "$T0F"
  # Trace build (patches/0000-trace-trk.patch): pass HERC_TRK_TRACE in the command line, because a
  # tmux server that already runs would not see our environment.
  ENVP=""; [ -n "${HERC_TRK_TRACE:-}" ] && ENVP="HERC_TRK_TRACE='$HERC_TRK_TRACE' "
  $TMX new-session -d -s $SES -c "$MVS" \
    "cd '$MVS' && { $ENVP'$HERC' -n -f '$CNF' -r '$RC' 2>&1; echo hercules rc=\$?; } | '$TSLOG' '$LOG' > '$LOG.ts'; sleep 600"
  sleep 2; pgrep -af -- "$PAT" || { echo "hercules did not start"; tail -20 "$LOG"; exit 1; }
  ;;
status)
  pgrep -af -- "$PAT" || echo "hercules not running"
  $TMX ls 2>&1
  [ -f "$LOG" ] && tail -n "${2:-20}" "$LOG"
  ;;
wait)   # wait for TSO ready (IKT007I); print elapsed seconds from start for key messages
  TO=${2:-900}; end=$(( $(date +%s) + TO ))
  while ! grep -q 'IKT007I' "$LOG" 2>/dev/null; do
    [ "$(date +%s)" -ge "$end" ] && { echo "TIMEOUT waiting for IKT007I"; tail -30 "$LOG"; exit 1; }
    pgrep -f -- "$PAT" >/dev/null || { echo "hercules exited"; tail -30 "$LOG"; exit 1; }
    sleep 1
  done
  echo "IKT007I seen at +$(awk -v a="$(date +%s.%N)" -v b="$(cat "$T0F")" 'BEGIN{printf "%.1f", a-b}') s (poll resolution 1 s)"
  ;;
cmd)
  $TMX send-keys -t $SES -l "$2"; $TMX send-keys -t $SES Enter
  ;;
shutdown)
  TO=${2:-300}; n=$(wc -l < "$LOG")
  $TMX send-keys -t $SES -l "script $SHUTRC"; $TMX send-keys -t $SES Enter
  t0=$(date +%s)
  for i in $(seq 1 "$TO"); do tail -n +"$n" "$LOG" | grep -q HHC01412I && break; sleep 1; done
  echo "HHC01412I after $(( $(date +%s) - t0 )) s"
  for i in $(seq 1 30); do sleep 2; pgrep -f -- "$PAT" >/dev/null || break; $TMX send-keys -t $SES Enter; done  # unblock stdin read
  pgrep -af -- "$PAT" && { echo "still running"; exit 1; }
  tail -n +"$n" "$LOG" | grep -E "IEE334I|disabled wait|HHC01412I|hercules rc="
  $TMX kill-session -t $SES 2>/dev/null; echo "hercules stopped"
  ;;
stop)   # force stop hercules (use only after MVS shutdown or if it hangs)
  $TMX send-keys -t $SES -l "quit"; $TMX send-keys -t $SES Enter
  # unblock the stdin read (see known issue above): send Enter every 2 s until the process is gone
  for i in $(seq 1 30); do sleep 2; pgrep -f -- "$PAT" >/dev/null || break; $TMX send-keys -t $SES Enter; done
  pgrep -af -- "$PAT" && { echo "still running"; exit 1; }
  $TMX kill-session -t $SES 2>/dev/null; echo "hercules stopped"
  ;;
esac
