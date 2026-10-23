#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# vendor athornton/tn3270 (MIT) at a pinned commit into web/vendor/tn3270.
# Only the packages the browser terminal needs are kept: core, frontend, canvas (src, assets,
# package.json, tsconfig.json), plus the top-level LICENSE and README. Tests/fixtures are dropped.
# Usage: scripts/vendor-tn3270.sh [repo-root]   (default: the repo that contains this script)
set -euo pipefail
COMMIT=64955b1622b26d9958898e93ceb1482ab82ce57b
URL=https://github.com/athornton/tn3270
ROOT=${1:-$(cd "$(dirname "$0")/.." && pwd)}
DEST=$ROOT/web/vendor/tn3270
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git -C "$TMP" init -q
git -C "$TMP" remote add origin "$URL"
git -C "$TMP" fetch -q --depth 1 origin "$COMMIT"
git -C "$TMP" checkout -q FETCH_HEAD
[ "$(git -C "$TMP" rev-parse HEAD)" = "$COMMIT" ] || { echo "commit mismatch"; exit 1; }
rm -rf "$DEST"; mkdir -p "$DEST/packages"
cp "$TMP/LICENSE" "$TMP/README.md" "$TMP/tsconfig.base.json" "$DEST/"
for p in core frontend canvas; do
  mkdir -p "$DEST/packages/$p"
  cp -R "$TMP/packages/$p/src" "$TMP/packages/$p/package.json" "$TMP/packages/$p/tsconfig.json" "$DEST/packages/$p/"
  [ -d "$TMP/packages/$p/assets" ] && cp -R "$TMP/packages/$p/assets" "$DEST/packages/$p/"
done
cat > "$DEST/VENDORED.md" <<EOV
# Vendored: athornton/tn3270

- Source: $URL
- Commit: \`$COMMIT\` ($(git -C "$TMP" log -1 --format='%cI'))
- License: MIT (see LICENSE). The 3270 font in packages/canvas/assets has its own license file.
- Kept: packages/core, packages/frontend, packages/canvas (src, assets, package.json, tsconfig.json).
- Not modified. Re-create with \`scripts/vendor-tn3270.sh\`.
EOV
echo "vendored $COMMIT into $DEST ($(du -sh "$DEST" | cut -f1))"
