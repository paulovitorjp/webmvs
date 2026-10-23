#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# dev environment for the visitor page (web/app) against NATIVE Hercules.
# Runs on the build host. Everything binds to 127.0.0.1. Own tmux socket (-L ui), own run dir,
# own ports (8211-8219), own processes only (matched by full command line / PID files).
#   prepare       private run dir ~/webmvs/dasd/web-ui (7 volumes, pristine), private cnf/rc in web/app/run/
#   reset         delete the shadow files (next boot = first visit)
#   herc-start    start native Hercules (conf: CNSLPORT 127.0.0.1:8212; rc WITHOUT IPL, the page starts the IPL)
#   herc-ipl      'ipl 150' (normally the page does this through the dev server)
#   cmd '<c>'     one Hercules command
#   wait          wait for IKT007I in the Hercules log
#   herc-shutdown MVS shutdown through the master console script (conf/web-ui-shutdown.rc) and quit
#   herc-stop     Hercules quit (no MVS shutdown)
#   up            websockify 127.0.0.1:8213 -> 8212, dev server (web/app/devserver.py) 127.0.0.1:8211 (no COOP/COEP,
#                 like GitHub Pages: coi-serviceworker) and 127.0.0.1:8214 (COOP/COEP headers, like Cloudflare _headers)
#   down          stop websockify and the dev servers
#   status
set -u
H=$HOME/webmvs; APP=$H/web/app; RUN=$APP/run; L=$H/logs/ui; mkdir -p "$L" "$RUN"
export WEB=$H/dasd/web-ui
export CNF=$RUN/web-ui.cnf RC=${RC:-$RUN/web-ui.rc} SHUTRC=${SHUTRC:-$H/conf/web-ui-shutdown.rc}
export LOG=${LOG:-$L/herc.log} TMUX_SOCK=ui SES=herc
case "${1:-status}" in
prepare)
  EXTRA_VOLS=syscpk.3350 "$H/scripts/web-ipl.sh" prepare > "$L/prepare.log" 2>&1 || { tail "$L/prepare.log"; exit 1; }
  sed -e 's/^CNSLPORT .*/CNSLPORT  127.0.0.1:8212/' "$H/conf/web.cnf" > "$CNF"
  # rc without IPL: the page connects the 0010 master console first, then asks for the IPL.
  grep -v '^IPL ' "$H/conf/web.rc" > "$RUN/web-ui.rc"
  grep -n 'CNSLPORT\|^0010\|^0400' "$CNF"; cat "$RUN/web-ui.rc"; tail -3 "$L/prepare.log"
  ;;
reset) rm -f "$WEB"/shadow/*.cckd; echo "shadows removed";;
herc-start) "$H/scripts/web-ipl.sh" start;;
herc-ipl) "$H/scripts/web-ipl.sh" cmd 'ipl 150';;
cmd) "$H/scripts/web-ipl.sh" cmd "$2";;
wait) "$H/scripts/web-ipl.sh" wait "${2:-300}";;
herc-shutdown) "$H/scripts/web-ipl.sh" shutdown "${2:-300}";;
herc-stop) "$H/scripts/web-ipl.sh" stop;;
up)
  for p in 8211 8213 8214; do ss -ltnH "sport = :$p" | grep -q . && { echo "port $p busy"; ss -ltnp "sport = :$p"; exit 1; }; done
  setsid nohup websockify 127.0.0.1:8213 127.0.0.1:8212 > "$L/websockify.log" 2>&1 < /dev/null &
  echo $! > "$L/websockify.pid"
  setsid nohup python3 "$APP/devserver.py" --port 8211 --root "$APP/dist" --log "$LOG" --tmux ui --session herc \
    > "$L/devserver-8211.log" 2>&1 < /dev/null &
  echo $! > "$L/devserver-8211.pid"
  setsid nohup python3 "$APP/devserver.py" --port 8214 --coi-headers --root "$APP/dist" --log "$LOG" --tmux ui --session herc \
    > "$L/devserver-8214.log" 2>&1 < /dev/null &
  echo $! > "$L/devserver-8214.pid"
  sleep 1.5; ss -ltnp | grep -E ':(8211|8213|8214) '
  ;;
down)
  for n in websockify devserver-8211 devserver-8214; do f=$L/$n.pid; [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done
  sleep 1; ss -ltn | grep -E ':(8211|8213|8214) ' || echo "8211/8213/8214 closed"
  ;;
status)
  "$H/scripts/web-ipl.sh" status 5
  ss -ltnp | grep -E ':821[0-9] ' || echo "no 821x listener"
  ;;
*) echo "usage: $0 prepare|reset|herc-start|herc-ipl|cmd|wait|herc-shutdown|herc-stop|up|down|status"; exit 2;;
esac
