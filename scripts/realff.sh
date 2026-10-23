#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# realff.sh -- CPU speed of the bundle in an OFFICIAL Firefox release (not Playwright's).
#
# Why: Playwright's patched Firefox build (1.56.1: firefox-1495 = Firefox 142.0.1) runs wasm about 5 x slower
# than the official Mozilla build of the same version (micro benchmark 1,600 ms against 295 ms; the bundle's
# 1.2e9-instruction CPU loop 115 s against 14.5 s; the same in that binary with and without Playwright attached).
# The soak-test result "Firefox is 5 x slower" was this test-browser artifact. Playwright cannot drive an official
# Firefox (it needs its Juggler patches), so this script runs the benchmark from inside the page:
# scripts/inpage-cpuloop.js is injected into a COPY of the bundle, the copy is served with scripts/pages-emu.mjs,
# and Firefox runs headless with a new profile; the results come back as request paths in the server log.
#
# Usage (build host):
#   scripts/realff.sh get <version> [dir]        download the official Firefox <version> (archive.mozilla.org)
#                                                to <dir> (default ~/ff-<version>), automatic updates off (policy)
#   scripts/realff.sh run <dist> <port> <tag> [firefox binary] [n]
#                                                n cold runs (default 1) of the CPU loop in that Firefox
#                                                (default binary ~/ff-142.0.1/firefox/firefox)
#   scripts/realff.sh pw <dist> <port> <tag> <chromium|firefox>
#                                                the same page with a Playwright browser (for comparison)
# Own resources: work dir ~/realff/<tag> (bundle copy, profile), the given 127.0.0.1 port, logs in ~/realff/logs.
# Kills only the processes it started.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
NODE=${NODE:-$HOME/emsdk/node/24.19.0_64bit/bin/node}
W=${REALFF_DIR:-$HOME/realff}; mkdir -p "$W/logs"
decode() { grep -o '"path":"/__probe/[^"]*"' | sed 's/"path":"\/__probe\///; s/"$//' | python3 -c 'import sys,urllib.parse; [print(" ", urllib.parse.unquote(l.strip())[:700]) for l in sys.stdin]'; }
serve() {   # serve <dist> <port> <tag>: bundle copy with the injected driver; sets SRV_PID, LOGF
  local D=$W/$3/dist; rm -rf "$W/$3"; mkdir -p "$W/$3"; cp -a "$1" "$D"
  cp "$REPO/scripts/inpage-cpuloop.js" "$D/"
  python3 - "$D/index.html" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
m = re.search(r'<script type="module" src="\./assets/app\.[0-9a-f]+\.js"></script>', s) or re.search(r'<script type="module" src="\./app\.js"></script>', s)
if not m: raise SystemExit('no app script tag in index.html')
s = s[:m.end()] + '\n<script src="./inpage-cpuloop.js"></script>' + s[m.end():]
open(p, 'w').write(s)
PY
  LOGF=$W/logs/srv-$3.jsonl; : > "$LOGF"
  "$NODE" "$REPO/scripts/pages-emu.mjs" --root "$D" --port "$2" --profile cloudflare --log "$LOGF" > "$W/logs/srv-$3.out" 2>&1 &
  SRV_PID=$!; sleep 2
}
case "${1:-}" in
get)
  V=$2; D=${3:-$HOME/ff-$V}; mkdir -p "$D"
  curl -sSfL -o "$D/ff.tar.xz" "https://archive.mozilla.org/pub/firefox/releases/$V/linux-x86_64/en-US/firefox-$V.tar.xz" || exit 1
  tar -xJf "$D/ff.tar.xz" -C "$D" && rm -f "$D/ff.tar.xz"
  mkdir -p "$D/firefox/distribution"
  echo '{"policies":{"DisableAppUpdate":true}}' > "$D/firefox/distribution/policies.json"   # else it updates itself
  "$D/firefox/firefox" --version ;;
run)
  DIST=$2; P=$3; TAG=$4; FF=${5:-$HOME/ff-142.0.1/firefox/firefox}; N=${6:-1}
  echo "firefox: $("$FF" --version 2>/dev/null)"
  serve "$DIST" "$P" "$TAG"
  rc=0
  for i in $(seq 1 "$N"); do
    PR=$W/$TAG/profile-$i; rm -rf "$PR"; mkdir -p "$PR"
    printf '%s\n' 'user_pref("dom.max_script_run_time", 0);' 'user_pref("browser.aboutwelcome.enabled", false);' \
      'user_pref("app.update.enabled", false);' 'user_pref("browser.shell.checkDefaultBrowser", false);' \
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);' > "$PR/user.js"
    n0=$(wc -l < "$LOGF")
    MOZ_HEADLESS=1 "$FF" -headless -no-remote -profile "$PR" "http://127.0.0.1:$P/?run=$TAG-$i" > "$W/logs/ff-$TAG-$i.out" 2>&1 &
    FP=$!
    for _ in $(seq 1 1500); do tail -n +$((n0 + 1)) "$LOGF" | grep -q '__probe/done' && break; sleep 1; done
    tail -n +$((n0 + 1)) "$LOGF" | grep -q '__probe/done' || { echo "run $i: no result in 1500 s"; rc=1; }
    kill "$FP" 2>/dev/null; sleep 2; kill -9 "$FP" 2>/dev/null; pkill -9 -f -- "-profile $PR" 2>/dev/null
    echo "== $TAG run $i"; tail -n +$((n0 + 1)) "$LOGF" | decode
    rm -rf "$PR"
  done
  kill "$SRV_PID" 2>/dev/null; exit $rc ;;
pw)
  DIST=$2; P=$3; TAG=$4; BR=$5
  serve "$DIST" "$P" "$TAG"
  ( cd "$REPO/web/app" && timeout 1600 "$NODE" --input-type=module -e "
    import { createRequire } from 'module'; const require = createRequire(process.cwd() + '/');
    const pw = require('playwright'); const b = await pw['$BR'].launch('$BR' === 'firefox' ? { firefoxUserPrefs: { 'dom.max_script_run_time': 0 } } : {});
    const pg = await b.newPage(); await pg.goto('http://127.0.0.1:$P/?run=$TAG');
    for (let i = 0; i < 1500; i++) { await pg.waitForTimeout(1000); if (await pg.evaluate(() => performance.getEntriesByType('resource').some((e) => e.name.includes('/__probe/done')))) break; }
    await b.close();" ) > "$W/logs/pw-$TAG.out" 2>&1
  echo "== $TAG ($BR, Playwright)"; decode < "$LOGF"
  kill "$SRV_PID" 2>/dev/null ;;
*) echo "usage: $0 get <version> [dir] | run <dist> <port> <tag> [firefox] [n] | pw <dist> <port> <tag> <chromium|firefox>"; exit 2 ;;
esac
