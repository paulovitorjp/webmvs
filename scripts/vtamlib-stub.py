#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""add the stub load module IEDIAE (alias IEDIAK) to SYS1.VTAMLIB on MVSRES, in place in the
compressed CCKD volume, so that VTAM no longer writes 6 x "IST025I BLDL FAILED FOR IEDIAE/IEDIAK IN VTAMLIB"
at every IPL.

Cause: the VTAM resource definition vector tables ISTYTCM1, ISTYTCM2, ISTYTCM3
(SYS1.LPALIB, IBM VTAM 5752-SC1) name the TCAM device modules IEDIAE and IEDIAK. VTAM BLDLs every module that its
RDVTs name in VTAMLIB at start. MVS/CE has no TCAM, so the BLDL fails (4 x IEDIAE, 2 x IEDIAK). No VTAMLST /
ATCCONxx / ATCSTRxx statement causes it, VTAM SUPP= does not suppress it (tested: INFO, WARN), and MVS 3.8J has
no MPF. The modules are only used for TCAM-attached devices, which this system does not have.

The change is the result of one native MVS/CE job (scripts/data/vtamlib-iedia-stub.jcl: IFOX00 assembles
"IEDIAE CSECT / SR 15,15 / BR 14", IEWL links it into SYS1.VTAMLIB as IEDIAE with ALIAS IEDIAK, RENT REUS REFR),
recorded as data in scripts/data/vtamlib-iedia-stub.json:
  - track 4320 (VTAMLIB directory): directory blocks R1-R4 as STOW wrote them (2 new entries, the rest shifted);
  - track 4333: the new member's records R7-R13 (CESD, IDR x3, control, text = 1BFF07FE, end of file), appended
    after the last record of the data set (DS1LSTAR was TT 000D R6);
  - the format-1 DSCB of SYS1.VTAMLIB (VTOC, track 1): DS1LSTAR 000D06 -> 000D0D, DS1TRBAL, DS1DSIND bit X'02'
    (as the job left them; DS1REFD is left 0, so the result does not depend on the date).
The tool checks the sha256 of the three base tracks first (the pinned MVS/CE v3.0.0 mvsres.3350), so it applies
only to the image it was recorded on. Deterministic: same input, same output bytes. A track that grew is appended, so the tool runs cckdcdsk -3 at the
end (rebuilds the free space; env CCKDCDSK, else cckdcdsk in PATH, else ~/herc-native/bin/cckdcdsk).
Usage: vtamlib-stub.py <in mvsres.3350> <out mvsres.3350>
"""
import bz2, hashlib, json, os, shutil, struct, sys, zlib

src, dst = sys.argv[1], sys.argv[2]
P = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'vtamlib-iedia-stub.json')))
shutil.copyfile(src, dst)
f = open(dst, 'r+b')
dh = f.read(512)
assert dh[:8] in (b'CKD_C370', b'CKD_S370'), dh[:8]
cd = bytearray(f.read(512))
assert not (cd[3] & 0x02), 'big-endian CCKD not supported'
num_l1 = struct.unpack_from('<i', cd, 4)[0]
f.seek(1024)
l1 = struct.unpack(f'<{num_l1}I', f.read(4 * num_l1))

def read(trk):
    off = l1[trk // 256]
    f.seek(off + 8 * (trk % 256)); pos, ln, sz = struct.unpack('<IHH', f.read(8))
    f.seek(pos); raw = f.read(ln); comp = raw[0] & 0x03
    body = raw[5:]
    img = raw[:5] + (zlib.decompress(body) if comp == 1 else bz2.decompress(body) if comp == 2 else body)
    return bytearray(img), comp, (off + 8 * (trk % 256), pos, ln, sz)

def split(img):
    """track image -> (header + R0 bytes, [record bytes = count + key + data])"""
    p = 5 + 8 + 8
    assert bytes(img[-8:]) == b'\xff' * 8, 'track image does not end with the end-of-track marker'
    head, out = bytes(img[:p]), []
    while p + 8 <= len(img):
        cnt = img[p:p + 8]
        if cnt == b'\xff' * 8: break
        n = 8 + cnt[5] + struct.unpack('>H', cnt[6:8])[0]
        out.append(bytes(img[p:p + n])); p += n
    assert p == len(img) - 8, 'bytes after the end-of-track marker'
    return head, out

def write(trk, img, comp, e):
    l2pos, pos, ln, sz = e
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
        # the old slot is left as is (cckdcdsk -3 adds it to the free space); like vtamlst-trim.py
        f.seek(0, 2); npos = f.tell(); f.write(out)
        f.seek(l2pos); f.write(struct.pack('<IHH', npos, len(out), len(out)))
        struct.pack_into('<II', cd, 12, npos + len(out), npos + len(out))
        where = f'appended at {npos}'
    f.seek(512); f.write(cd)
    return (trk, ln, len(out), where)

tracks = {}
for t, h in P['base_track_sha256'].items():
    img, comp, e = read(int(t))
    got = hashlib.sha256(bytes(img)).hexdigest()
    if got != h: sys.exit(f'track {t}: sha256 {got} is not the recorded base {h} (not the pinned MVS/CE mvsres.3350?)')
    tracks[int(t)] = (img, comp, e)
done = []
# directory blocks
img, comp, e = tracks[4320]
head, recs = split(img)
for r, hx in P['replace']['4320'].items():
    new = bytes.fromhex(hx)
    assert len(new) == len(recs[int(r) - 1]) and new[:5] == recs[int(r) - 1][:5], f'R{r}: count field differs'
    recs[int(r) - 1] = new
img = bytearray(head + b''.join(recs) + b'\xff' * 8)
done.append(write(4320, img, comp, e))
# new member records
img, comp, e = tracks[4333]
head, recs = split(img)
new = [bytes.fromhex(x) for x in P['append']['4333']]
assert [x[4] for x in new] == list(range(len(recs) + 1, len(recs) + 1 + len(new))), 'record numbers'
img = bytearray(head + b''.join(recs + new) + b'\xff' * 8)
done.append(write(4333, img, comp, e))
# format-1 DSCB of SYS1.VTAMLIB: DS1DSIND (data offset 49), DS1LSTAR + DS1TRBAL (54-58)
img, comp, e = tracks[1]
head, recs = split(img)
want = bytes.fromhex(P['dscb_base']); sh = bytes.fromhex(P['dscb_shadow'])
for i, x in enumerate(recs):
    kl, dl = x[5], struct.unpack('>H', x[6:8])[0]
    if kl == 44 and x[8:52].decode('cp037').strip() == 'SYS1.VTAMLIB':
        d = bytearray(x[52:52 + dl])
        assert bytes(d) == want, 'VTAMLIB DSCB is not the recorded base'
        d[49] = sh[49]; d[54:59] = sh[54:59]
        recs[i] = x[:52] + bytes(d)
        break
else:
    sys.exit('SYS1.VTAMLIB DSCB not found on track 1')
img = bytearray(head + b''.join(recs) + b'\xff' * 8)
done.append(write(1, img, comp, e))
f.close()
# A track that did not fit in its old slot was appended; the old slot is then not in the free space chain.
# cckdcdsk -3 rebuilds the free space (deterministic: the same input gives the same file; a second run: rc=0).
if any(x[3] != 'in place' for x in done):
    import subprocess
    exe = os.environ.get('CCKDCDSK') or shutil.which('cckdcdsk') or os.path.expanduser('~/herc-native/bin/cckdcdsk')
    env = dict(os.environ); hb = os.path.dirname(os.path.dirname(exe))
    env['LD_LIBRARY_PATH'] = ':'.join(x for x in (os.path.join(hb, 'lib'), os.path.join(hb, 'lib', 'hercules'), env.get('LD_LIBRARY_PATH', '')) if x)
    r = subprocess.run([exe, '-3', dst], capture_output=True, text=True, env=env)
    r2 = subprocess.run([exe, '-3', dst], capture_output=True, text=True, env=env)
    if r2.returncode != 0: sys.exit(f'cckdcdsk -3 after the change: rc={r.returncode}, then rc={r2.returncode}: {r2.stdout[-400:]}{r2.stderr[-400:]}')
    print(f'cckdcdsk -3: free space rebuilt (rc={r.returncode}), second run rc=0')
print(f'SYS1.VTAMLIB: IEDIAE (alias IEDIAK) stub added; DS1LSTAR {want[54:57].hex()} -> {sh[54:57].hex()}; tracks {done}')
