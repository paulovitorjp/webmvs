#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""show (and optionally change) the MVS 3.8 SRM parameter table RMPT on a native Hercules.
The browser runtime does the same as TUNE=<n> in C at TSO ready (src/wasm/wasm_main.c srm_tune(), runtime option
srmTune); this script is for the native A/B runs (an internal (unpublished) test script with SRMTUNE=<n>).
CVT (PSA+X'10') + X'25C' CVTOPCTP -> RMCT ('RMCT'); RMCT+X'10' RMCTRMPT -> RMPT ('RMPT', 72 bytes; layout from
OS/VS2 Debugging Handbook Vol 3 GC28-0710-0, 'SRM Parameter Table'). Usage: mvs-srm.py <hercules log> [OFF=HEX8 ...]
(env TMUX_SOCK, SES as for stock-ipl.sh cmd;
CHAIN=1 lists the time-driven SRM routines, TUNE=<n> sets the intervals, see below)."""
import os, re, subprocess, sys, time
LOG = sys.argv[1]; SETS = sys.argv[2:]
CMD = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'stock-ipl.sh')
def vblock(base):
    pos = os.path.getsize(LOG)
    subprocess.run([CMD, 'cmd', f'v {base:X}.10'], check=True)
    pat = re.compile(r'V:%08X(?::K:[0-9A-F]+)?=?((?:\s+[0-9A-F]{8}){4})' % base)
    end = time.time() + 10
    while time.time() < end:
        with open(LOG, errors='replace') as f: f.seek(pos); txt = f.read()
        m = pat.search(txt)
        if m: return bytes.fromhex(''.join(re.findall(r'[0-9A-F]{8}', m.group(1))))
        time.sleep(0.2)
    raise SystemExit(f'no output for v {base:X}: {txt[-300:]}')
def vread(addr, n=16):
    base = addr & ~0xF; b = vblock(base)
    while len(b) < (addr - base) + n: b += vblock(base + len(b))
    return b[addr - base:addr - base + n]
w = lambda b, o=0: int.from_bytes(b[o:o + 4], 'big')
NAMES = {0: 'NAME', 4: 'CPU', 8: 'IOC', 0xC: 'ERV', 0x10: 'IMN', 0x14: 'TCS', 0x18: 'TOM', 0x1C: 'TOL', 0x20: 'RSV1',
         0x24: 'RSV2/3', 0x28: 'XCHT', 0x2C: 'SAET', 0x30: 'WMET', 0x34: 'CPET', 0x38: 'IOET', 0x3C: 'OPC/OPI/OPE', 0x40: '+40', 0x44: '+44'}
cvt = w(vread(0x10, 4)) & 0x7FFFFFFF
rmct = w(vread(cvt + 0x25C, 4)) & 0x7FFFFFFF
hdr = vread(rmct, 4)
rmpt = w(vread(rmct + 0x10, 4)) & 0x7FFFFFFF
print(f'CVT {cvt:08X} RMCT {rmct:08X} ({hdr.decode("cp037")}) RMPT {rmpt:08X}')
for s in SETS:
    off, val = s.split('='); off = int(off, 16)
    subprocess.run([CMD, 'cmd', f'v {rmpt + off:X}={int(val, 16):08X}'], check=True); time.sleep(0.5)
b = vread(rmpt, 72)
print('RMPT', b[:4].decode('cp037'))
for o in range(4, 72, 4): print(f'  +{o:02X} RMPT{NAMES.get(o, "?"):12s} {w(b, o):08X} = {w(b, o)}')
# CHAIN=1: list the time-driven SRM routines: RMCT+X'5C' RMCTTMQE = queue head (RMEP layout, PRV = 'TMQE');
# each RMEP: +0 EPA, +8 FLG, +10 FWD, +14 BCK, +18 TME (next run), +1C INT (interval, units of 1.024 ms)
if os.environ.get('CHAIN'):
    rc = vread(rmct, 0x60); head = w(rc, 0x5C) & 0x7FFFFFFF
    print(f'TMQE head {head:08X} ({vread(head + 0xC, 4).decode("cp037")})')
    p = w(vread(head, 0x14), 0x10) & 0x7FFFFFFF
    for _ in range(40):
        if p == head or p == 0: break
        e = vread(p, 0x20)
        print(f'  RMEP {p:08X} EPA {w(e,0):08X} FLG {w(e,8):08X} TME {w(e,0x18):08X} INT {w(e,0x1C)}')
        p = w(e, 0x10) & 0x7FFFFFFF
# TUNE=<ms>: set RMPTTOM=<ms>, RMPTTOL=<ms>/2 and every time-driven RMEP with INT 1000 to <ms> (1 unit = 1.024 ms);
# by default every 1000-unit routine (as the browser runtime); TUNE_MASK=<hex> or TUNE_EPA=<hex>[,<hex>] = only
# the routine(s) with this invocation mask / these entry point addresses (per-routine A/B tests)
if os.environ.get('TUNE'):
    v = int(os.environ['TUNE'])
    for off, val in ((0x18, v), (0x1C, max(1, v // 2))):
        subprocess.run([CMD, 'cmd', f'v {rmpt + off:X}={val:08X}'], check=True); time.sleep(0.3)
    rc = vread(rmct, 0x60); head = w(rc, 0x5C) & 0x7FFFFFFF; p = w(vread(head, 0x14), 0x10) & 0x7FFFFFFF; n = 0
    for _ in range(40):
        if p == head or p == 0: break
        e = vread(p, 0x20)
        only = [int(x, 16) for x in os.environ.get('TUNE_EPA', '').split(',') if x]   # optional: only these routines (EPA)
        # default like the browser (wasm_main.c srm_tune): every 1000-unit routine; TUNE_MASK=<hex>: only the routine
        # with this invocation flag mask (RMEP+8, high 21 bits; e.g. 4000 = EPA 70ED2 in the MVS/CE nucleus)
        mk = int(os.environ.get('TUNE_MASK', '0'), 16)
        sel = (w(e, 0) & 0x7FFFFFFF) in only if only else (w(e, 8) & 0xFFFFF800) == mk if mk else True
        if w(e, 0x1C) == 1000 and sel:
            subprocess.run([CMD, 'cmd', f'v {p + 0x1C:X}={v:08X}'], check=True); time.sleep(0.3); n += 1
            print(f'  RMEP {p:08X} EPA {w(e,0):08X} INT 1000 -> {v}')
        p = w(e, 0x10) & 0x7FFFFFFF
    print(f'TUNE {v}: RMPTTOM {v}, RMPTTOL {max(1, v // 2)}, {n} RMEP intervals')
