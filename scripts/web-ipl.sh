#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Boot the web config (conf/web.cnf + conf/web.rc) natively, headless.
# Usage (on host): scripts/web-ipl.sh prepare | reset-shadows | start | status | wait | cmd '<cmd>' | shutdown | stop
#   prepare        build the run dir ~/webmvs/dasd/web: the web volumes of $CNF extracted *pristine* from the
#                  release tar (the stock boots in dasd/mvsce/MVSCE wrote to their base images), empty
#                  shadow/, printers/, punchcards/, rdr/, SCRIPTS/ (stock shutdown automation) and herclogo.txt.
#                  Base images are made read-only (chmod a-w): all writes must go to the shadow files.
#   reset-shadows  delete shadow/*.cckd (next boot starts from the pristine base, like a first web visit)
#   other verbs    passed to scripts/stock-ipl.sh with the web settings.
# Env: WEB (run dir), HERC (default ~/herc-native/bin/hercules; trace build: ~/herc-trace/bin/hercules), LOG.
set -u
H=$HOME/webmvs
WEB=${WEB:-$H/dasd/web}   # env WEB: a private run dir (e.g. ~/webmvs/dasd/web-vsock)
TAR=$H/dasd/mvsce/MVSCE.release.v3.0.0.tar
export SHUTRC=${SHUTRC:-$H/conf/web-shutdown.rc}
export MVS=$WEB CNF=${CNF:-$H/conf/web.cnf} RC=${RC:-$H/conf/web.rc} LOG=${LOG:-$H/logs/web-ipl.log}
# the volume list comes from the config (every "DASD/<file>" of $CNF: the 8 volumes of conf/web.cnf incl.
# SYSCPK and WORK00), so prepare can not miss a volume that the config attaches. EXTRA_VOLS adds more.
VOLS=${VOLS:-$(grep -oE '^[0-9A-Fa-f]{3,4}[[:space:]]+[0-9]{4}[[:space:]]+DASD/[^[:space:]]+' "$CNF" | sed 's|.*DASD/||' | tr '\n' ' ')}
EXTRA_VOLS=${EXTRA_VOLS:-}
case "${1:-status}" in
prepare)
  mkdir -p "$WEB"/{DASD,shadow,printers,punchcards,rdr}
  for v in $VOLS $EXTRA_VOLS; do
    if [ ! -f "$WEB/DASD/$v" ]; then tar -xf "$TAR" -C "$WEB/DASD" --strip-components=2 "MVSCE/DASD/$v" || exit 1; fi
    chmod a-w "$WEB/DASD/$v"
  done
  rm -rf "$WEB/SCRIPTS"; tar -xf "$TAR" -C "$WEB" --strip-components=1 MVSCE/SCRIPTS MVSCE/herclogo.txt
  : > "$WEB/rdr/rdr00c.txt"
  ls -l "$WEB/DASD"; sha256sum "$WEB"/DASD/*
  ;;
reset-shadows)
  rm -f "$WEB"/shadow/*.cckd; echo "shadows removed"; ls -l "$WEB/shadow"
  ;;
*)
  exec "$(dirname "$(readlink -f "$0")")/stock-ipl.sh" "$@"
  ;;
esac
