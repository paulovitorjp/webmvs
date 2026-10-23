#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Keep one s3270 session open to a Hercules 3270 port and record every new screen.
# Used by scripts/vsock-native-test.sh for the master console (LU syntax: 0010@127.0.0.1:3370
# makes s3270 send TTYPE "IBM-3278-2@0010", which console.c maps to device 0010).
# Usage: scripts/vsock-console-watch.sh <target> <screens-file> <stop-file> [max-seconds]
#   Writes "=== <time> screen <n>" + the screen text each time the screen changes.
#   Ends when <stop-file> exists or after max-seconds (default 1800). Exit 0 if connected.
# Env: CMD_FILE: if set, each line appended to it is typed into the session as Home()+String()+Enter
#      (Home = first input field = the MVS console entry area);
#      a line "@Action()" runs that s3270 action instead (e.g. @Clear(), @Enter()).
set -u
TARGET=$1 OUT=$2 STOP=$3 MAX=${4:-1800}
: > "$OUT"
coproc S3 { s3270 -model 3278-2 2>&1; }
IN=${S3[1]} OUTFD=${S3[0]}
s3() {
  REPLY_DATA=""; echo "$1" >&"$IN" || return 2
  local l
  while IFS= read -r -t 30 l <&"$OUTFD"; do
    case "$l" in ok) return 0;; error) return 1;; data:*) REPLY_DATA+="${l#data: }"$'\n';; esac
  done; return 2
}
s3 "Connect($TARGET)" || { echo "connect failed: $REPLY_DATA" >> "$OUT"; exit 1; }
echo "=== $(date +%T.%N | cut -c1-12) connected to $TARGET" >> "$OUT"
prev="" n=0 end=$(( $(date +%s) + MAX )) cmdline=0
while [ ! -e "$STOP" ] && [ "$(date +%s)" -lt "$end" ]; do
  s3 'Wait(2,Output)' >/dev/null 2>&1
  s3 'Ascii()' || { echo "=== $(date +%T) session lost" >> "$OUT"; break; }
  scr=$(printf '%s' "$REPLY_DATA" | sed 's/ *$//')
  if [ "$scr" != "$prev" ]; then
    n=$((n+1)); { echo "=== $(date +%T.%N | cut -c1-12) screen $n"; printf '%s\n' "$scr" | grep -v '^$'; } >> "$OUT"; prev=$scr
  fi
  if [ -n "${CMD_FILE:-}" ] && [ -f "$CMD_FILE" ]; then
    total=$(wc -l < "$CMD_FILE")
    while [ "$cmdline" -lt "$total" ]; do
      cmdline=$((cmdline+1)); c=$(sed -n "${cmdline}p" "$CMD_FILE")
      echo "=== $(date +%T) type: $c" >> "$OUT"
      case "$c" in @*) s3 "${c#@}";; *) s3 'Home()'; s3 "String(\"$c\")"; s3 'Enter()';; esac
    done
  fi
done
s3 'Disconnect()'; echo 'Quit()' >&"$IN"; wait "$S3_PID" 2>/dev/null
echo "=== $(date +%T) disconnected" >> "$OUT"
exit 0
