#!/bin/bash
# Summarize ljperf runs: IPL 150 -> IKT007I, TSO phase (3 smokes) duration, GO step time and MIPS
# (cpuloop.jcl: 1,202,000,000 loop instructions), smoke result.  Usage: summary.sh <tag>...
cd ~/webmvs/logs/ljperf
printf '%-9s %8s %8s %8s %8s %s\n' tag ipl_s tso_s go_s go_MIPS smoke
for t in "$@"; do
  ipl=$(awk '$1=="ipl"{printf "%.3f", $3-$2}' $t-phases.txt)
  tso=$(awk '$1=="tso"{printf "%.2f", $3-$2}' $t-phases.txt)
  go=$(grep -o 'IEFACTRT GO *[^ ]*/[0-9:.]*/[0-9:.]*' $t.out | head -1 | awk -F/ '{split($4,a,":"); printf "%.2f", a[1]*3600+a[2]*60+a[3]}')
  mips=$(awk -v g="$go" 'BEGIN{ if (g>0) printf "%.1f", 1202000000/g/1e6 }')
  sm=$(grep -o 'smoke: [0-9]*/[0-9]*' $t.out)
  printf '%-9s %8s %8s %8s %8s %s\n' "$t" "$ipl" "$tso" "$go" "$mips" "${sm#smoke: }"
done
