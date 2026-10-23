#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# run the visitor-page e2e (web/app/e2e.mjs) against a fresh native Hercules, once per browser.
# Usage (host): scripts/ui-e2e.sh [browsers (default "chromium firefox")] ; env PORT (8211 = no headers + coi-serviceworker,
#               8214 = COOP/COEP headers), OUT (screenshots + json, default ~/webmvs/logs/ui/e2e), TAGSFX
# Needs: scripts/ui-dev.sh prepare + up, and web/app built (node build.mjs).
set -u
H=$HOME/webmvs; L=$H/logs/ui; OUT=${OUT:-$L/e2e}; mkdir -p "$OUT"
PORT=${PORT:-8211}; URL="http://127.0.0.1:$PORT/${QUERY:-?backend=native}"   # the page default is wasm
export PATH=$HOME/emsdk/node/24.19.0_64bit/bin:$PATH
PAT="bin/hercules -n -f $H/web/app/run/web-ui.cnf -r"
rc_all=0
for b in ${1:-chromium firefox}; do
  tag=$b${TAGSFX:-}
  echo "=================== $tag ($URL)"
  if pgrep -f -- "$PAT" > /dev/null; then "$H/scripts/ui-dev.sh" herc-stop; fi
  tmux -L ui kill-session -t herc 2>/dev/null   # our session (it sleeps 600 s after hercules exits)
  "$H/scripts/ui-dev.sh" reset > /dev/null
  LOG=$L/herc-$tag.log "$H/scripts/ui-dev.sh" herc-start > /dev/null || { echo "herc-start failed"; rc_all=1; continue; }
  # the dev server reads the log named in its --log; point the default name at this run's log
  ln -sf "herc-$tag.log" "$L/herc.log"
  sleep 2
  ( cd "$H/web/app" && timeout 900 node e2e.mjs "$b" "$URL" "$OUT" "$tag" ) > "$OUT/e2e-$tag.out" 2>&1
  rc=$?; echo "e2e rc=$rc"; grep -E '^\[|E2E' "$OUT/e2e-$tag.out"
  for i in $(seq 1 30); do pgrep -f -- "$PAT" > /dev/null || break; sleep 2; done
  if pgrep -f -- "$PAT" > /dev/null; then echo "hercules still running after the test: herc-stop"; "$H/scripts/ui-dev.sh" herc-stop; rc=1; else echo "hercules exited by itself"; fi
  tmux -L ui kill-session -t herc 2>/dev/null
  grep -E 'hercules rc=|HHC01412I' "$L/herc-$tag.log" | tail -2
  echo "HHC W/E/S: $(grep -oE 'HHC[0-9]{5}[WES]' "$L/herc-$tag.log" | sort | uniq -c | tr '\n' ' ')"
  "$H/scripts/check-ipl-log.sh" "$L/herc-$tag.log" 2>&1 | tail -2
  [ $rc -ne 0 ] && rc_all=1
done
exit $rc_all
