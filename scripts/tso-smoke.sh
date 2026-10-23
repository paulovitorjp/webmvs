#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# TSO smoke test with s3270 (runs on the build host).
# Connects to the Hercules 3270 port, logs on as MVSCE02, handles the logon
# screens until READY (or ISPF, which it leaves with =X), runs TIME, checks the
# IKJ56650I output, logs off and checks the IKJ56470I logoff message.
# Usage: scripts/tso-smoke.sh [host:port]   (default localhost:3270 = CNSLPORT in conf/local.cnf)
# Env:   TSO_USER (MVSCE02), TSO_PASS (PASS4U), SMOKE_LOG (transcript file), STEP_TO (s, default 60)
# Exit:  0 = pass, 1 = fail. The transcript holds every screen that was read.
set -u
TARGET=${1:-localhost:3270}
USER_ID=${TSO_USER:-MVSCE02}
PASS=${TSO_PASS:-PASS4U}
STEP_TO=${STEP_TO:-60}
LOGDIR=$HOME/webmvs/logs; mkdir -p "$LOGDIR"
SMOKE_LOG=${SMOKE_LOG:-$LOGDIR/tso-smoke-$(date +%Y%m%d-%H%M%S).log}
: > "$SMOKE_LOG"
T0=$(date +%s.%N)
SCREEN=""

log()  { printf '%s [+%6.2fs] %s\n' "$(date +%T)" "$(awk -v a="$(date +%s.%N)" -v b="$T0" 'BEGIN{print a-b}')" "$*" | tee -a "$SMOKE_LOG"; }
LOGGED_ON=0
fail() {
  log "FAIL: $*"; log "last screen:"; printf '%s\n' "$SCREEN" | sed 's/^/    | /' | tee -a "$SMOKE_LOG"
  # A dropped session stays "WAITING FOR RECONNECT" (IKT108I) and blocks the next logon
  # (IKJ56425I IN USE), so try to log off before we disconnect.
  if [ "$LOGGED_ON" = 1 ]; then
    log "cleanup: try logoff"; s3 'Clear()' >/dev/null 2>&1; s3 'String("logoff")' >/dev/null 2>&1; s3 'Enter()' >/dev/null 2>&1; sleep 2
  fi
  s3 'Disconnect()' >/dev/null 2>&1; s3_quit; exit 1; }

coproc S3 { s3270 -model 3278-2 2>&1; }
S3_IN=${S3[1]}; S3_OUT=${S3[0]}; S3_PID=$S3_PID

# s3 ACTION: send one s3270 action; sets REPLY_DATA (data lines) and returns 0 on "ok".
s3() {
  REPLY_DATA=""
  echo "$1" >&"$S3_IN" || return 2
  local l
  while IFS= read -r -t 30 l <&"$S3_OUT"; do
    case "$l" in
      ok) return 0 ;;
      error) return 1 ;;
      data:*) REPLY_DATA+="${l#data: }"$'\n' ;;
    esac
  done
  return 2
}
s3_quit() { echo 'Quit()' >&"$S3_IN" 2>/dev/null; wait "$S3_PID" 2>/dev/null; }

grab() { s3 'Ascii()'; SCREEN=$(printf '%s' "$REPLY_DATA" | sed 's/ *$//'); }
dump() { log "screen ($1):"; printf '%s\n' "$SCREEN" | grep -v '^$' | sed 's/^/    | /' | tee -a "$SMOKE_LOG" >/dev/null; }

# waitfor REGEX [timeout]: poll the screen until it matches (extended regex, case-sensitive).
waitfor() {
  local re=$1 to=${2:-$STEP_TO} end=$(( $(date +%s) + ${2:-$STEP_TO} ))
  while :; do
    s3 'Wait(1,Output)' >/dev/null 2>&1
    grab
    printf '%s' "$SCREEN" | grep -Eq -- "$re" && return 0
    [ "$(date +%s)" -ge "$end" ] && return 1
  done
}
type_enter() { s3 "String(\"$1\")" || fail "String($2) rejected: $REPLY_DATA"; s3 'Enter()' || fail "Enter rejected"; s3 'Wait(10,Unlock)' >/dev/null; }

log "connect at epoch $(date +%s.%N)"
log "tso-smoke: target=$TARGET user=$USER_ID model=IBM-3278-2 transcript=$SMOKE_LOG"
s3 "Connect($TARGET)" || fail "connect to $TARGET failed: $REPLY_DATA"
# First screen: the Hercules 3270 logo (MVS/CE herclogo.txt: "CLEAR the screen or hit ENTER";
# the built-in Hercules logo if no herclogo.txt is found: "Hercules Version"/"Device number").
# VTAM writes the "TSO Logon ===>" USS screen only after the terminal sends CLEAR/ENTER.
waitfor 'CLEAR the screen|TSO Logon|LOGON|Logon|Hercules Version|Device number' 30 || fail "no logo/logon screen"
dump "after connect"
if ! printf '%s' "$SCREEN" | grep -q 'TSO Logon ===>'; then
  s3 'Clear()'; s3 'Wait(5,Unlock)' >/dev/null
  waitfor 'TSO Logon ===>' 20 || fail "no 'TSO Logon ===>' prompt after CLEAR"
fi
dump "logon prompt"
log "send: logon $USER_ID"
type_enter "logon $USER_ID" "logon"

# Logon dialogue: password prompt, broadcast messages ('***'), ISPF, READY.
pw_sent=0; ispf_seen=0; ready=0
for i in $(seq 1 90); do
  waitfor 'ENTER CURRENT PASSWORD|READY *$|\*\*\* *$|IKJ56[0-9]{3}[AI]|OPTION *===>|COMMAND *===>|Option *===>' || fail "logon dialogue stalled"
  if printf '%s' "$SCREEN" | grep -Eq 'IN USE|REJECTED|NOT AUTHORIZED|INVALID|IKJ56701I|IKJ56425I|IKJ56421I'; then
    dump "logon error"; fail "logon rejected"
  elif [ $pw_sent = 0 ] && printf '%s' "$SCREEN" | grep -q 'ENTER CURRENT PASSWORD'; then
    log "password prompt seen; send password (not logged)"
    s3 "String(\"$PASS\")" || fail "password String rejected"; s3 'Enter()'; s3 'Wait(10,Unlock)' >/dev/null
    pw_sent=1; LOGGED_ON=1
  elif printf '%s' "$SCREEN" | grep -Eq 'OPTION *===>|Option *===>|COMMAND *===>'; then
    dump "ISPF/menu panel"; ispf_seen=1
    log "ISPF/menu seen; send =X to leave it"
    s3 'Home()'; type_enter "=X" "=X"
  elif printf '%s' "$SCREEN" | grep -Eq 'READY *$'; then
    ready=1; break
  elif printf '%s' "$SCREEN" | grep -Eq '\*\*\* *$'; then
    dump "logon messages ('***')"; log "send Enter for ***"
    s3 'Enter()'; s3 'Wait(10,Unlock)' >/dev/null
  else
    sleep 1
  fi
done
[ $ready = 1 ] || fail "READY not reached"
log "READY seen at epoch $(date +%s.%N)"   # used for the IPL-to-READY timing 
dump "READY"
log "logon OK (password sent=$pw_sent, ispf seen=$ispf_seen)"

# TIME command. Clear first, so the screen shows only new output.
s3 'Clear()'; s3 'Wait(5,Unlock)' >/dev/null
log "send: time"
type_enter "time" "time"
# MVS/CE has message IDs off for TSO, so the IKJ56650I prefix is optional.
waitfor '(IKJ56650I )?TIME-[0-9]{2}:[0-9]{2}:[0-9]{2}' 30 || fail "TIME output (IKJ56650I) not seen"
waitfor 'READY *$' 15 || fail "no READY after TIME"
dump "TIME output"
TIMELINE=$(printf '%s\n' "$SCREEN" | grep -E 'TIME-[0-9]{2}:' | head -1 | sed 's/^ *//')
log "TIME output: $TIMELINE"
# Sanity check: the guest clock must be a real time of day and a plausible date (YEAR 19xx/20xx).
printf '%s' "$TIMELINE" | grep -Eq '^(IKJ56650I )?TIME-[0-2][0-9]:[0-5][0-9]:[0-5][0-9] [AP]M\. CPU-[0-9:.]+ SERVICE-[0-9]+ SESSION-[0-9:.]+ +[A-Z]+ [0-9]{1,2},[0-9]{4}' \
  || fail "TIME line format differs from the expected IKJ56650I layout"

# Logoff.
s3 'Clear()'; s3 'Wait(5,Unlock)' >/dev/null
log "send: logoff"
type_enter "logoff" "logoff"
waitfor "(IKJ56470I )?$USER_ID LOGGED OFF|TSO Logon|CLEAR the screen" 30 || fail "no logoff confirmation"
dump "after logoff"; LOGGED_ON=0
printf '%s' "$SCREEN" | grep -Eq "(IKJ56470I )?$USER_ID LOGGED OFF" && log "logoff message (IKJ56470I) seen" || log "logon screen returned (IKJ56470I not on this screen)"
s3 'Disconnect()'; s3_quit
log "PASS"
exit 0
