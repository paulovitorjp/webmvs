#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Scan a Hercules/MVS log for missing-dataset/volume errors, ABENDs and Hercules errors.
# Usage: scripts/check-ipl-log.sh <hercules-log> [until-pattern]
#   until-pattern: stop scanning at the first line matching it (ERE), e.g. 'SCRIPTS/SHUTDOWN.RC'
#                  to check only the IPL + TSO part. Default: scan the whole log.
# Exit: 0 = clean, 1 = findings (printed), 2 = usage.
# The allowlist holds messages that the stock MVS/CE v3.0.0 image also shows.
set -u
LOG=${1:?usage: check-ipl-log.sh <log> [until-pattern]}; UNTIL=${2:-}
[ -r "$LOG" ] || { echo "cannot read $LOG"; exit 2; }
if [ -n "$UNTIL" ]; then BODY=$(awk -v p="$UNTIL" '$0 ~ p {exit} {print}' "$LOG"); else BODY=$(cat "$LOG"); fi

# 1. Error patterns (ERE). MVS messages appear in the Hercules log as "hh:mm:ss / MSGID ..." or "/MSGID".
PAT=(
  'ABEND'                                        # any system/user abend (IEF450I, IEA995I, ...)
  'IE[ACF][0-9]{3}[A-Z]?.*(NOT FOUND|NOT MOUNTED|NOT CATA?LO?G|OBTAIN FAILED|LOCATE FAILED|NO SPACE|UNABLE|I/O ERR|IOERR|MISSING|NOT AVAILABLE|NOT ACCESSIBLE|NOT OPERATIONAL|INVALID|FAILED)'
  'IEA211I'                                      # OBTAIN failed for a LNKLST / system data set
  'IEA318W|IEA30[0-9][AWI]|IEA213A|IEA212A'      # LNKLST / PARMLIB / duplicate-volume problems
  'IEF212I'                                      # JCL: data set not found
  'IEF233[AD]|IEF238D|IEF244I|IEF245I|IEF247I|IEF489I|IEF877E'   # mount / allocation waits (volume missing)
  'IEF45[23]I'                                   # job failed (JCL error)
  'IEF285I.*NOT CATLGD'
  'IEC1[34][0-9]I|IEC161I|IEC02[0-9]I|IEC331I|IEC70[0-9]I'      # OPEN/EOV/catalog errors
  'IEA000I'                                      # I/O error / intervention required
  'HHC[0-9]{5}E'                                 # Hercules error messages
  'HHC[0-9]{5}S'                                 # Hercules severe messages
  'HHC00(00[0-9]|801|803|809)I.*(wait state|program interrupt)'  # disabled wait / loop during IPL
)
# 2. Allowlist (ERE). A line that matches a pattern above and one of these is reported as "allowed".
ALLOW=(
  'HHC00109E set_thread_priority'                # Hercules not running as root (harmless)
  'IEA000I 4[0-1][0-9A-F],IOE,[0-9]+,0200,.*,NET'  # TSO 3270 with no client at VTAM start (stock too)
  'IST025I  BLDL FAILED FOR IEDIA[EK]'           # stock MVS/CE VTAM message (not an IE[ACF] error)
  'disabled wait state 000A0000 00000CCC'        # normal end after QUIESCE (shutdown)
)
fail=0; allowed=0
while IFS= read -r line; do
  hit=0
  for p in "${PAT[@]}"; do [[ $line =~ $p ]] && { hit=1; break; }; done
  [ $hit = 0 ] && continue
  ok=0; for a in "${ALLOW[@]}"; do [[ $line =~ $a ]] && { ok=1; break; }; done
  if [ $ok = 1 ]; then allowed=$((allowed+1)); echo "allowed: $line"; else fail=$((fail+1)); echo "FINDING: $line"; fi
done <<< "$BODY"
echo "check-ipl-log: $(printf '%s\n' "$BODY" | wc -l) lines scanned, $fail findings, $allowed allowed"
[ $fail = 0 ]
