#!/usr/bin/env python3
"""Per-phase longjmp statistics from bench/ljcount output.
Usage: analyze.py <ljcount.log> <phases.txt> [--ff-ns 4490] [--top 12]
ljcount.log: blocks of T/S/P lines (cumulative, about 1 per second). phases.txt: "<name> <start> <end>" (epoch s).
Counters are linearly interpolated at the phase bounds. Firefox estimate = longjmps x ff-ns (bench/longjmp: 4.49 us)."""
import sys, argparse, bisect
ap = argparse.ArgumentParser(); ap.add_argument('log'); ap.add_argument('phases')
ap.add_argument('--ff-ns', type=float, default=4490.0); ap.add_argument('--top', type=int, default=12)
a = ap.parse_args()
snaps = []  # (t, dict scalars, sites, pcodes)
cur = None
for line in open(a.log):
    line = line.rstrip('\n')
    if line.startswith('T '):
        f = line.split(); t = float(f[1]); sc = {k: int(v) for k, v in (x.split('=') for x in f[2:])}
        cur = [t, sc, {}, {}]; snaps.append(cur)
    elif line.startswith('S') and cur is not None:
        for x in line.split()[1:]:
            k, v = x.rsplit('=', 1); cur[2][k] = int(v)
    elif line.startswith('P') and cur is not None:
        for x in line.split()[1:]:
            k, v = x.split('='); cur[3][k] = int(v)
snaps.sort(key=lambda s: s[0]); ts = [s[0] for s in snaps]
def at(t, getter):
    i = bisect.bisect_left(ts, t)
    if i <= 0: return getter(snaps[0]) if t >= ts[0] else 0.0
    if i >= len(ts): return getter(snaps[-1])
    t0, t1 = ts[i-1], ts[i]; v0, v1 = getter(snaps[i-1]), getter(snaps[i])
    return v0 + (v1 - v0) * (t - t0) / (t1 - t0)
keys = sorted({k for s in snaps for k in s[2]}); pks = sorted({k for s in snaps for k in s[3]})
print(f"snapshots: {len(snaps)} from {ts[0]:.3f} to {ts[-1]:.3f}")
hdr = "phase    dur_s   MIPS    lj/s   lj/Minst  node_ns/lj  busy%  node_lj%busy  FF_ms/s  FF%wall  FF%busy*"
print(hdr)
rows = []
for line in open(a.phases):
    f = line.split()
    if len(f) < 3: continue
    name, t0, t1 = f[0], float(f[1]), float(f[2]); dur = t1 - t0
    d = {k: at(t1, lambda s, k=k: s[1].get(k, 0)) - at(t0, lambda s, k=k: s[1].get(k, 0)) for k in ('inst', 'lj', 'land', 'ljns', 'waitus')}
    busy = max(dur - d['waitus'] / 1e6, 1e-9)
    nsper = d['ljns'] / d['land'] if d['land'] else 0
    ffs = d['lj'] * a.ff_ns / 1e9          # Firefox seconds spent in longjmp in this phase
    # FF%busy*: share of the CPU thread's busy time if the non-longjmp busy time stayed the Node value
    ffbusy = ffs / (busy - d['ljns'] / 1e9 + ffs) * 100 if busy > 0 else 0
    print(f"{name:7s} {dur:6.2f} {d['inst']/dur/1e6:7.2f} {d['lj']/dur:8.0f} {d['lj']/max(d['inst'],1)*1e6:9.1f} {nsper:10.0f} {busy/dur*100:6.1f} "
          f"{d['ljns']/1e9/busy*100:11.2f} {ffs/dur*1000:8.1f} {ffs/dur*100:7.2f} {ffbusy:8.2f}")
    rows.append((name, t0, t1, d))
for name, t0, t1, d in rows:
    sd = {k: at(t1, lambda s, k=k: s[2].get(k, 0)) - at(t0, lambda s, k=k: s[2].get(k, 0)) for k in keys}
    pd = {k: at(t1, lambda s, k=k: s[3].get(k, 0)) - at(t0, lambda s, k=k: s[3].get(k, 0)) for k in pks}
    tot = sum(sd.values()) or 1
    print(f"\n[{name}] longjmps {d['lj']:.0f}; top sites:")
    for k, v in sorted(sd.items(), key=lambda x: -x[1])[:a.top]:
        if v >= 0.5: print(f"   {k:22s} {v:10.0f} {v/tot*100:5.1f}%")
    pdt = {k: v for k, v in pd.items() if v >= 0.5}
    if pdt: print("   program interrupts by code: " + ", ".join(f"{k}={v:.0f}" for k, v in sorted(pdt.items(), key=lambda x: -x[1])))
