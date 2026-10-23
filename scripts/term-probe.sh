#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# (Runs on the build host): browser terminal de-risk.
#   setup  vendor tn3270 at the pinned commit, npm install (esbuild, playwright), chromium, build.
#   up     start websockify 127.0.0.1:8081 -> 127.0.0.1:$PORT and a static server on 127.0.0.1:8090.
#          PORT defaults to the 3270 port that hercules is listening on (from ss -ltnp).
#   shot   run scripts/term-probe-shot.mjs against the page (needs "up").
#   down   stop websockify and the static server started by "up".
# Everything binds to 127.0.0.1 only. Logs in ~/webmvs/logs/term-probe-*.log.
set -u
R=$HOME/webmvs; P=$R/web/term-probe; L=$R/logs; mkdir -p "$L"
herc_port() { ss -ltnpH 2>/dev/null | awk '/hercules|impl_thread/ {split($4,a,":"); print a[length(a)]}' | grep -E '^327[0-9]$' | head -1; }
case "${1:-}" in
setup)
  set -e
  "$R/scripts/vendor-tn3270.sh" "$R"
  cd "$P" && npm install --no-audit --no-fund > "$L/term-probe-npm.log" 2>&1
  npx playwright install --with-deps chromium > "$L/term-probe-pw-install.log" 2>&1
  node build.mjs 2>&1 | tail -5
  npx playwright --version
  ;;
up)
  PORT=${PORT:-$(herc_port)}
  [ -n "$PORT" ] || { echo "no hercules 3270 listener found"; exit 1; }
  echo "3270 port: $PORT"
  nohup websockify 127.0.0.1:8081 127.0.0.1:"$PORT" > "$L/term-probe-websockify.log" 2>&1 &
  echo $! > "$L/term-probe-websockify.pid"
  nohup python3 -m http.server --bind 127.0.0.1 --directory "$P/dist" 8090 > "$L/term-probe-http.log" 2>&1 &
  echo $! > "$L/term-probe-http.pid"
  sleep 1; ss -ltnp | grep -E ':(8081|8090) '
  ;;
shot)
  mkdir -p "$L/term-probe"
  cd "$P" && node "$R/scripts/term-probe-shot.mjs" "http://127.0.0.1:8090/index.html?ws=ws://127.0.0.1:8081/" "$L/term-probe"
  ;;
down)
  for n in websockify http; do f=$L/term-probe-$n.pid; [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done
  sleep 1; ss -ltn | grep -E ':(8081|8090) ' || echo "8081/8090 closed"
  ;;
*) echo "usage: $0 setup|up|shot|down"; exit 2;;
esac
