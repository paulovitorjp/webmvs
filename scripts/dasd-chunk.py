#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""split CCKD volumes into track-aligned, content-addressed chunks for lazy loading.

Usage (host):
  dasd-chunk.py --out DIR [--tar TAR | --voldir DIR] [--cnf conf/web.cnf]
                [--boot dasd/manifest/boot-tracks.csv] [--boot-ikt dasd/manifest/boot-tracks-ikt007i.csv]
                [--chunk-kib 128] [--mode bytes|cyl|bootsplit] [--measure]

What it reads (per volume, CCKD32 "CKD_C370"/"CKD_S370" images, either byte order):
  the CKD device header (512 B), the CCKD header (512 B), the L1 table and every L2 table.
  An L2 entry (pos, len, size) gives the file offset and the compressed length of one track image.

What it writes (in --out):
  manifest.json      format 2 (see below), small: volume geometry, chunk list, boot list
  c/<sha256>         one file per distinct chunk: the compressed track images of a run of
                     consecutive tracks, in track order, concatenated (no HTTP-level compression;
                     the track images are already zlib/bzip2). Identical chunks (also across
                     volumes) are written once (dedupe). Tracks with L2 pos 0 (null tracks) are in
                     no chunk: CCKD builds them itself without a read.
  c/<sha256>         (one more) the metadata blob, gzip: per volume the first 1024+4*numl1 bytes
                     of the file (both headers + L1) and then each L2 table (2048 B) in L1 order.
                     The reader serves every header/L1/L2 read from it, so a volume never needs a
                     byte range of the original file.

manifest.json (format 2):
  { "format": 2, "kind": "cckd-chunks",
    "chunking": { "mode": "bytes", "targetBytes": N },
    "meta": { "file": "c/<sha>", "encoding": "gzip", "size": N, "rawSize": N, "rawSha256": "..." },
    "chunks": [ ["<sha256>", size], ... ],                 global, distinct; index = chunk id
    "volumes": [ { "name": "mvsres.3350", "dev": "0150", "size": N, "sha256": "<whole file>",
                   "metaOff": N, "metaLen": N, "numl1": N, "l2tabs": N, "tracks": N,
                   "runs": [ [firstTrack, endTrack, chunkId], ... ] } ],   endTrack exclusive
    "boot": { "ready": [chunkId, ...], "ikt007i": [chunkId, ...],        first-access order
              "readyBytes": N, "ikt007iBytes": N, "source": "..." } }
  The reader rebuilds the file layout from the L2 tables: a track of a run is at offset
  sum(len of the earlier non-null tracks of the run) inside the chunk.

--measure: print, for several chunk sizes and modes, the chunk count, distinct bytes, and the
boot set (requests + bytes to IKT007I and to READY) with an estimated transfer time
(T = bytes*8/BW + RTT * requests / P) for 9 Mbit/s, 60 ms, P=6 and for 50 Mbit/s, 20 ms, P=6.
"""
import argparse, gzip, hashlib, io, json, os, re, struct, sys, tarfile
from collections import OrderedDict

L2TAB = 2048


def read_volume(path):
    with open(path, 'rb') as f:
        data = f.read()
    devid = data[0:8].decode('ascii', 'replace')
    if not devid.startswith('CKD_C370') and not devid.startswith('CKD_S370'):
        raise SystemExit('%s: not a CCKD32 image (devid %r)' % (path, devid))
    opts = data[512 + 3]
    e = '>' if opts & 0x02 else '<'
    heads, trksize = struct.unpack_from(e + 'II', data, 8)
    numl1, numl2 = struct.unpack_from(e + 'II', data, 512 + 4)
    l1 = list(struct.unpack_from(e + '%dI' % numl1, data, 1024))
    prefix = 1024 + 4 * numl1
    meta = bytearray(data[:prefix])
    tracks = {}                     # trk -> (pos, len)
    l2tabs = 0
    extents = [(0, prefix, 'hdr')]
    for i, off in enumerate(l1):
        if off in (0, 0xFFFFFFFF):
            continue
        tab = data[off:off + L2TAB]
        if len(tab) != L2TAB:
            raise SystemExit('%s: L2 table %d at %d is cut off' % (path, i, off))
        meta += tab; l2tabs += 1
        extents.append((off, off + L2TAB, 'l2'))
        for k in range(256):
            pos, ln, sz = struct.unpack_from(e + 'IHH', tab, 8 * k)
            if pos in (0, 0xFFFFFFFF) or ln == 0:
                continue
            if pos + ln > len(data):
                raise SystemExit('%s: track %d beyond end of file' % (path, i * 256 + k))
            tracks[i * 256 + k] = (pos, ln)
            extents.append((pos, pos + ln, 'trk'))
    extents.sort()
    for a, b in zip(extents, extents[1:]):
        if a[1] > b[0]:
            raise SystemExit('%s: overlapping extents %r %r' % (path, a, b))
    return dict(data=data, devid=devid, heads=heads, trksize=trksize, numl1=numl1, numl2=numl2,
                l1=l1, meta=bytes(meta), tracks=tracks, l2tabs=l2tabs, size=len(data),
                sha256=hashlib.sha256(data).hexdigest())


def group(vol, mode, target, boot=None, split_min=None):
    """Return runs [(first, end, [trk...])] of consecutive tracks; only non-null tracks listed."""
    runs, cur, cur_bytes, first = [], [], 0, None
    trks = sorted(vol['tracks'])
    def flush(end):
        nonlocal cur, cur_bytes, first
        if cur:
            runs.append((first, end, cur))
        cur, cur_bytes, first = [], 0, None
    prev_in_boot = None
    for t in trks:
        ln = vol['tracks'][t][1]
        if mode == 'cyl':
            # fixed number of cylinders per chunk (target = tracks per chunk)
            if cur and (t // target) != (cur[0] // target):
                flush(t)
        else:
            if cur and cur_bytes + ln > target:
                flush(t)
            elif mode == 'bootsplit' and cur and boot is not None:
                ib = t in boot
                if ib != prev_in_boot and cur_bytes >= (target // 8 if split_min is None else split_min):
                    flush(t)
        if not cur:
            first = t
        cur.append(t); cur_bytes += ln
        prev_in_boot = (t in boot) if boot is not None else None
    flush((trks[-1] + 1) if trks else 0)
    # make runs contiguous: each run covers [first, next.first)
    out = []
    for i, (a, b, ts) in enumerate(runs):
        end = runs[i + 1][0] if i + 1 < len(runs) else vol['numl1'] * 256
        out.append((a, end, ts))
    return out


def chunk_bytes(vol, ts):
    d = vol['data']
    return b''.join(d[vol['tracks'][t][0]:vol['tracks'][t][0] + vol['tracks'][t][1]] for t in ts)


def load_cnf(path):
    devs = OrderedDict()
    for line in open(path):
        m = re.match(r'^([0-9A-Fa-f]{4})\s+(3350|3380|3390|2314)\s+(\S+)', line)
        if m:
            devs[m.group(1).upper()] = os.path.basename(m.group(3))
    return devs


def load_boot(paths):
    """devnum,trk lines; several files (comma-separated) are merged: the first file's order, then the
    tracks that only later files have, in their order."""
    out, seen = [], set()
    for path in (paths or '').split(','):
        if not path:
            continue
        for line in open(path):
            p = line.strip().split(',')
            if len(p) == 2 and p[1].isdigit():
                k = (p[0].upper(), int(p[1]))
                if k not in seen:
                    seen.add(k); out.append(k)
    return out


def build(vols, devs, mode, target, boot_ready, boot_ikt, split_min=None):
    """Return (chunks{sha: bytes}, chunk_order[sha], vol_runs{name: [(a, b, sha)]}, trk2sha)."""
    bootset = {}
    for d, t in boot_ready:
        bootset.setdefault(devs.get(d), set()).add(t)
    chunks, order, vruns = {}, [], OrderedDict()
    trk2sha = {}
    for name, v in vols.items():
        runs = group(v, mode, target, bootset.get(name, set()), split_min)
        lst = []
        for a, b, ts in runs:
            data = chunk_bytes(v, ts)
            h = hashlib.sha256(data).hexdigest()
            if h not in chunks:
                chunks[h] = data; order.append(h)
            lst.append((a, b, h))
            for t in range(a, b):
                trk2sha[(name, t)] = h
        vruns[name] = lst
    return chunks, order, vruns, trk2sha


def boot_chunks(boot, devs, vols, trk2sha):
    seq, seen = [], set()
    for d, t in boot:
        name = devs.get(d)
        if name not in vols:
            continue
        if t not in vols[name]['tracks']:
            continue                       # null track: no chunk, no request
        h = trk2sha[(name, t)]
        if h not in seen:
            seen.add(h); seq.append(h)
    return seq


def est(nbytes, nreq, mbit, rtt_ms, par):
    return nbytes * 8 / (mbit * 1e6) + rtt_ms / 1000.0 * nreq / par


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out'); ap.add_argument('--tar', default=os.path.expanduser('~/webmvs/dasd/mvsce/MVSCE.release.v3.0.0.tar'))
    ap.add_argument('--voldir'); ap.add_argument('--cnf', default=os.path.join(os.path.dirname(__file__), '..', 'conf', 'web.cnf'))
    ap.add_argument('--boot'); ap.add_argument('--boot-ikt')
    ap.add_argument('--chunk-kib', type=int, default=128); ap.add_argument('--mode', default='bytes', choices=['bytes', 'cyl', 'bootsplit'])
    ap.add_argument('--split-min', type=int, default=None, help='bootsplit: split at a boot/non-boot change once the chunk has this many bytes (default target/8)')
    ap.add_argument('--lcl400-keep', type=int, default=None,
                    help='trim SYS1.VTAMLST(LCL400) on mvs000.3350 to N terminals first (scripts/vtamlst-trim.py)')
    ap.add_argument('--vtamlib-stub', action='store_true',
                    help='add the IEDIAE/IEDIAK stub to SYS1.VTAMLIB on mvsres.3350 first (scripts/vtamlib-stub.py: no IST025I)')
    ap.add_argument('--measure', action='store_true')
    a = ap.parse_args()

    devs = load_cnf(a.cnf)
    tmpdir = None
    if a.lcl400_keep is not None or a.vtamlib_stub:
        import subprocess, tempfile
        tmpdir = tempfile.mkdtemp(prefix='dasd-chunk-')
        for d, name in devs.items():
            dst = os.path.join(tmpdir, name)
            if a.voldir:
                open(dst, 'wb').write(open(os.path.join(a.voldir, name), 'rb').read())
            else:
                with tarfile.open(a.tar) as tf:
                    open(dst, 'wb').write(tf.extractfile(tf.getmember('MVSCE/DASD/' + name)).read())
        here = os.path.dirname(os.path.abspath(__file__))
        if a.lcl400_keep is not None:
            src = os.path.join(tmpdir, 'mvs000.3350')
            subprocess.run([sys.executable, os.path.join(here, 'vtamlst-trim.py'),
                            src, src + '.trim', '--keep', str(a.lcl400_keep)], check=True)
            os.replace(src + '.trim', src)
            print('LCL400 trimmed to %d terminals (vtamlst-trim.py)' % a.lcl400_keep)
        if a.vtamlib_stub:
            src = os.path.join(tmpdir, 'mvsres.3350')
            subprocess.run([sys.executable, os.path.join(here, 'vtamlib-stub.py'), src, src + '.stub'], check=True)
            os.replace(src + '.stub', src)
            print('SYS1.VTAMLIB: IEDIAE/IEDIAK stub added (vtamlib-stub.py)')
        a.voldir = tmpdir
    vols = OrderedDict()
    for d, name in devs.items():
        if a.voldir:
            path = os.path.join(a.voldir, name)
            vols[name] = read_volume(path)
        else:
            with tarfile.open(a.tar) as tf:
                m = tf.getmember('MVSCE/DASD/' + name)
                tmp = tf.extractfile(m).read()
            p = '/tmp/dasd-chunk.%d.%s' % (os.getpid(), name)
            open(p, 'wb').write(tmp)
            try:
                vols[name] = read_volume(p)
            finally:
                os.unlink(p)
        vols[name]['dev'] = d
    if tmpdir:
        import shutil
        shutil.rmtree(tmpdir)
    boot_ready = load_boot(a.boot); boot_ikt = load_boot(a.boot_ikt)
    tot_trk = sum(len(v['tracks']) for v in vols.values())
    tot_trk_bytes = sum(sum(x[1] for x in v['tracks'].values()) for v in vols.values())
    tot_meta = sum(len(v['meta']) for v in vols.values())
    print('volumes: %d, file bytes %d, non-null tracks %d, track bytes %d, metadata bytes %d'
          % (len(vols), sum(v['size'] for v in vols.values()), tot_trk, tot_trk_bytes, tot_meta))

    def exact(boot):
        s, seen = 0, set()
        for d, t in boot:
            n = devs.get(d)
            if n in vols and t in vols[n]['tracks'] and (n, t) not in seen:
                seen.add((n, t)); s += vols[n]['tracks'][t][1]
        return len(seen), s
    if boot_ready:
        n, s = exact(boot_ready); ni, si = exact(boot_ikt)
        print('boot set (exact tracks, no chunking): READY %d tracks %d B; IKT007I %d tracks %d B' % (n, s, ni, si))

    if a.measure:
        meta_gz = len(gzip.compress(b''.join(v['meta'] for v in vols.values()), 9))
        print('metadata blob gzip: %d B (1 request)' % meta_gz)
        print('%-10s %8s %7s %11s %9s | %6s %10s %8s %8s | %6s %10s | %s' % (
            'mode', 'target', 'chunks', 'bytes', 'dedupe', 'req-R', 'bytes-R', 't9-R s', 't50-R s', 'req-I', 'bytes-I', 'files<=25MiB'))
        rows = []
        variants = [('bytes', tg, None) for tg in (16, 32, 64, 128, 256, 512, 1024, 2048)]
        variants += [('bootsplit', tg, None) for tg in (32, 64, 128, 256, 512)]
        variants += [('bootsplit', tg, 0) for tg in (32, 64, 128, 256)]
        variants += [('cyl', tg, None) for tg in (15, 30, 60, 120)]
        for mode, tg, smin in variants:
                target = tg * 1024 if mode != 'cyl' else tg
                chunks, order, vruns, trk2sha = build(vols, devs, mode, target, boot_ready, boot_ikt, smin)
                allref = sum(len(r) for r in vruns.values())
                cb = sum(len(c) for c in chunks.values())
                br = boot_chunks(boot_ready, devs, vols, trk2sha); bi = boot_chunks(boot_ikt, devs, vols, trk2sha)
                brb = sum(len(chunks[h]) for h in br) + meta_gz; bib = sum(len(chunks[h]) for h in bi) + meta_gz
                nr, ni = len(br) + 1, len(bi) + 1
                big = max(len(c) for c in chunks.values())
                lbl = (('%dK' % tg) if mode != 'cyl' else ('%dtrk' % tg)) + ('/s0' if smin == 0 else '')
                print('%-10s %8s %7d %11d %9d | %6d %10d %8.2f %8.2f | %6d %10d | max %d' % (
                    mode, lbl, len(chunks), cb, allref - len(chunks), nr, brb, est(brb, nr, 9, 60, 6),
                    est(brb, nr, 50, 20, 6), ni, bib, big))
                rows.append(dict(mode=mode, target=lbl, chunks=len(chunks), bytes=cb, dedupe_refs=allref - len(chunks),
                                 boot_ready_req=nr, boot_ready_bytes=brb, t9=round(est(brb, nr, 9, 60, 6), 2),
                                 t50=round(est(brb, nr, 50, 20, 6), 2), boot_ikt_req=ni, boot_ikt_bytes=bib, largest=big))
        if a.out:
            os.makedirs(a.out, exist_ok=True)
            json.dump(dict(meta_gz=meta_gz, rows=rows), open(os.path.join(a.out, 'measure.json'), 'w'), indent=1)
        return

    if not a.out:
        raise SystemExit('--out is required (or --measure)')
    target = a.chunk_kib * 1024 if a.mode != 'cyl' else a.chunk_kib
    chunks, order, vruns, trk2sha = build(vols, devs, a.mode, target, boot_ready, boot_ikt, a.split_min)
    cdir = os.path.join(a.out, 'c')
    os.makedirs(cdir, exist_ok=True)
    for f in os.listdir(cdir):
        os.unlink(os.path.join(cdir, f))
    idx = {h: i for i, h in enumerate(order)}
    for h in order:
        with open(os.path.join(cdir, h), 'wb') as f:
            f.write(chunks[h])
    raw = b''.join(v['meta'] for v in vols.values())
    gz = gzip.compress(raw, 9, mtime=0)
    gzh = hashlib.sha256(gz).hexdigest()
    open(os.path.join(cdir, gzh), 'wb').write(gz)
    m = OrderedDict(format=2, kind='cckd-chunks',
                    chunking=OrderedDict(mode=a.mode, targetBytes=target if a.mode != 'cyl' else None, splitMin=a.split_min,
                                         tracksPerChunk=target if a.mode == 'cyl' else None),
                    meta=OrderedDict(file='c/' + gzh, encoding='gzip', size=len(gz), rawSize=len(raw),
                                     rawSha256=hashlib.sha256(raw).hexdigest()),
                    chunks=[[h, len(chunks[h])] for h in order], volumes=[])
    off = 0
    for name, v in vols.items():
        m['volumes'].append(OrderedDict(name=name, dev=v['dev'], size=v['size'], sha256=v['sha256'],
                                        metaOff=off, metaLen=len(v['meta']), numl1=v['numl1'], l2tabs=v['l2tabs'],
                                        tracks=len(v['tracks']),
                                        runs=[[ra, rb, idx[h]] for ra, rb, h in vruns[name]]))
        off += len(v['meta'])
    br = boot_chunks(boot_ready, devs, vols, trk2sha); bi = boot_chunks(boot_ikt, devs, vols, trk2sha)
    m['boot'] = OrderedDict(ready=[idx[h] for h in br], ikt007i=[idx[h] for h in bi],
                            readyBytes=sum(len(chunks[h]) for h in br), ikt007iBytes=sum(len(chunks[h]) for h in bi),
                            source=[os.path.basename(x) for x in a.boot.split(',')] if a.boot else None)
    # self check: rebuild every track from the chunks and compare with the file bytes
    for name, v in vols.items():
        for ra, rb, h in vruns[name]:
            c = chunks[h]; o = 0
            for t in range(ra, rb):
                if t in v['tracks']:
                    pos, ln = v['tracks'][t]
                    assert c[o:o + ln] == v['data'][pos:pos + ln], (name, t)
                    o += ln
            assert o == len(c), (name, ra, rb)
    with open(os.path.join(a.out, 'manifest.json'), 'w') as f:
        json.dump(m, f, separators=(',', ':'))
    allref = sum(len(r) for r in vruns.values())
    print('wrote %s: %d chunk files (%d run refs, %d deduped), %d B chunks, meta %d B gz (%d raw), manifest %d B'
          % (a.out, len(order), allref, allref - len(order), sum(len(c) for c in chunks.values()), len(gz), len(raw),
             os.path.getsize(os.path.join(a.out, 'manifest.json'))))
    print('boot: READY %d chunks %d B, IKT007I %d chunks %d B; largest chunk %d B'
          % (len(br), m['boot']['readyBytes'], len(bi), m['boot']['ikt007iBytes'], max(len(c) for c in chunks.values())))


if __name__ == '__main__':
    main()

