#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""list the MVS 3.8 address spaces with their dispatching priority, on a native Hercules.

Reads virtual storage with the Hercules 'v' command (sent with scripts/stock-ipl.sh cmd; output from the log):
PSA+X'10' -> CVT; CVT+X'22C' -> ASVT; ASVT+X'204' ASVTMAXU, entries from ASVT+X'210' (high bit = free);
ASCB+X'24' ASCBASID, +X'2A' ASCBDPH (dispatching priority), +X'AC' ASCBJBNI (job name, initiated jobs),
+X'B0' ASCBJBNS (started task / TSO user name), +X'66' ASCBFLG2? (not used). Names are EBCDIC.
Usage: mvs-ascb-dp.py <hercules log> [--max 40]   (env TMUX_SOCK, SES, ... as for stock-ipl.sh cmd)
"""
import os, re, subprocess, sys, time

LOG = sys.argv[1]
MAXN = int(sys.argv[sys.argv.index('--max') + 1]) if '--max' in sys.argv else 40
CMD = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'stock-ipl.sh')

def vblock(base):
    """16 bytes at a 16-byte aligned virtual address (the v command prints aligned lines)."""
    pos = os.path.getsize(LOG)
    subprocess.run([CMD, 'cmd', f'v {base:X}.10'], check=True)
    pat = re.compile(r'V:%08X((?:\s+[0-9A-F]{8}){4})' % base)
    end = time.time() + 10
    while time.time() < end:
        with open(LOG, errors='replace') as f:
            f.seek(pos); txt = f.read()
        m = pat.search(txt)
        if m: return bytes.fromhex(''.join(re.findall(r'[0-9A-F]{8}', m.group(1))))
        time.sleep(0.2)
    raise SystemExit(f'no output for v {base:X}')

def vread(addr, n=16):
    base = addr & ~0xF
    b = vblock(base)
    while len(b) < (addr - base) + n: b += vblock(base + len(b))
    return b[addr - base:addr - base + n]

w = lambda b, o=0: int.from_bytes(b[o:o + 4], 'big')
cvt = w(vread(0x10, 4)) & 0x7FFFFFFF
asvt = w(vread(cvt + 0x22C, 4)) & 0x7FFFFFFF
maxu = w(vread(asvt + 0x204, 4))
print(f'CVT {cvt:08X} ASVT {asvt:08X} ASVTMAXU {maxu}')
for i in range(min(maxu, MAXN)):
    e = w(vread(asvt + 0x210 + 4 * i, 4))
    if e & 0x80000000 or e == 0: continue
    a = vread(e, 16)
    if a[:4] != b'\xc1\xe2\xc3\xc2':          # 'ASCB' in EBCDIC
        print(f'entry {i}: {e:08X} not an ASCB'); continue
    h = vread(e + 0x20, 16)                   # +20..+2F: ASID at +24, DPH at +2A
    asid = int.from_bytes(h[4:6], 'big'); dph = int.from_bytes(h[10:12], 'big')
    jb = vread(e + 0xAC, 8)
    names = []
    for p in (w(jb, 0) & 0x7FFFFFFF, w(jb, 4) & 0x7FFFFFFF):
        names.append(vread(p, 8).decode('cp037').strip() if p else '-')
    print(f'ASID {asid:3d} ASCB {e:08X} DPH {dph:04X} ({dph >> 4:2d},{dph & 15:2d})  JBNI {names[0]:8s} JBNS {names[1]:8s}')
