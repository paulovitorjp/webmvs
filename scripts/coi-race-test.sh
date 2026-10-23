#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# why a first visit without COOP/COEP headers sometimes needs 3 page loads.
# coi-serviceworker 0.1.7 reloads the page at "updatefound", when its worker has only started to install. If the
# reloaded navigation starts before the worker is active, it is not intercepted (no COOP/COEP), so that page is
# not isolated either. A busy or slow device makes the install slower; this test simulates it: copies of the page
# whose service worker waits <delay> ms in its install event (TEST COPIES ONLY; the bundle is not changed).
# Variant "old": the older dev page (web/dist-dev); "new": index.html with the window.coi.doReload hook.
# Usage (host): scripts/coi-race-test.sh <old page dir> <new page dir> <out dir> [port] [runs] [browsers] [delays]
set -u
OLD=$1 NEW=$2 OUT=$3 PORT=${4:-8326} RUNS=${5:-4} BROWSERS=${6:-"chromium webkit firefox"} DELAYS=${7:-"0 50 150 400 1000 3000"}
REPO=$(cd "$(dirname "$0")/.." && pwd)
export PATH=$HOME/emsdk/node/24.19.0_64bit/bin:$PATH
ROOT=$OUT/site; rm -rf "$ROOT"; mkdir -p "$ROOT"
for v in old new; do
  src=$OLD; [ $v = new ] && src=$NEW
  for d in $DELAYS; do
    t=$ROOT/$v-d$d; mkdir -p "$t"
    cp "$src"/{index.html,app.js,app.css,3270.bdf} "$t/"
    sed "s|self.addEventListener(\"install\", () => self.skipWaiting());|self.addEventListener(\"install\", (e) => e.waitUntil(new Promise((r) => setTimeout(r, $d)).then(() => self.skipWaiting())));|" \
      "$src/coi-serviceworker.js" > "$t/coi-serviceworker.js"
    grep -q "setTimeout(r, $d)" "$t/coi-serviceworker.js" || { echo "patch failed"; exit 1; }
  done
done
node "$REPO/scripts/static-serve.mjs" --root "$ROOT" --port "$PORT" --headers none > "$OUT/serve.log" 2>&1 &
SP=$!; trap 'kill $SP' EXIT; sleep 1
for b in $BROWSERS; do for v in old new; do for d in $DELAYS; do
  node "$REPO/scripts/coi-nav-probe.mjs" "$b" "http://127.0.0.1:$PORT/$v-d$d/index.html?noipl=1" "$RUNS" --settle 2500 --max 12000 \
    --json "$OUT/race-$b-$v-d$d.json" > "$OUT/race-$b-$v-d$d.out" 2>&1
  echo "$b $v install-delay=${d}ms: $(tail -1 "$OUT/race-$b-$v-d$d.out")"
done; done; done
