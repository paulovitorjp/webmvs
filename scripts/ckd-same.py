#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Check that an install left a volume unchanged: compare two (compressed) CKD images record by record.

  ckd-same.py --herc BINDIR A.3350 B.3350

Ignored: the image header and the last-reference date (DS1REFD) of each format-1 DSCB, which MVS/CE sets
when a data set is opened (reading a library on another day changes it). Exit 0 if the same, 1 if not."""
import argparse, os, subprocess, sys, tempfile


def records(path):
    d = open(path, 'rb').read()
    trksz = int.from_bytes(d[12:16], 'little')
    out, pos = {}, 512
    while pos < len(d):
        t, p = d[pos:pos + trksz], 5
        while p + 8 <= len(t) and t[p:p + 8] != b'\xff' * 8:
            kl, dl = t[p + 5], int.from_bytes(t[p + 6:p + 8], 'big')
            key, data = t[p + 8:p + 8 + kl], bytearray(t[p + 8 + kl:p + 8 + kl + dl])
            if kl == 44 and dl == 96 and data[0] == 0xF1:   # format-1 DSCB: DS1REFD is at data offset 31-33
                data[31:34] = b'\0\0\0'
            out[(pos, p)] = (t[p:p + 8], key, bytes(data))
            p += 8 + kl + dl
        pos += trksz
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--herc', required=True); ap.add_argument('a'); ap.add_argument('b')
    a = ap.parse_args()
    env = dict(os.environ, LD_LIBRARY_PATH=os.path.join(os.path.dirname(a.herc.rstrip('/')), 'lib'))
    with tempfile.TemporaryDirectory() as td:
        imgs = []
        for i, f in enumerate((a.a, a.b)):
            o = os.path.join(td, f'{i}.ckd')
            subprocess.run([os.path.join(a.herc, 'cckd2ckd'), '-q', f, o], env=env, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            imgs.append(records(o))
    diff = [k for k in set(imgs[0]) | set(imgs[1]) if imgs[0].get(k) != imgs[1].get(k)]
    for k in sorted(diff)[:10]: print(f'record at track offset {k[0]}, byte {k[1]} differs')
    sys.exit(1 if diff else 0)


if __name__ == '__main__':
    main()
