#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""boot packs and compact metadata for the lazy DASD manifest (format 2, scripts/dasd-chunk.py).

Usage: dasd-packs.py <dasd dir> [--packs 4 (0 = none)] [--list ready|ikt007i] [--meta l2delta|none]

The boot list (manifest boot.ready, in first-access order) is about 100 chunks of up to 128 KiB. A cold
visit fetched them one by one: about 100 requests. This script also writes them as a few "pack" files:
pack j has the chunks at positions j, j+P, j+2P, ... of the boot list (interleaved, so P parallel streams
deliver the chunks in about the boot order), concatenated. The chunk files stay (demand reads, warm
visits from Cache Storage, older pages). It adds to manifest.json:
  "packs": [ { "file": "c/<sha256>", "size": N, "ids": [chunkId, ...] }, ... ]
The reader (src/wasm/library_lazydasd.js) streams a pack and uses each chunk when its bytes are in.
A pack file is content-addressed like the chunks (name = sha256 of the content). Limit: 25 MiB per file.
"""
import argparse, gzip, hashlib, json, os, struct, sys
ap = argparse.ArgumentParser(); ap.add_argument('dir'); ap.add_argument('--packs', type=int, default=4)
ap.add_argument('--list', default='ready', choices=['ready', 'ikt007i'])
ap.add_argument('--meta', default='l2delta', choices=['l2delta', 'none'])
a = ap.parse_args()
mp = os.path.join(a.dir, 'manifest.json'); m = json.load(open(mp))
if m.get('format') != 2: sys.exit('dasd-packs: manifest is not format 2')

# Compact metadata (--meta l2delta): the blob is mostly CCKD L2 entries (pos u32, len u16, size u16) with
# file positions that gzip cannot predict. Per volume the L2 part is rewritten as 8 byte planes of
# little-endian (dpos, len, dsize): dpos = pos - (end of the previous non-null entry) + 1 (0 = null entry,
# then len/size as they are), dsize = size - len. Exactly reversible; rawSize/rawSha256 stay those of the
# original blob, and the reader checks them after it has undone the transform. 210,826 -> about 65,000 B.
def l2delta(raw):
    out = bytearray(raw)
    for v in m['volumes']:
        b = raw[v['metaOff']:v['metaOff'] + v['metaLen']]
        e = '>' if b[512 + 3] & 2 else '<'
        pre = 1024 + 4 * v['numl1']; n = 256 * v['l2tabs']
        if v['metaLen'] < pre + 8 * n: sys.exit('dasd-packs: %s: metadata shorter than its L2 tables' % v['name'])
        planes = [bytearray(n) for _ in range(8)]; prev = 0
        for i in range(n):
            pos, ln, sz = struct.unpack_from(e + 'IHH', b, pre + 8 * i)
            if pos:
                d = (pos - prev + 1) & 0xffffffff
                if d == 0: return None                     # cannot be coded: keep the plain blob
                prev = pos + ln; pos = d; sz = (sz - ln) & 0xffff
            ent = struct.pack('<IHH', pos, ln, sz)
            for k in range(8): planes[k][i] = ent[k]
        o = v['metaOff'] + pre
        for k in range(8): out[o + k * n:o + (k + 1) * n] = planes[k]
    return bytes(out)
mf = m['meta']
if mf.get('transform') and a.meta != mf['transform']:
    sys.exit('dasd-packs: metadata already transformed (%s); start from dasd-chunk.py output' % mf['transform'])
if a.meta == 'l2delta' and mf.get('transform') == 'l2delta': print('dasd-packs: metadata already l2delta')
elif a.meta == 'l2delta':
    mfile = os.path.join(a.dir, mf['file'])
    raw = gzip.decompress(open(mfile, 'rb').read())
    assert len(raw) == mf['rawSize'] and hashlib.sha256(raw).hexdigest() == mf['rawSha256']
    t = l2delta(raw)
    if t is None: print('dasd-packs: metadata not transformed (a position cannot be coded)')
    else:
        g = gzip.compress(t, 9, mtime=0); h = hashlib.sha256(g).hexdigest()
        open(os.path.join(a.dir, 'c', h), 'wb').write(g)
        if 'c/' + h != mf['file']: os.remove(mfile)
        print('dasd-packs: metadata %d -> %d B (l2delta)' % (mf['size'], len(g)))
        mf.update({'file': 'c/' + h, 'size': len(g), 'transform': 'l2delta'})
old = m.pop('packs', None)
ids = m['boot'][a.list]; P = max(0, min(a.packs, len(ids)))   # --packs 0: no packs (metadata only)
packs = []
for j in range(P):
    sel = ids[j::P]
    b = b''.join(open(os.path.join(a.dir, 'c', m['chunks'][i][0]), 'rb').read() for i in sel)
    assert len(b) == sum(m['chunks'][i][1] for i in sel)
    if len(b) > 25 * 1024 * 1024: sys.exit('dasd-packs: pack over 25 MiB: use more packs')
    h = hashlib.sha256(b).hexdigest()
    open(os.path.join(a.dir, 'c', h), 'wb').write(b)
    packs.append({'file': 'c/' + h, 'size': len(b), 'ids': sel})
if old:
    for pk in old:
        f = os.path.join(a.dir, pk['file'])
        if pk['file'] not in {p['file'] for p in packs} and os.path.exists(f): os.remove(f)
if packs: m['packs'] = packs
json.dump(m, open(mp, 'w'), separators=(',', ':'))
print('dasd-packs: %d packs from boot.%s (%d chunks): sizes %s, total %d B' % (P, a.list, len(ids), [p['size'] for p in packs], sum(p['size'] for p in packs)))
