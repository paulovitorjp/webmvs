# Licenses

| File | Applies to |
|---|---|
| `../LICENSE`, `../NOTICE` | The code of this project (Apache-2.0) and the third-party notices. Not the patches in `patches/hyperion/` (QPL 1.0). |
| `hercules-QPL-1.0.html` | SDL Hercules 4.x Hyperion (Q Public License 1.0), and so the patches in `patches/hyperion/` and the `hercules.wasm` build. Copied unchanged from Hyperion `LICENSES/herclic.html` at commit `ee86c4de066fcdb2ec898a157ff4c687c5f01ce2` (tag `Release_4.9.1`). |
| `hercules-COPYRIGHT.txt` | Hercules copyright notice (Hyperion `COPYRIGHT`, same commit). |
| `../web/vendor/tn3270/LICENSE` | athornton/tn3270, MIT. |
| `../web/vendor/tn3270/packages/canvas/assets/LICENSE-3270-font.txt` | x3270 3270 font (BDF), BSD-style. |
| `../web/vendor/coi-serviceworker/LICENSE` | coi-serviceworker, MIT. |

The Hercules extpkg licenses (crypto, decNumber, SoftFloat, telnet) are copied into every bundle
(`licenses/extpkg-*`) by `scripts/mk-dist-dev.sh` from the pinned Hyperion tree.
MVS 3.8J is public domain. The MVS/CE DASD volumes are not in this repository; they are built from the
MVS/CE v3.0.0 release (https://github.com/MVS-sysgen/sysgen).
