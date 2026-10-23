#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# pw-firefox-nodebug.sh -- a copy of Playwright's Firefox in which Juggler does not force
# wasm into debug mode.
#
# Why: Playwright's Firefox driver (Juggler, chrome/juggler/content/content/Runtime.js and WorkerMain.js in omni.ja)
# attaches a SpiderMonkey `Debugger` to every page global and every worker global (it needs it to evaluate scripts).
# A realm that is a debuggee compiles all WebAssembly in *debug mode*: baseline tier only (no Ion), every value
# spilled to the stack, and a breakpoint check (`cmpq $0,0x10(%r14); je; call`) before every wasm instruction.
# hercules.wasm then runs about 5.5 x slower than in a normal Firefox (micro benchmark 1,600 ms against 294 ms; the
# SpiderMonkey 142 shell gives the same 1,620 ms for a debuggee global and 294 ms with allowUnobservedWasm).
# SpiderMonkey has a Debugger flag for this case, `allowUnobservedWasm`: wasm is then compiled normally unless a
# debugger really wants to observe it. This script sets it on Juggler's two Debugger objects in a COPY of the
# Playwright Firefox build. The shared ~/.cache/ms-playwright build is not changed.
#
# Usage: scripts/pw-firefox-nodebug.sh [dest-dir]   (default ~/pw-browsers-nodebug)
#   <dest-dir> becomes a Playwright browsers directory: firefox-NNNN = the patched copy, the other browsers are
#   symlinks to the shared cache. Use it for ALL harness scripts without changes:
#     PLAYWRIGHT_BROWSERS_PATH=<dest-dir> node scripts/e2e.mjs firefox ...
#   or pass <dest-dir>/firefox-NNNN/firefox/firefox as executablePath (e2e.mjs --exe, m6snap-test.mjs FF_BIN).
# Test-harness only: real visitors' Firefox has no Juggler and is not affected.
set -euo pipefail
CACHE=${PW_CACHE:-$HOME/.cache/ms-playwright}
SRC=$(ls -d "$CACHE"/firefox-* | sort | tail -1)
OUT=${1:-$HOME/pw-browsers-nodebug}; DST=$OUT/$(basename "$SRC")
rm -rf "$OUT"; mkdir -p "$OUT"
for d in "$CACHE"/*; do [ "$d" = "$SRC" ] || ln -s "$d" "$OUT/$(basename "$d")"; done
cp -a "$SRC" "$DST"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
( cd "$T" && unzip -q "$DST/firefox/omni.ja" 2>/dev/null || [ $? -le 2 ] )   # optimized jar: unzip warns, rc 1/2
R=$T/chrome/juggler/content/content/Runtime.js; W=$T/chrome/juggler/content/content/WorkerMain.js
grep -q 'this._debugger = new Debugger();' "$R" || { echo "Runtime.js: pattern not found" >&2; exit 1; }
grep -q 'const dbg = new Debugger(global);' "$W" || { echo "WorkerMain.js: pattern not found" >&2; exit 1; }
sed -i 's/this\._debugger = new Debugger();/this._debugger = new Debugger(); this._debugger.allowUnobservedWasm = true;/' "$R"
sed -i 's/const dbg = new Debugger(global);/const dbg = new Debugger(); dbg.allowUnobservedWasm = true; dbg.addDebuggee(global);/' "$W"
rm -f "$DST/firefox/omni.ja"; ( cd "$T" && zip -q -r -X -D "$DST/firefox/omni.ja" . )
echo "patched: $(grep -c allowUnobservedWasm "$R") in Runtime.js, $(grep -c allowUnobservedWasm "$W") in WorkerMain.js"
echo "PLAYWRIGHT_BROWSERS_PATH=$OUT   executablePath: $DST/firefox/firefox"
