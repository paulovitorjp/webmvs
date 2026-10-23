#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# split the 7 web DASD volumes into chunk files of at most 25 MiB (Cloudflare Pages per-file
# limit; GitHub Pages: 100 MB) and write manifest.json with sizes and sha256 (whole volume and
# each chunk). web/runtime/mvs-runtime.js passes the manifest URL to the wasm loader
# (src/wasm/library_webload.js), which fetches every chunk inside a worker and checks it.
#
# Usage (on the build host): scripts/mk-dasd-chunks.sh <out dir>
# Env:  CHUNK_MIB  chunk size in MiB (default 8; 1..25). Chunks are plain byte ranges of the
#                  volume file (the eager layout loads all of them before IPL; scripts/dasd-chunk.py makes the lazy chunks).
#       VOLDIR     take the volumes from this dir (default: extract them pristine from the
#                  release tar, so stock boots that wrote to the base images do not matter)
#       TAR        release tar (default ~/webmvs/dasd/mvsce/MVSCE.release.v3.0.0.tar)
#       VOLS       volume files (default: the 8 volumes of conf/web.cnf)
#       LCL400_KEEP  N: trim SYS1.VTAMLST(LCL400) on mvs000.3350 to the nodes CUU400.. of the first N
#                  terminals (scripts/vtamlst-trim.py; N=4 matches 0400.4 in conf/web.cnf: no IST068I
#                  lines on the console). Default empty: volumes unchanged.
# Output: <out>/manifest.json, <out>/<volume>.<NNN> (immutable content; names change only
#         with the volume). The script checks that the chunks join to the volume (sha256).
set -euo pipefail
OUT=${1:?usage: mk-dasd-chunks.sh <out dir>}
CHUNK_MIB=${CHUNK_MIB:-8}
[ "$CHUNK_MIB" -ge 1 ] && [ "$CHUNK_MIB" -le 25 ] || { echo "CHUNK_MIB must be 1..25"; exit 1; }
TAR=${TAR:-$HOME/webmvs/dasd/mvsce/MVSCE.release.v3.0.0.tar}
VOLS=${VOLS:-"mvsres.3350 mvs000.3350 page00.3350 spool1.3350 pub000.3380 pub001.3390 syscpk.3350 work00.3350"}
CHUNK=$(( CHUNK_MIB * 1024 * 1024 ))
mkdir -p "$OUT"; rm -f "$OUT"/manifest.json "$OUT"/*.[0-9][0-9][0-9]
TMP=""
if [ -z "${VOLDIR:-}" ]; then
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  for v in $VOLS; do tar -xf "$TAR" -C "$TMP" --strip-components=2 "MVSCE/DASD/$v"; done
  VOLDIR=$TMP
fi
if [ -n "${LCL400_KEEP:-}" ]; then
  T2=$(mktemp -d); trap 'rm -rf "$TMP" "$T2"' EXIT
  for v in $VOLS; do ln -s "$VOLDIR/$v" "$T2/$v"; done
  rm "$T2/mvs000.3350"
  python3 "$(dirname "$0")/vtamlst-trim.py" "$VOLDIR/mvs000.3350" "$T2/mvs000.3350" --keep "$LCL400_KEEP"
  VOLDIR=$T2
fi
cd "$OUT"
for v in $VOLS; do
  split -a 3 -d -b "$CHUNK" "$VOLDIR/$v" "$v."
  cat "$v".[0-9][0-9][0-9] | cmp - "$VOLDIR/$v"
done
python3 - "$VOLDIR" "$CHUNK" $VOLS <<'EOF'
import hashlib, json, os, sys
voldir, chunk, vols = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()
m = {"format": 1, "chunkSize": chunk, "volumes": []}
for v in vols:
    size = os.path.getsize(os.path.join(voldir, v))
    chunks, off, i = [], 0, 0
    while off < size:
        f = f"{v}.{i:03d}"; n = os.path.getsize(f)
        assert n <= 25 * 1024 * 1024
        chunks.append({"file": f, "offset": off, "size": n, "sha256": sha(f)})
        off += n; i += 1
    assert off == size
    m["volumes"].append({"name": v, "size": size, "sha256": sha(os.path.join(voldir, v)), "chunks": chunks})
json.dump(m, open("manifest.json", "w"), indent=1)
tot = sum(v["size"] for v in m["volumes"]); nch = sum(len(v["chunks"]) for v in m["volumes"])
big = max(c["size"] for v in m["volumes"] for c in v["chunks"])
print(f"manifest.json: {len(vols)} volumes, {tot} bytes, {nch} chunks, largest chunk {big} bytes")
EOF
ls -l "$OUT" | tail -n +2 | awk '{s+=$5} END {print NR " files, " s " bytes in " ENVIRON["PWD"]}'
