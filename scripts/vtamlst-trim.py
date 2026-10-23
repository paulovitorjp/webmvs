#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""trim the VTAM local 3270 major node LCL400 to the terminals that conf/web.cnf defines.

MVS/CE SYS1.VTAMLST(LCL400) on MVS000 defines 31 local 3277s, CUU400-CUU41E (ISTATUS=ACTIVE). The web
config has 0400.4, so at VTAM start 27 lines "IST068I SYSTEM ALLOCATION FOR NODE CUU4xx UNSUCCESSFUL"
fill the master console . Defining 0400.31 in Hercules does not help: VTAM then
contacts 31 terminals with no client, and each gives "IEA000I 4xx,IOE,05,0200,..." (seen with the stock
0400.32). This tool turns the statements of the nodes that are not kept into comment lines (asterisk in
column 1), in place in the compressed CCKD volume:
  - only the track(s) that hold LCL400 change; the records keep their length and count, so the PDS
    directory, the TTRs and the DSCB stay valid;
  - the track is recompressed with its own method (zlib/bzip2); it is written back in its old slot if it
    fits (L2_size), else appended at the end of the file (header size/used updated).
Usage: vtamlst-trim.py <in.3350> <out.3350> [--keep N]   (default N=4: CUU400-CUU403)
Check after: cckdcdsk -3 <out> (rc=0, no change), dasdpdsu <out> SYS1.VTAMLST ascii. Deterministic: the same
input gives the same output bytes.
"""
import argparse, bz2, re, shutil, struct, sys, zlib

ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('dst'); ap.add_argument('--keep', type=int, default=4)
a = ap.parse_args()
KEEP = {f'CUU{0x400 + i:03X}' for i in range(a.keep)}

shutil.copyfile(a.src, a.dst)
f = open(a.dst, 'r+b')
dh = f.read(512)
assert dh[:8] in (b'CKD_C370', b'CKD_S370'), dh[:8]
cd = bytearray(f.read(512))
opts = cd[3]
assert not (opts & 0x02), 'big-endian CCKD not supported'
num_l1, num_l2 = struct.unpack_from('<ii', cd, 4)
size, used = struct.unpack_from('<II', cd, 12)
f.seek(1024)
l1 = struct.unpack(f'<{num_l1}I', f.read(4 * num_l1))

def ebcdic(b): return b.decode('cp037')
def to_ebcdic(s): return s.encode('cp037')

def tracks():
    for i, off in enumerate(l1):
        if off in (0, 0xFFFFFFFF): continue
        f.seek(off)
        l2 = f.read(8 * 256)
        for j in range(256):
            pos, ln, sz = struct.unpack_from('<IHH', l2, 8 * j)
            if pos == 0 or ln == 0: continue
            yield i * 256 + j, off + 8 * j, pos, ln, sz

def records(img):
    """(offset of data, data length) for each record after R0; img = full track image (5-byte header first)."""
    p = 5 + 8 + 8                      # track header, R0 count, R0 data
    while p + 8 <= len(img):
        cnt = img[p:p + 8]
        if cnt == b'\xff' * 8: return
        kl = cnt[5]; dl = struct.unpack('>H', cnt[6:8])[0]
        yield p + 8 + kl, dl
        p += 8 + kl + dl

changed = 0; state = None; mode = None; patched_tracks = []
for trk, l2pos, pos, ln, sz in tracks():
    f.seek(pos); raw = f.read(ln)
    comp = raw[0] & 0x03
    body = raw[5:]
    data = zlib.decompress(body) if comp == 1 else bz2.decompress(body) if comp == 2 else body
    img = bytearray(raw[:5] + data)
    if state is None and to_ebcdic('LCL400   LBUILD') not in img: continue
    hit = False
    for doff, dl in records(img):
        if state is None:
            blk = ebcdic(bytes(img[doff:doff + dl]))
            if 'LCL400   LBUILD' not in blk or dl % 80: continue
            state = 'in'
        if state != 'in': break
        if dl == 0: state = 'done'; break             # end of member
        for r in range(doff, doff + dl, 80):
            line = ebcdic(bytes(img[r:r + 80]))
            name = line[:8].strip()
            if line[0] not in ' *':                    # a new statement
                mode = 'drop' if re.fullmatch(r'CUU4[0-9A-F]{2}', name) and name not in KEEP else 'keep'
            if mode == 'drop' and line[0] != '*':
                new = ('*' + line[:70]).ljust(71) + ' ' + line[72:80]   # col 72 blank (no continuation)
                assert len(new) == 80
                img[r:r + 80] = to_ebcdic(new); changed += 1; hit = True
    if hit:
        newdata = bytes(img[5:])
        nb = zlib.compress(newdata, 9) if comp == 1 else bz2.compress(newdata, 9) if comp == 2 else newdata
        out = bytes(img[:5]) + nb
        if len(out) <= sz:
            f.seek(pos); f.write(out); f.seek(l2pos); f.write(struct.pack('<IHH', pos, len(out), sz)); where = 'in place'
            # the slot keeps its size: the rest is imbedded free space (as cckdcdsk -3 counts it)
            d = ln - len(out)
            used, free_total, free_imbed = struct.unpack_from('<I', cd, 16)[0] - d, struct.unpack_from('<I', cd, 24)[0] + d, struct.unpack_from('<I', cd, 36)[0] + d
            struct.pack_into('<I', cd, 16, used); struct.pack_into('<I', cd, 24, free_total); struct.pack_into('<I', cd, 36, free_imbed)
            f.seek(512); f.write(cd)
        else:
            f.seek(0, 2); npos = f.tell(); f.write(out)
            f.seek(l2pos); f.write(struct.pack('<IHH', npos, len(out), len(out)))
            size = used = npos + len(out); where = f'appended at {npos} (run cckdcdsk -3: the old slot is not in the free list)'
            struct.pack_into('<II', cd, 12, size, used); f.seek(512); f.write(cd)
        patched_tracks.append((trk, ln, len(out), where))
    if state == 'done': break
f.close()
if state is None: sys.exit('LCL400 not found')
print(f'LCL400: kept {sorted(KEEP)}, {changed} records turned into comments, tracks {patched_tracks}')
