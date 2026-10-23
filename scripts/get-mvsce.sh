#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# download MVS/CE v3.0.0, verify sha256, extract, list DASD and conf files.
set -uo pipefail
EXPECT=95dec45d9396b4deb89b41aaf7c1f0110e2eff165ac0a9c463fcbfc43f9a1a4c
URL=https://github.com/MVS-sysgen/sysgen/releases/download/v3.0.0/MVSCE.release.v3.0.0.tar
REPO=$(cd "$(dirname "$0")/.." && pwd)
D=${D:-$REPO/dasd/mvsce}            # in this repo
mkdir -p "$D" "$REPO/logs"
cd "$D"
if [ ! -f MVSCE.release.v3.0.0.tar ]; then
  curl -fL --retry 3 -o MVSCE.release.v3.0.0.tar.part "$URL" && mv MVSCE.release.v3.0.0.tar.part MVSCE.release.v3.0.0.tar || { echo "DOWNLOAD FAILED"; exit 1; }
fi
echo "== size"; stat -c '%s %n' MVSCE.release.v3.0.0.tar
GOT=$(sha256sum MVSCE.release.v3.0.0.tar | cut -d' ' -f1)
echo "== sha256 got=$GOT"
echo "== sha256 exp=$EXPECT"
if [ "$GOT" = "$EXPECT" ]; then echo "SHA256 OK"; else echo "SHA256 MISMATCH"; exit 2; fi
echo "== tar top-level"; tar tf MVSCE.release.v3.0.0.tar | cut -d/ -f1 | sort -u
tar xf MVSCE.release.v3.0.0.tar || { echo "EXTRACT FAILED"; exit 3; }
TOP=$(tar tf MVSCE.release.v3.0.0.tar | head -1 | cut -d/ -f1)
echo "== extracted to $D/$TOP"
cd "$D/$TOP"
echo "== top dir"; ls -la
echo "== DASD"; ls -l DASD/ 2>/dev/null || find . -maxdepth 2 -iname '*.3350' -o -maxdepth 2 -iname '*.3380' -o -maxdepth 2 -iname '*.3390' | xargs ls -l
echo "== DASD headers (first 8 bytes)"; for f in DASD/*; do printf '%s ' "$f"; head -c 8 "$f" | od -An -c | tr -s ' '; done
echo "== conf (recursive)"; find conf -type f -exec ls -l {} \;
echo "== all non-DASD files"; find . -type f -not -path './DASD/*' | sort
echo "== du"; du -sh DASD . 
