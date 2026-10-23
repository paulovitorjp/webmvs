#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""TSO / console reply times of a scripts/soak.mjs busy run, split into 'job running' and
'no job running' (the job windows are res.jobs[].sub .. .end; a command counts as 'job' if it started inside one).
Usage: tsoload-report.py <soak-<tag>.json> [...]   Prints one line per run and command: n, median, p90, max (s)."""
import json, statistics, sys

def q(v, p):
    v = sorted(v); return v[min(len(v) - 1, int(round(p * (len(v) - 1))))] if v else None

for f in sys.argv[1:]:
    r = json.load(open(f))
    jobs = [(j['sub'], j.get('end', 1e18)) for j in r.get('jobs', [])]
    inj = lambda t: any(a <= t <= b for a, b in jobs)
    groups = {}
    for c in r.get('cmds', []):
        cmd = c.get('cmd', '')
        if cmd.startswith(('submit', 'edit', 'delete')) or c.get('ms') is None: continue
        k = (c.get('term'), cmd, 'job' if inj(c['t']) else 'nojob')
        groups.setdefault(k, []).append(c['ms'] / 1000)
    tag = f.rsplit('/', 1)[-1]
    print(f'{tag}: jobs {len(jobs)}, result {r.get("result")}, problems {len(r.get("problems", []))}')
    for (term, cmd, ph), v in sorted(groups.items()):
        print(f'  {term:7s} {cmd:9s} {ph:5s} n={len(v):3d} median={statistics.median(v):6.2f} p90={q(v, .9):6.2f} max={max(v):6.2f}')
