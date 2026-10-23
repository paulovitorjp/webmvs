#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# one web/app/probe3.mjs view (debug | mobile | late) against a fresh native Hercules, then quit.
# Usage (host): scripts/ui-probe.sh <mode> <url>   e.g. scripts/ui-probe.sh debug 'http://127.0.0.1:8214/?debug=1&backend=native'  (backend=native: the page default is wasm)
set -u
H=$HOME/webmvs; L=$H/logs/ui; OUT=${OUT:-$L/e2e}; mkdir -p "$OUT"
export PATH=$HOME/emsdk/node/24.19.0_64bit/bin:$PATH
PAT="bin/hercules -n -f $H/web/app/run/web-ui.cnf -r"
pgrep -f -- "$PAT" > /dev/null && "$H/scripts/ui-dev.sh" herc-stop > /dev/null
tmux -L ui kill-session -t herc 2>/dev/null
"$H/scripts/ui-dev.sh" reset > /dev/null
LOG=$L/herc-probe-$1.log "$H/scripts/ui-dev.sh" herc-start > /dev/null || exit 1
ln -sf "herc-probe-$1.log" "$L/herc.log"; sleep 2
( cd "$H/web/app" && timeout 300 node probe3.mjs "$1" "$2" "$OUT" ); rc=$?
"$H/scripts/ui-dev.sh" herc-stop > /dev/null; tmux -L ui kill-session -t herc 2>/dev/null
grep -cE 'HHC[0-9]{5}[ES]' "$L/herc-probe-$1.log" | sed 's/^/HHC E\/S lines: /'
exit $rc
