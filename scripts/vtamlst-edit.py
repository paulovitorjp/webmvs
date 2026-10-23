#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""change cards of a member of a PDS with 80-byte records (e.g. SYS1.VTAMLST) in place,
in a compressed CCKD volume (32-bit CCKD, CKD_C370/CKD_S370), without Hercules or MVS.

The member is found the MVS way: volume label -> VTOC -> format-1 DSCB of the data set (extents) -> PDS directory
-> member TTR -> the member's records up to its end-of-file record. Each --sub OLD --to NEW pair replaces the text OLD by
NEW in the cards of that member (columns 1-71 only; NEW is padded with blanks to the length of OLD, so the card
keeps its length and the columns after it stay where they are; NEW must not be longer than OLD). Every OLD must
match exactly once in the member, else nothing is written.
Only the changed track(s) are rewritten: the records keep their count and length (PDS directory, TTRs, DSCB stay
valid); the track is recompressed with its own method and written back in its old slot if it fits, else appended
(header updated) -- the same write-back as scripts/vtamlst-trim.py.

Usage: vtamlst-edit.py <in.cckd> <out.cckd> --dsn SYS1.VTAMLST --member ATCSTR00 --sub 'SUPP=NOSUP,' --to 'SUPP=WARN,' [...]
       vtamlst-edit.py <in.cckd> - --dsn SYS1.VTAMLST --member ATCSTR00 --list     (print the member, no change)
Deterministic: the same input gives the same output bytes. Check after: cckdcdsk -3 <out> (rc=0).
"""
import argparse, bz2, shutil, struct, sys, zlib

ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('dst')
ap.add_argument('--dsn', default='SYS1.VTAMLST'); ap.add_argument('--member', default=None)
ap.add_argument('--dir', action='store_true', help='list the extents and the PDS directory (member, TTR, absolute track), no change')
ap.add_argument('--sub', action='append', default=[]); ap.add_argument('--to', action='append', default=[]); ap.add_argument('--list', action='store_true')
a = ap.parse_args()
E = lambda s: s.encode('cp037')
D = lambda b: b.decode('cp037')

if a.dst != '-':
    shutil.copyfile(a.src, a.dst)
f = open(a.src if a.dst == '-' else a.dst, 'rb' if a.dst == '-' else 'r+b')
dh = f.read(512)
assert dh[:8] in (b'CKD_C370', b'CKD_S370'), dh[:8]
heads = struct.unpack_from('<I', dh, 8)[0]
cd = bytearray(f.read(512))
assert not (cd[3] & 0x02), 'big-endian CCKD not supported'
num_l1 = struct.unpack_from('<i', cd, 4)[0]
f.seek(1024)
l1 = struct.unpack(f'<{num_l1}I', f.read(4 * num_l1))

def l2ent(trk):
    off = l1[trk // 256]
    if off in (0, 0xFFFFFFFF): return None
    f.seek(off + 8 * (trk % 256))
    pos, ln, sz = struct.unpack('<IHH', f.read(8))
    return (off + 8 * (trk % 256), pos, ln, sz) if pos and ln else None

def track(trk):
    """(image bytearray incl. 5-byte header, compression, l2 entry) of an absolute track"""
    e = l2ent(trk)
    if not e: return None, None, None
    f.seek(e[1]); raw = f.read(e[2])
    comp = raw[0] & 0x03
    body = raw[5:]
    data = zlib.decompress(body) if comp == 1 else bz2.decompress(body) if comp == 2 else body
    return bytearray(raw[:5] + data), comp, e

def records(img):
    """[(r, key offset, kl, data offset, dl)] after R0"""
    out, p = [], 5 + 8 + 8
    while p + 8 <= len(img):
        cnt = img[p:p + 8]
        if cnt == b'\xff' * 8: break
        r, kl, dl = cnt[4], cnt[5], struct.unpack('>H', cnt[6:8])[0]
        out.append((r, p + 8, kl, p + 8 + kl, dl))
        p += 8 + kl + dl
    return out

cchh = lambda c, h: c * heads + h
# volume label: cyl 0 trk 0 R3, data 'VOL1' (EBCDIC); VTOC CCHHR at data offset 11
img, _, _ = track(0)
vol = [x for x in records(img) if x[0] == 3][0]
lab = bytes(img[vol[3]:vol[3] + vol[4]])
if D(lab[:4]) != 'VOL1': lab = bytes(img[vol[1]:vol[1] + vol[2] + vol[4]])[vol[2]:]
assert D(lab[:4]) == 'VOL1', 'no VOL1 label'
vc, vh = struct.unpack('>HH', lab[11:15])
# VTOC: format-1 DSCBs (key = dsname, 44 bytes), extents at data offsets 61, 71, 81 (DS1EXT1-3)
extents = None
t = cchh(vc, vh)
while extents is None:
    img, _, _ = track(t)
    if img is None: break
    stop = False
    for r, ko, kl, do, dl in records(img):
        if kl != 44 or dl != 96: continue
        if img[do] == 0 and all(b == 0 for b in img[ko:ko + 44]): stop = True; break
        if img[do] == 0xF1 and D(bytes(img[ko:ko + 44])).strip() == a.dsn:
            extents = []
            for k in range(3):
                x = img[do + 61 + 10 * k: do + 71 + 10 * k]
                if x[0] == 0: break
                lc, lh, hc, hh = struct.unpack('>HHHH', x[2:10])
                extents.append((cchh(lc, lh), cchh(hc, hh)))
            if img[do + 91:do + 96] != b'\0' * 5: sys.exit(f'{a.dsn}: more than 3 extents (format-3 DSCB) not supported')
            break
    if stop: break
    t += 1
if not extents: sys.exit(f'{a.dsn} not found in the VTOC')

def abs_trk(tt):
    for lo, hi in extents:
        if tt <= hi - lo: return lo + tt
        tt -= hi - lo + 1
    raise ValueError('TTR outside the extents')

if a.dir:
    print(f'{a.dsn}: extents (abs tracks) {extents}')
if not a.member and not a.dir: sys.exit('--member or --dir')
# PDS directory: 256-byte blocks with an 8-byte key, from relative track 0 R1
ttr = None
tt = 0; done = False
while not done and ttr is None:
    img, _, _ = track(abs_trk(tt))
    for r, ko, kl, do, dl in records(img):
        if kl == 8 and dl == 256:
            used = struct.unpack('>H', img[do:do + 2])[0]
            p = do + 2
            while p < do + used:
                name = D(bytes(img[p:p + 8])).strip()
                if img[p:p + 8] == b'\xff' * 8: done = True; break
                c = img[p + 11]
                if a.dir:
                    t3 = struct.unpack('>H', img[p + 8:p + 10])[0]
                    print(f'  {name:8} TTR {t3:04X}{img[p + 10]:02X} abs track {abs_trk(t3)}{" alias" if c & 0x80 else ""}')
                elif name == a.member.upper():
                    ttr = struct.unpack('>H', img[p + 8:p + 10])[0], img[p + 10]
                    break
                p += 12 + 2 * (c & 0x1F)
            if done or ttr: break
        elif dl == 0: done = True; break
    tt += 1
if a.dir: sys.exit(0)
if not ttr: sys.exit(f'member {a.member} not found in {a.dsn}')

# the member's records: from TTR to the end-of-file record (dl = 0)
if len(a.sub) != len(a.to): sys.exit('give one --to NEW for each --sub OLD')
subs = []
for old, new in zip(a.sub, a.to):
    if len(new) > len(old): sys.exit(f'--to {new!r} is longer than --sub {old!r}')
    subs.append([old, new.ljust(len(old)), 0])
tt, r0 = ttr
lines, changed_tracks = [], []
end = False
while not end:
    at = abs_trk(tt)
    img, comp, e = track(at)
    hit = False
    for r, ko, kl, do, dl in records(img):
        if r < r0: continue
        if dl == 0: end = True; break
        assert dl % 80 == 0, f'record length {dl} is not a multiple of 80'
        for q in range(do, do + dl, 80):
            card = D(bytes(img[q:q + 80]))
            lines.append(card)
            for sb in subs:
                if sb[0] in card[:71]:
                    sb[2] += 1
                    nc = card[:71].replace(sb[0], sb[1], 1) + card[71:]
                    assert len(nc) == 80
                    img[q:q + 80] = E(nc); hit = True
    if hit: changed_tracks.append((at, img, comp, e))
    tt += 1; r0 = 1
if a.list:
    print('\n'.join(l.rstrip() for l in lines)); sys.exit(0)
bad = [s for s in subs if s[2] != 1]
if bad: sys.exit(f'each OLD must match exactly once in {a.member}: {[(s[0], s[2]) for s in bad]}')
out_tracks = []
for at, img, comp, (l2pos, pos, ln, sz) in changed_tracks:
    nd = bytes(img[5:])
    nb = zlib.compress(nd, 9) if comp == 1 else bz2.compress(nd, 9) if comp == 2 else nd
    out = bytes(img[:5]) + nb
    if len(out) <= sz:
        f.seek(pos); f.write(out); f.seek(l2pos); f.write(struct.pack('<IHH', pos, len(out), sz))
        d = ln - len(out)
        struct.pack_into('<I', cd, 16, struct.unpack_from('<I', cd, 16)[0] - d)   # used
        struct.pack_into('<I', cd, 24, struct.unpack_from('<I', cd, 24)[0] + d)   # free_total
        struct.pack_into('<I', cd, 36, struct.unpack_from('<I', cd, 36)[0] + d)   # free_imbed
        where = 'in place'
    else:
        f.seek(0, 2); npos = f.tell(); f.write(out)
        f.seek(l2pos); f.write(struct.pack('<IHH', npos, len(out), len(out)))
        struct.pack_into('<II', cd, 12, npos + len(out), npos + len(out))
        where = f'appended at {npos}'
    f.seek(512); f.write(cd)
    out_tracks.append((at, ln, len(out), where))
f.close()
print(f'{a.dsn}({a.member}): TTR {ttr[0]:04X}{ttr[1]:02X}, extents {extents}, '
      f'{", ".join(f"{s[0]!r}->{s[1].rstrip()!r}" for s in subs)}; tracks {out_tracks}')
