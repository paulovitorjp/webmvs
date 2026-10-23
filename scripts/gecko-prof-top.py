#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""top functions of a Firefox (Gecko) profile written by MOZ_PROFILER_SHUTDOWN.

Usage: gecko-prof-top.py <profile.json[.gz]> [--top 40] [--threads 3]
Prints, for the threads with the most samples (all processes), the leaf ("self") and inclusive sample counts per
frame location (for wasm: the function name from the name section, e.g. a build linked with --profiling-funcs).
Raw JIT pc frames (0x...) are attributed to the named frame above them.
"""
import gzip, json, sys
from collections import Counter

path = sys.argv[1]
TOP = int(sys.argv[sys.argv.index('--top') + 1]) if '--top' in sys.argv else 40
NT = int(sys.argv[sys.argv.index('--threads') + 1]) if '--threads' in sys.argv else 3
raw = gzip.open(path).read() if path.endswith('.gz') else open(path, 'rb').read()
prof = json.loads(raw)

def threads(p):
    for t in p.get('threads', []):
        yield t
    for c in p.get('processes', []):
        yield from threads(c)

rows = []
for t in threads(prof):
    s = t.get('samples', {}); st = t.get('stackTable', {}); ft = t.get('frameTable', {}); strs = t.get('stringTable', [])
    if not s.get('data'): continue
    si = s['schema']['stack'] if isinstance(s.get('schema'), dict) else 0
    sp = st['schema']['prefix']; sf = st['schema']['frame']; fl = ft['schema']['location']
    stacks = st['data']; frames = ft['data']
    self_c, incl_c = Counter(), Counter(); n = 0
    for smp in s['data']:
        k = smp[si]
        if k is None: continue
        n += 1
        seen = set(); first = True
        while k is not None:
            loc = strs[frames[stacks[k][sf]][fl]]
            if loc.startswith('0x'):           # a raw JIT pc under a named wasm/JS frame: attribute to that frame
                k = stacks[k][sp]; continue
            loc = loc.split(' (http')[0]
            if first: self_c[loc] += 1; first = False
            if loc not in seen: incl_c[loc] += 1; seen.add(loc)
            k = stacks[k][sp]
    rows.append((n, t.get('name'), t.get('tid'), self_c, incl_c))
rows.sort(key=lambda r: -r[0])
for n, name, tid, self_c, incl_c in rows[:NT]:
    print(f'== thread {name} tid {tid}: {n} samples')
    print('  self%  incl%  location')
    for loc, c in self_c.most_common(TOP):
        print(f'  {100 * c / n:5.1f}  {100 * incl_c[loc] / n:5.1f}  {loc[:150]}')
    print('  -- top inclusive --')
    for loc, c in incl_c.most_common(TOP // 2):
        print(f'  {100 * self_c[loc] / n:5.1f}  {100 * c / n:5.1f}  {loc[:150]}')
