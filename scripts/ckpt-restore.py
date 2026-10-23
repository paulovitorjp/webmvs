#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# rebuild the shadow files of a checkpoint directory, full or delta.
#   ckpt-restore.py <slot dir> <out dir>            check checkpoint.json (crc32 of every file, also of the base
#                                                     for a delta), write the shadow files into <out dir>
#   ckpt-restore.py <slot dir> <out dir> --compare  also compare with <slot>/verify/ (checkpoint ... verify=1):
#                                                     the shadow files byte for byte, and main storage (base .srf
#                                                     + the delta's pages) with verify/machine.srf
# Delta file shadows.dlt (little endian): "MVSCKDL1", then per file 'F' u16 namelen name u64 size u32 nruns,
# runs (u64 off, u32 len, data); end 'E' u32 nfiles. Result = base copy, cut/extended to size, runs applied.
import json, os, struct, sys, zlib, gzip

def crc(b): return '%08X' % (zlib.crc32(b) & 0xffffffff)

def load(d):
    m = json.load(open(os.path.join(d, 'checkpoint.json')))
    assert m.get('end') is True, d + ': not complete'
    return m

def check(path, size, c):
    b = open(path, 'rb').read()
    assert len(b) == size, (path, len(b), size)
    if c is not None: assert crc(b) == c, (path, 'crc32')
    return b

def parse_dlt(b):
    assert b[:8] == b'MVSCKDL1', 'delta magic'
    p, out = 8, {}
    while True:
        t = b[p:p+1]; p += 1
        if t == b'E':
            n, = struct.unpack_from('<I', b, p); assert n == len(out), ('nfiles', n, len(out)); return out
        assert t == b'F', ('record', t, p)
        nl, = struct.unpack_from('<H', b, p); p += 2
        name = b[p:p+nl].decode(); p += nl
        size, nr = struct.unpack_from('<QI', b, p); p += 12
        runs = []
        for _ in range(nr):
            off, ln = struct.unpack_from('<QI', b, p); p += 12
            runs.append((off, b[p:p+ln])); p += ln
        out[name] = (size, runs)

def srf_records(path):
    b = gzip.open(path).read()
    p, recs = 0, []
    while p < len(b):
        k, ln = struct.unpack_from('>II', b, p); p += 8
        recs.append((k, b[p:p+ln])); p += ln
        if k == 0xacefffff: break
    return recs

MAINSTOR, MSBASE, MSDELTA = 0xace10008, 0xace10060, 0xace10061

def mainstor(path):
    recs = srf_records(path)
    ms = None
    for k, v in recs:
        if k == MAINSTOR: ms = bytearray(v)
        elif k == MSBASE: ms = mainstor(v.rstrip(b'\0').decode())
        elif k == MSDELTA:
            p = 0
            while p < len(v):
                first, cnt = struct.unpack_from('>II', v, p); p += 8
                ms[first*4096:(first+cnt)*4096] = v[p:p+cnt*4096]; p += cnt*4096
    return ms

def rebuild(slot):
    m = load(slot)
    check(os.path.join(slot, 'machine.srf'), m['srf']['size'], m['srf']['crc32'])
    files = {}
    if m.get('kind') == 'delta':
        base = m['base']; bm = load(base)
        assert bm.get('kind', 'full') == 'full', 'base is not full'
        for f in bm['shadows']: files[f['file']] = bytearray(check(os.path.join(base, f['file']), f['size'], f['crc32']))
        check(os.path.join(base, 'machine.srf'), bm['srf']['size'], bm['srf']['crc32'])
        dl = parse_dlt(check(os.path.join(slot, 'shadows.dlt'), m['delta']['size'], m['delta']['crc32']))
        for f in m['shadows']:
            size, runs = dl[f['file']]
            assert size == f['size']
            b = files[f['file']]
            if len(b) > size: del b[size:]
            else: b.extend(bytes(size - len(b)))
            for off, data in runs: b[off:off+len(data)] = data
        for n in list(files):
            if n not in dl: del files[n]
    else:
        for f in m['shadows']: files[f['file']] = check(os.path.join(slot, f['file']), f['size'], f['crc32'])
    return m, files

if __name__ == '__main__':
    slot, out = sys.argv[1], sys.argv[2]
    m, files = rebuild(slot)
    os.makedirs(out, exist_ok=True)
    for n, b in files.items(): open(os.path.join(out, n), 'wb').write(b)
    msg = '%s %s: %d shadows %d B' % (m.get('kind', 'full'), slot, len(files), sum(len(b) for b in files.values()))
    if '--compare' in sys.argv and m.get('kind') == 'delta' and os.path.isdir(os.path.join(slot, 'verify')):
        v = os.path.join(slot, 'verify')
        bad = [n for n, b in files.items() if open(os.path.join(v, n), 'rb').read() != bytes(b)]
        a, w = mainstor(os.path.join(slot, 'machine.srf')), mainstor(os.path.join(v, 'machine.srf'))
        diffp = [i for i in range(0, len(w), 4096) if a[i:i+4096] != w[i:i+4096]]
        msg += '; compare: shadows %s, mainstor %s' % ('equal' if not bad else 'DIFFER ' + ','.join(bad),
                                                      'equal' if not diffp and len(a) == len(w) else 'DIFFER pages %s' % diffp[:8])
    print(msg)
