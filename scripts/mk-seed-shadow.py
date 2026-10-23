#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""make the web image's SMF "config-only change" as a CCKD *seed shadow file*.

Why: with persistent shadows (OPFS) every IPL and every 'SWITCH SMF' fills SYS1.MANX/SYS1.MANY on
MVSRES (IEE362A SMF ENTER DUMP FOR SYS1.MANx), nobody dumps them, and after two sessions SMF has no
data set left. The web image does not need SMF records, so recording is turned off:
SYS1.PARMLIB(SMFPRM00) card 7  'MAN=ALL'  ->  'MAN=NONE'  (same member, same record, in place).
The same seed also sets card 3 'JWT=30' -> 'JWT=999' (16.6 h, the largest value that MVS
accepts; JWT=1440 gives IEE355I + IEE356A at IPL). A TSO user in terminal wait longer than JWT gets S522;
after a suspend/resume the TOD jumps by the gap, so with JWT=30 a resumed session after 30 min away was lost
(TOD after resume and long gaps).

The base volume mvsres.3350 stays the pristine MVS/CE v3.0.0 file (content-addressed chunks are
unchanged). The change is one track in a shadow file 'mvsres_1.cckd' (format CKD_S370, the same
layout that Hercules writes for 'sf=': CKD devhdr, CCKD devhdr, L1 table, one L2 table, one track
image). The runtime copies it into the OPFS shadow directory when the machine has no shadow for
MVSRES yet (first visit or after 'Reset machine'); from then on the visitor's own writes go to
the same file.

Usage: mk-seed-shadow.py <base mvsres.3350> <out mvsres_1.cckd>
Prints the patched track (cyl, head), the old and new cards, and the output size.
"""
import struct, sys, zlib, bz2

OLD_TAIL = '    MAN=ALL     USER AND SYSTEM RECORDS PERMITTED'
NEW_CARD = '    MAN=NONE    NO SMF RECORDS (WEB IMAGE: SYS1.MANX/Y NOT USED)'
OLD_JWT = '    JWT=30,     MAXIMUM CONTINUOUS WAIT TIME IS 30 MINS'
NEW_JWT = '    JWT=999,    MAX CONTINUOUS WAIT 999 MINS (WEB IMAGE: RESUME GAPS)'
MEMBER_KEY = '    SID=MVSC,   SYSTEM ID IS MVSC'      # only in SMFPRM00 (SMFPRM99 has SID=H155)


def ebc(s):
    return s.encode('cp037')


def main(base, out):
    with open(base, 'rb') as f:
        data = f.read()
    devhdr, cdh = bytearray(data[0:512]), data[512:1024]
    devid = devhdr[0:8].decode('ascii')
    if devid != 'CKD_C370':
        sys.exit(f'{base}: devid {devid}, expected CKD_C370')
    heads, trksize = struct.unpack_from('<II', devhdr, 8)
    opts = cdh[3]
    end = '>' if opts & 0x02 else '<'
    numl1, numl2 = struct.unpack_from(end + 'ii', cdh, 4)
    l1 = struct.unpack_from(end + '%dI' % numl1, data, 1024)
    hits = []
    for i, off in enumerate(l1):
        if off in (0, 0xFFFFFFFF):
            continue
        for k in range(256):
            pos, ln, size = struct.unpack_from(end + 'IHH', data, off + 8 * k)
            if pos in (0, 0xFFFFFFFF) or ln <= 5:
                continue
            img = data[pos:pos + ln]
            comp = img[0] & 3
            body = img[5:]
            raw = zlib.decompress(body) if comp == 1 else bz2.decompress(body) if comp == 2 else body
            if ebc(MEMBER_KEY) in raw and ebc(OLD_TAIL) in raw:
                hits.append((i * 256 + k, img[:5], raw))
    if len(hits) != 1:
        sys.exit(f'expected exactly one track with SMFPRM00, found {len(hits)}')
    trk, hdr5, raw = hits[0]
    # SMFPRM00 is unblocked (BLKSIZE 80): each card is its own CKD record (8-byte count field
    # CCHHRKDD before it). Check the card before (MAN=: OPI=NO, JWT=: EXT=YES); keep the sequence
    # number (cols 73-80). Each old card must be in the track exactly once.
    changes = []
    for old_text, new_text, before in ((OLD_TAIL, NEW_CARD, '    OPI=NO,'), (OLD_JWT, NEW_JWT, '    EXT=YES,')):
        if raw.count(ebc(old_text)) != 1:
            sys.exit(f'expected {old_text.strip()!r} exactly once in SMFPRM00, found {raw.count(ebc(old_text))}')
        assert len(new_text) <= 72, new_text
        at = raw.index(ebc(old_text))
        old = raw[at:at + 80]
        if raw[at - 8 + 5] != 0 or struct.unpack('>H', raw[at - 2:at])[0] != 80 \
                or not raw[at - 88:at - 8].decode('cp037').startswith(before):
            sys.exit(f'unexpected record layout around {old_text.split()[0]}')
        new = ebc(new_text.ljust(72)) + old[72:80]
        raw = raw[:at] + new + raw[at + 80:]
        changes.append((at, old, new))
    raw2 = raw
    cyl, head = struct.unpack('>HH', hdr5[1:5])
    if trk != cyl * heads + head:
        sys.exit(f'track {trk} != cyl {cyl} head {head}')
    img = bytes([1]) + hdr5[1:5] + zlib.compress(raw2, 6)

    # shadow file: CKD devhdr (devid CKD_S370), CCKD devhdr, L1 (all 0xFFFFFFFF = "in a lower
    # file" except our table), one L2 table right after L1 (cckd_read_l1 L2_bounds check), track.
    l1pos = 1024
    l2pos = l1pos + 4 * numl1
    trkpos = l2pos + 2048
    size = trkpos + len(img)
    devhdr[0:8] = b'CKD_S370'
    cdh2 = bytearray(512)
    cdh2[0:3] = bytes([0, 3, 1])                       # CCKD_VERSION/RELEASE/MODLVL
    cdh2[3] = 0x00                                     # little endian, not opened
    struct.pack_into('<iiIIIIIiI', cdh2, 4, numl1, 256, size, size, 0, 0, 0, 0, 0)
    cdh2[40:44] = cdh[40:44]                           # cyls (little endian in both)
    cdh2[44] = cdh[44]                                 # null track format
    cdh2[45] = 1                                       # zlib
    struct.pack_into('<h', cdh2, 46, -1)
    l1new = [0xFFFFFFFF] * numl1
    l1new[trk // 256] = l2pos
    l2 = bytearray(b'\xff' * 2048)
    struct.pack_into('<IHH', l2, 8 * (trk % 256), trkpos, len(img), len(img))
    blob = bytes(devhdr) + bytes(cdh2) + struct.pack('<%dI' % numl1, *l1new) + bytes(l2) + img
    assert len(blob) == size
    with open(out, 'wb') as f:
        f.write(blob)
    print(f'track {trk} (cyl {cyl} head {head})')
    for at, old, new in changes:
        print(f'record at +{at} old: {old.decode("cp037").rstrip()!r}')
        print(f'record at +{at} new: {new.decode("cp037").rstrip()!r}')
    print(f'{out}: {size} bytes')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
