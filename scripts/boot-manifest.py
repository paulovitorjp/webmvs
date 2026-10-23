#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""build the first boot manifest and the working-set bytes from a track-access trace.

Usage (on host):
  boot-manifest.py --trace T --cnf conf/web.cnf --rundir dasd/web --ts logs/X.log.ts \
                   --ready EPOCH --out dasd/manifest

Inputs
  trace   lines "epoch.usec,DEVN,trk,ra" from patches/0000-trace-trk.patch (HERC_TRK_TRACE).
          One line per cckd_read_trk cache miss (= one track image read from the image file).
  cnf     Hercules config: maps DEVN -> base CCKD image (paths relative to rundir).
  ts      timestamped Hercules log (scripts/tslog.pl) for the IPL and IKT007I epochs.
  ready   epoch when tso-smoke.sh first saw TSO READY.

Outputs (in --out)
  boot-trace-raw.csv     epoch,devnum,trk,ra,phase  (whole trace, phase = pre-ipl/ipl/logon/after-ready)
  boot-trace.csv         devnum,trk  (all reads from Hercules start to READY, in order)
  boot-tracks.csv        devnum,trk  (de-duplicated, first-access order, start to READY)
  boot-tracks-ikt007i.csv devnum,trk (de-duplicated, start to IKT007I)
  working-set.json       per-volume numbers and totals (see below)

Working-set bytes : sum of the base-image CCKD L2 `len` values
(compressed track bytes) of the distinct tracks read from IPL to TSO READY, plus the header
(512 CKD + 512 CCKD) and L1/L2 table bytes of each volume. "L2 table bytes" = all L2 tables
present in the base image (256 entries x 8 bytes each). Also reported: only the L2 tables that
the distinct tracks touch, and the numbers without readahead reads (ra=0 only).
"""
import argparse, json, os, re, struct, sys
from collections import OrderedDict


def read_cckd_tables(path):
    with open(path, 'rb') as f:
        hdr = f.read(1024)
        devid = hdr[0:8].decode('ascii', 'replace')
        heads, trksize = struct.unpack_from('<II', hdr, 8)
        opts = hdr[512 + 3]
        end = '>' if opts & 0x02 else '<'
        numl1, numl2 = struct.unpack_from(end + 'II', hdr, 512 + 4)
        f.seek(1024)
        l1 = list(struct.unpack(end + '%dI' % numl1, f.read(4 * numl1)))
        l2 = {}
        for i, off in enumerate(l1):
            if off in (0, 0xFFFFFFFF):
                continue
            f.seek(off)
            raw = f.read(2048)
            l2[i] = [struct.unpack_from(end + 'IHH', raw, 8 * k) for k in range(256)]
    return dict(devid=devid, heads=heads, trksize=trksize, numl1=numl1, numl2=numl2,
                l1=l1, l2=l2, size=os.path.getsize(path))


def first_epoch(ts_path, pattern):
    rx = re.compile(pattern)
    with open(ts_path, errors='replace') as f:
        for line in f:
            if rx.search(line):
                return float(line.split(' ', 1)[0])
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--trace', required=True); ap.add_argument('--cnf', required=True)
    ap.add_argument('--rundir', required=True); ap.add_argument('--ts', required=True)
    ap.add_argument('--ready', type=float, required=True); ap.add_argument('--out', required=True)
    a = ap.parse_args()

    devs = OrderedDict()
    for line in open(a.cnf):
        m = re.match(r'^([0-9A-Fa-f]{4})\s+(3350|3380|3390|2314)\s+(\S+)', line)
        if m:
            devs[m.group(1).upper()] = os.path.join(a.rundir, m.group(3))
    t_ipl = first_epoch(a.ts, r'HHC01603I IPL ')
    t_ikt = first_epoch(a.ts, r'IKT007I')
    t_ready = a.ready
    if t_ipl is None or t_ikt is None:
        sys.exit('IPL or IKT007I not found in %s' % a.ts)

    recs = []
    for line in open(a.trace):
        p = line.strip().split(',')
        if len(p) != 4:
            continue
        recs.append((float(p[0]), p[1].upper(), int(p[2]), int(p[3])))

    def phase(t):
        return 'pre-ipl' if t < t_ipl else 'ipl' if t <= t_ikt else 'logon' if t <= t_ready else 'after-ready'

    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, 'boot-trace-raw.csv'), 'w') as f:
        f.write('epoch,devnum,trk,ra,phase\n')
        for t, d, k, r in recs:
            f.write('%.6f,%s,%d,%d,%s\n' % (t, d, k, r, phase(t)))
    upto_ready = [x for x in recs if x[0] <= t_ready]
    with open(os.path.join(a.out, 'boot-trace.csv'), 'w') as f:
        f.write('devnum,trk\n')
        for t, d, k, r in upto_ready:
            f.write('%s,%d\n' % (d, k))

    def dedup(rs):
        od = OrderedDict()
        for t, d, k, r in rs:
            key = (d, k)
            if key not in od:
                od[key] = r
            else:
                od[key] = min(od[key], r)   # 0 if the i/o thread ever needed it
        return od
    uniq = dedup(upto_ready)
    uniq_ikt = dedup([x for x in recs if x[0] <= t_ikt])
    for name, od in (('boot-tracks.csv', uniq), ('boot-tracks-ikt007i.csv', uniq_ikt)):
        with open(os.path.join(a.out, name), 'w') as f:
            f.write('devnum,trk\n')
            for (d, k) in od:
                f.write('%s,%d\n' % (d, k))

    vols = OrderedDict(); tot = dict(tracks=0, tracks_ra0=0, null_tracks=0, trk_bytes=0, trk_bytes_ra0=0,
                                     hdr_bytes=0, l1_bytes=0, l2_bytes_all=0, l2_bytes_touched=0,
                                     image_bytes=0)
    for dn, path in devs.items():
        t = read_cckd_tables(path)
        mine = [(k, r) for (d, k), r in uniq.items() if d == dn]
        trk_bytes = trk_bytes_ra0 = nulls = 0; touched = set()
        for k, r in mine:
            l1x, l2x = k >> 8, k & 0xFF
            touched.add(l1x)
            ent = t['l2'].get(l1x)
            ln = ent[l2x][1] if ent else 0
            if ln == 0 or (ent and ent[l2x][0] == 0):
                nulls += 1
            trk_bytes += ln
            if r == 0:
                trk_bytes_ra0 += ln
        touched_tabs = len([x for x in touched if x in t['l2']])
        v = OrderedDict(file=os.path.relpath(path, a.rundir), devid=t['devid'], image_bytes=t['size'],
                        tracks_total=t['numl1'] * 256, numl1=t['numl1'], l2_tables=len(t['l2']),
                        tracks=len(mine), tracks_ra0=len([1 for k, r in mine if r == 0]),
                        null_tracks=nulls, trk_bytes=trk_bytes, trk_bytes_ra0=trk_bytes_ra0,
                        hdr_bytes=1024, l1_bytes=4 * t['numl1'], l2_bytes_all=2048 * len(t['l2']),
                        l2_bytes_touched=2048 * touched_tabs)
        v['working_set_bytes'] = v['trk_bytes'] + v['hdr_bytes'] + v['l1_bytes'] + v['l2_bytes_all']
        vols[dn] = v
        for key in tot:
            tot[key] += v[key]
    tot['working_set_bytes'] = tot['trk_bytes'] + tot['hdr_bytes'] + tot['l1_bytes'] + tot['l2_bytes_all']
    tot['working_set_bytes_touched_l2'] = tot['trk_bytes'] + tot['hdr_bytes'] + tot['l1_bytes'] + tot['l2_bytes_touched']
    tot['working_set_bytes_ra0'] = tot['trk_bytes_ra0'] + tot['hdr_bytes'] + tot['l1_bytes'] + tot['l2_bytes_all']
    phases = OrderedDict()
    for t, d, k, r in recs:
        ph = phase(t); phases[ph] = phases.get(ph, 0) + 1
    res = OrderedDict(
        definition='sum of base-image L2 len of distinct tracks read from Hercules start (IPL) to TSO READY '
                   '+ per volume 1024 header bytes + L1 table + all L2 tables',
        epochs=OrderedDict(ipl=t_ipl, ikt007i=t_ikt, ready=t_ready),
        ipl_to_ikt007i_s=round(t_ikt - t_ipl, 3), ipl_to_ready_s=round(t_ready - t_ipl, 3),
        trace_reads_total=len(recs), trace_reads_by_phase=phases,
        reads_to_ready=len(upto_ready), reads_to_ready_ra0=len([1 for x in upto_ready if x[3] == 0]),
        distinct_tracks_to_ikt007i=len(uniq_ikt), distinct_tracks_to_ready=len(uniq),
        totals=tot, volumes=vols)
    with open(os.path.join(a.out, 'working-set.json'), 'w') as f:
        json.dump(res, f, indent=2)
    print(json.dumps({k: res[k] for k in res if k != 'volumes'}, indent=2))
    print('%-5s %-18s %10s %7s %6s %10s %8s %7s %8s %10s' % ('dev', 'file', 'image', 'tracks', 'ra0', 'trkbytes',
                                                           'l1', 'l2tabs', 'l2bytes', 'workset'))
    for dn, v in vols.items():
        print('%-5s %-18s %10d %7d %6d %10d %8d %7d %8d %10d' % (dn, v['file'], v['image_bytes'], v['tracks'],
              v['tracks_ra0'], v['trk_bytes'], v['l1_bytes'], v['l2_tables'], v['l2_bytes_all'], v['working_set_bytes']))


if __name__ == '__main__':
    main()
