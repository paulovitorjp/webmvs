#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""soak-report.py -- summary of scripts/soak.mjs runs.
Usage: soak-report.py <dir> [tag...]   (reads <dir>/soak-<tag>.json; all tags if none given)
Prints per run: result, problems, commands, jobs, and for each metric first/last/max and the growth rate
(least-squares slope after the soak start + 120 s, per hour), plus a 10-minute table."""
import json, sys, os, glob

def slope(xs, ys):
    n = len(xs)
    if n < 3: return None
    mx, my = sum(xs) / n, sum(ys) / n
    d = sum((x - mx) ** 2 for x in xs)
    return None if d == 0 else sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / d

def sh_mem(s):  # sum of shadow file sizes ([1..]) from the last sfd
    v = [x['size'] for k, x in (s.get('sfd') or {}).items() if not k.endswith('[0]')]
    return sum(v) if v else None

def opfs(s):
    o = s.get('opfs')
    if not isinstance(o, list): return None
    v = [x.get('size') for x in o if x.get('size') is not None]
    return sum(v) if v else None

M = [('heapUsed', 'heap in use (mallinfo uordblks)', lambda s: s.get('heapUsed'), 2**20, 'MiB'),
     ('sbrk', 'heap high-water (sbrk)', lambda s: s.get('sbrk'), 2**20, 'MiB'),
     ('mem', 'wasm memory', lambda s: s.get('mem'), 2**20, 'MiB'),
     ('lru', 'lazy LRU in use', lambda s: s.get('lru'), 2**20, 'MiB'),
     ('shadow', 'shadow files (sfd)', sh_mem, 2**10, 'KiB'),
     ('opfs', 'OPFS shadow files', opfs, 2**10, 'KiB'),
     ('rss', 'browser RSS (sum)', lambda s: (s.get('rss') or {}).get('sum'), 2**10, 'MiB'),
     ('jsHeap', 'page JS heap (Chromium)', lambda s: s.get('jsHeap'), 2**20, 'MiB'),
     ('netBytes', 'DASD bytes from network', lambda s: s.get('netBytes'), 2**10, 'KiB'),
     ('workers', 'Workers created', lambda s: s.get('workers'), 1, ''),
     ('threads', 'Hercules threads', lambda s: s.get('threads'), 1, ''),
     ('logDropped', 'log drops', lambda s: s.get('logDropped'), 1, ''),
     ('seen', 'page console lines kept (operator.seen)', lambda s: s.get('seen'), 1, ''),
     ('evict', 'LRU evictions', lambda s: s.get('evict'), 1, ''),
     ('demandWaits', 'lazy demand waits', lambda s: s.get('demandWaits'), 1, '')]

def report(path):
    d = json.load(open(path))
    S = [s for s in d['samples'] if 'err' not in s]
    t0 = (d.get('soakStartT') or 0) + 120
    print(f"\n## {d['tag']}: {d['browser']} {d['url']} mode={d['opts']['MODE']} dur={d['opts']['DUR_S']} s")
    print(f"result: {d['result']}; start {d['start']} end {d.get('end')}; samples {len(S)}")
    c = d['cmds']
    for term in ('tso', 'console'):
        cc = [x for x in c if x['term'] == term]
        if cc:
            ms = sorted(x['ms'] for x in cc if x.get('ok'))
            print(f"{term} commands: {len(cc)}, ok {sum(1 for x in cc if x.get('ok'))}, reply ms median {ms[len(ms)//2] if ms else '-'} max {ms[-1] if ms else '-'}")
    if d['jobs']:
        js = [j.get('s') for j in d['jobs'] if j.get('s')]
        print(f"jobs: {len(d['jobs'])} ended {len(js)}, submit->IEF404I s: min {min(js) if js else '-'} median {sorted(js)[len(js)//2] if js else '-'} max {max(js) if js else '-'}")
    probs = {}
    for p in d['problems']: probs.setdefault(p['kind'], []).append(p)
    for k, v in probs.items(): print(f"PROBLEM {k}: {len(v)} x, first {json.dumps(v[0])[:300]}")
    print(f"page errors: {len(d.get('pageErrors') or [])} {(d.get('pageErrors') or [])[:3]}")
    print('| metric | first | last | max | slope after +2 min (per hour) | slope after +10 min (per hour) |\n|---|---|---|---|---|---|')
    for key, name, f, div, unit in M:
        pts = [(s['t'], f(s)) for s in S if f(s) is not None]
        if not pts: continue
        ys = [y for _, y in pts]
        late = [(t, y) for t, y in pts if t >= t0]
        sl = slope([t for t, _ in late], [y for _, y in late]) if late else None
        late2 = [(t, y) for t, y in pts if t >= t0 + 480]
        sl2 = slope([t for t, _ in late2], [y for _, y in late2]) if late2 else None
        fmt = lambda v: f"{v/div:.2f} {unit}".strip() if div != 1 else f"{v}"
        fs = lambda sl: '-' if sl is None else (f'{sl*3600/div:+.3f} {unit}/h' if div != 1 else f'{sl*3600:+.1f}/h')
        print(f"| {name} | {fmt(ys[0])} | {fmt(ys[-1])} | {fmt(max(ys))} | {fs(sl)} | {fs(sl2)} |")
    # 10-minute table
    print('\n| t (min) | heap MiB | sbrk MiB | LRU MiB | shadows KiB | OPFS KiB | RSS MiB | JS MiB | workers | drops | seen |\n|---|---|---|---|---|---|---|---|---|---|---|')
    nxt = 0
    for s in S:
        if s['t'] >= nxt or s is S[-1]:
            g = lambda v, dv: '-' if v is None else f"{v/dv:.1f}"
            print(f"| {s['t']/60:.1f} | {g(s.get('heapUsed'),2**20)} | {g(s.get('sbrk'),2**20)} | {g(s.get('lru'),2**20)} | {g(sh_mem(s),1024)} | {g(opfs(s),1024)} | {g((s.get('rss') or {}).get('sum'),1024)} | {g(s.get('jsHeap'),2**20)} | {s.get('workers')} | {s.get('logDropped')} | {s.get('seen')} |")
            nxt = (s['t'] // 600 + 1) * 600

if __name__ == '__main__':
    dr = sys.argv[1]
    tags = sys.argv[2:]
    files = [os.path.join(dr, f'soak-{t}.json') for t in tags] if tags else sorted(glob.glob(os.path.join(dr, 'soak-*.json')))
    for f in files:
        if os.path.exists(f): report(f)
        else: print(f'\n## {f}: missing')
